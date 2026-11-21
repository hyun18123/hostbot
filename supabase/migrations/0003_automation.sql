-- ---------------------------------------------------------------------------
-- 0003_automation.sql
-- 운영 자동화: 만료 임박 알림, 환불 처리
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- hosted_bots: remember which expiry reminder stage was already sent.
--   3 = D-3, 1 = D-1, 0 = D-day, null = none sent for the current period.
-- ---------------------------------------------------------------------------
alter table public.hosted_bots
  add column if not exists expiry_notice_days integer;

comment on column public.hosted_bots.expiry_notice_days is
  'Last expiry reminder threshold (in days) sent to the customer. Reset when the period is extended.';

create index if not exists hosted_bots_expiry_notice_idx
  on public.hosted_bots(expires_at)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- payments: refund bookkeeping
-- ---------------------------------------------------------------------------
alter table public.payments
  add column if not exists refunded_at timestamptz,
  add column if not exists refunded_by text,
  add column if not exists refund_reason text,
  add column if not exists refund_amount integer;

create index if not exists payments_refunded_idx
  on public.payments(refunded_at desc)
  where status = 'refunded';

-- ---------------------------------------------------------------------------
-- approve_payment_request
-- Same as 0001 but clears the expiry reminder stage because the period moved.
-- ---------------------------------------------------------------------------
create or replace function public.approve_payment_request(
  p_request_id uuid,
  p_approved_by text,
  p_notification_id bigint default null
)
returns table (
  payment_id uuid,
  bot_id uuid,
  period_start timestamptz,
  period_end timestamptz,
  months integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.payment_requests%rowtype;
  v_bot public.hosted_bots%rowtype;
  v_start timestamptz;
  v_end timestamptz;
  v_payment_id uuid;
begin
  select * into v_req
  from public.payment_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'request_not_found' using errcode = 'P0001';
  end if;

  if v_req.status not in ('awaiting_deposit','manual_review') then
    raise exception 'request_not_pending' using errcode = 'P0001';
  end if;

  select * into v_bot
  from public.hosted_bots
  where id = v_req.bot_id
  for update;

  if not found or v_bot.deleted_at is not null then
    raise exception 'bot_not_found' using errcode = 'P0001';
  end if;

  v_start := greatest(now(), coalesce(v_bot.expires_at, now()));
  v_end := v_start + make_interval(days => 30 * v_req.months);

  update public.hosted_bots
  set expires_at = v_end,
      expiry_notice_days = null,
      status = case
        when status in ('expired','stopped','error','awaiting_payment') then 'stopped'
        else status
      end,
      updated_at = now()
  where id = v_bot.id;

  update public.payment_requests
  set status = 'approved',
      approved_at = now(),
      matched_notification_id = coalesce(p_notification_id, matched_notification_id),
      updated_at = now()
  where id = v_req.id;

  insert into public.payments (
    payment_request_id, user_id, bot_id, amount, months, status,
    depositor_name, bank_txn_id, notification_id, approved_by, approved_at,
    period_start, period_end
  )
  select
    v_req.id, v_req.user_id, v_req.bot_id, v_req.amount, v_req.months, 'approved',
    v_req.depositor_name,
    (select pn.parsed_txn_id from public.payment_notifications pn where pn.id = p_notification_id),
    p_notification_id, p_approved_by, now(),
    v_start, v_end
  returning id into v_payment_id;

  update public.payment_requests
  set approved_payment_id = v_payment_id
  where id = v_req.id;

  if p_notification_id is not null then
    update public.payment_notifications
    set status = 'matched',
        matched_request_id = v_req.id,
        matched_payment_id = v_payment_id,
        updated_at = now()
    where id = p_notification_id;
  end if;

  insert into public.audit_logs (actor, action, target_type, target_id, meta)
  values (
    p_approved_by, 'payment.approve', 'payment_request', v_req.id::text,
    jsonb_build_object('payment_id', v_payment_id, 'bot_id', v_req.bot_id, 'months', v_req.months)
  );

  return query select v_payment_id, v_req.bot_id, v_start, v_end, v_req.months;
end;
$$;

revoke all on function public.approve_payment_request(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.approve_payment_request(uuid, text, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- refund_payment
-- Atomically: mark the payment refunded and revoke the granted period.
-- The API stops the container afterwards when the bot has effectively expired.
-- ---------------------------------------------------------------------------
create or replace function public.refund_payment(
  p_payment_id uuid,
  p_refunded_by text,
  p_reason text
)
returns table (
  bot_id uuid,
  expires_at timestamptz,
  bot_status text,
  changed boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay public.payments%rowtype;
  v_bot public.hosted_bots%rowtype;
  v_days integer;
  v_new_expiry timestamptz;
  v_status text;
begin
  select * into v_pay
  from public.payments
  where id = p_payment_id
  for update;

  if not found then
    raise exception 'payment_not_found' using errcode = 'P0001';
  end if;

  if v_pay.status <> 'approved' then
    raise exception 'payment_not_refundable' using errcode = 'P0001';
  end if;

  select * into v_bot
  from public.hosted_bots
  where id = v_pay.bot_id
  for update;

  if not found then
    raise exception 'bot_not_found' using errcode = 'P0001';
  end if;

  v_days := greatest(1, v_pay.months) * 30;
  v_new_expiry := coalesce(v_bot.expires_at, now()) - make_interval(days => v_days);
  v_status := v_bot.status;

  if v_new_expiry <= now() then
    v_new_expiry := now();
    if v_bot.status in ('running','starting','installing','stopped','error') then
      v_status := 'expired';
    end if;
  end if;

  update public.payments
  set status = 'refunded',
      refunded_at = now(),
      refunded_by = p_refunded_by,
      refund_reason = left(coalesce(p_reason, ''), 500),
      refund_amount = v_pay.amount
  where id = v_pay.id;

  update public.hosted_bots
  set expires_at = v_new_expiry,
      expiry_notice_days = null,
      status = v_status,
      updated_at = now()
  where id = v_bot.id;

  insert into public.audit_logs (actor, action, target_type, target_id, meta)
  values (
    p_refunded_by, 'payment.refund', 'payment', v_pay.id::text,
    jsonb_build_object(
      'bot_id', v_pay.bot_id,
      'amount', v_pay.amount,
      'months', v_pay.months,
      'reason', left(coalesce(p_reason, ''), 500),
      'new_expires_at', v_new_expiry
    )
  );

  return query select v_pay.bot_id, v_new_expiry, v_status, true;
end;
$$;

revoke all on function public.refund_payment(uuid, text, text) from public, anon, authenticated;
grant execute on function public.refund_payment(uuid, text, text) to service_role;
