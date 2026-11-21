-- Discord Bot Hosting - initial schema
-- Run in Supabase SQL editor, or with `supabase db push`.
--
-- Security model:
--   * The API server uses the service_role key. service_role bypasses RLS.
--   * RLS is enabled with no policies, and anon/authenticated grants are revoked.
--   * Bot tokens are stored only in bot_secrets.token_encrypted (AES-256-GCM).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Utility trigger
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  discord_id text not null unique,
  username text not null,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger users_set_updated_at
before update on public.users
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- hosting_plans
-- ---------------------------------------------------------------------------
create table if not exists public.hosting_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  price_krw integer not null check (price_krw >= 0),
  duration_days integer not null check (duration_days > 0),
  max_bots integer,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.hosting_plans (code, name, price_krw, duration_days, max_bots, is_active)
values ('monthly', '월간 호스팅 (봇 1개)', 3900, 30, null, true)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- hosted_bots
-- ---------------------------------------------------------------------------
create table if not exists public.hosted_bots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  slug text,
  status text not null default 'awaiting_payment'
    check (status in ('awaiting_payment','installing','starting','running','stopped','expired','error','deleting','deleted')),
  plan_id uuid references public.hosting_plans(id),
  expires_at timestamptz,
  source_path text,
  source_sha256 text,
  source_size bigint,
  entrypoint text,
  discord_bot_id text,
  discord_bot_username text,
  container_id text,
  container_name text,
  last_started_at timestamptz,
  last_stopped_at timestamptz,
  last_error text,
  restart_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists hosted_bots_user_id_idx on public.hosted_bots(user_id);
create index if not exists hosted_bots_status_idx on public.hosted_bots(status);
create index if not exists hosted_bots_expires_at_idx on public.hosted_bots(expires_at)
  where deleted_at is null;

create trigger hosted_bots_set_updated_at
before update on public.hosted_bots
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- bot_secrets (tokens only; never selected by list endpoints)
-- ---------------------------------------------------------------------------
create table if not exists public.bot_secrets (
  bot_id uuid primary key references public.hosted_bots(id) on delete cascade,
  token_encrypted text not null,
  -- sha256 of the token: prevents the same bot token from being registered twice
  -- without ever storing the plaintext.
  token_fingerprint text not null unique,
  key_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger bot_secrets_set_updated_at
before update on public.bot_secrets
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- payment_requests
-- ---------------------------------------------------------------------------
create table if not exists public.payment_requests (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  user_id uuid not null references public.users(id) on delete cascade,
  bot_id uuid not null references public.hosted_bots(id) on delete cascade,
  amount integer not null check (amount > 0),
  months integer not null default 1 check (months between 1 and 12),
  depositor_name text not null,
  depositor_name_normalized text not null,
  status text not null default 'awaiting_deposit'
    check (status in ('awaiting_deposit','manual_review','approved','rejected','expired','cancelled')),
  note text,
  matched_notification_id bigint,
  approved_payment_id uuid,
  approved_at timestamptz,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payment_requests_bot_id_idx on public.payment_requests(bot_id);
create index if not exists payment_requests_status_idx on public.payment_requests(status);
create index if not exists payment_requests_match_idx
  on public.payment_requests(status, amount, depositor_name_normalized);
-- At most one open deposit request per bot at a time.
create unique index if not exists payment_requests_one_open_per_bot
  on public.payment_requests(bot_id)
  where status in ('awaiting_deposit','manual_review');

create trigger payment_requests_set_updated_at
before update on public.payment_requests
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- payment_notifications (raw Pushbullet / webhook events)
-- ---------------------------------------------------------------------------
create table if not exists public.payment_notifications (
  id bigint generated by default as identity primary key,
  source text not null,
  event_id text,
  dedupe_key text not null unique,
  kind text not null default 'unknown'
    check (kind in ('bank_app','sms','unknown')),
  app_name text,
  title text,
  body text not null,
  raw jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  parsed_amount integer,
  parsed_depositor_name text,
  parsed_bank_name text,
  parsed_txn_id text,
  parse_confidence text check (parse_confidence in ('high','medium','low')),
  status text not null default 'received'
    check (status in ('received','ignored','unmatched','duplicate','ambiguous','matched','manual_review','error')),
  note text,
  matched_request_id uuid references public.payment_requests(id) on delete set null,
  matched_payment_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payment_notifications_status_idx on public.payment_notifications(status);
create index if not exists payment_notifications_received_idx on public.payment_notifications(received_at desc);
create index if not exists payment_notifications_match_idx
  on public.payment_notifications(parsed_amount, parsed_depositor_name, received_at desc);

create trigger payment_notifications_set_updated_at
before update on public.payment_notifications
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  payment_request_id uuid unique references public.payment_requests(id) on delete set null,
  user_id uuid not null references public.users(id) on delete cascade,
  bot_id uuid not null references public.hosted_bots(id) on delete cascade,
  amount integer not null check (amount > 0),
  months integer not null check (months between 1 and 12),
  status text not null default 'approved'
    check (status in ('approved','rejected','refunded')),
  depositor_name text,
  bank_txn_id text,
  notification_id bigint references public.payment_notifications(id) on delete set null,
  approved_by text,
  approved_at timestamptz,
  period_start timestamptz,
  period_end timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists payments_bot_id_idx on public.payments(bot_id);
create index if not exists payments_created_idx on public.payments(created_at desc);
create index if not exists payments_approved_idx on public.payments(approved_at desc)
  where status = 'approved';

-- ---------------------------------------------------------------------------
-- hosting_logs
-- ---------------------------------------------------------------------------
create table if not exists public.hosting_logs (
  id bigint generated by default as identity primary key,
  bot_id uuid not null references public.hosted_bots(id) on delete cascade,
  level text not null default 'info' check (level in ('debug','info','warn','error')),
  event text not null,
  message text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists hosting_logs_bot_idx on public.hosting_logs(bot_id, created_at desc);

-- ---------------------------------------------------------------------------
-- admin_settings
-- ---------------------------------------------------------------------------
create table if not exists public.admin_settings (
  key text primary key,
  value jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);

insert into public.admin_settings (key, value) values
  ('bank_account', '{"bankName":"국민은행","accountNumber":"000000-00-000000","accountHolder":"예금주"}'::jsonb),
  ('payment_instructions', '"입금자명을 결제 신청 시 입력한 이름과 동일하게 입력해 주세요."'::jsonb),
  ('max_bots_per_user', '5'::jsonb),
  ('registration_enabled', 'true'::jsonb),
  ('maintenance_message', '""'::jsonb),
  ('bank_parsers', '[]'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- notifications (outbox consumed by the management bot)
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id bigint generated by default as identity primary key,
  channel text not null check (channel in ('dm','admin')),
  discord_id text,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists notifications_pending_idx on public.notifications(status, id)
  where status = 'pending';
create index if not exists notifications_created_idx on public.notifications(created_at desc);

-- ---------------------------------------------------------------------------
-- audit_logs (operator actions)
-- ---------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id bigint generated by default as identity primary key,
  actor text not null,
  action text not null,
  target_type text,
  target_id text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_logs_created_idx on public.audit_logs(created_at desc);

-- ---------------------------------------------------------------------------
-- RLS lockdown
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  for t in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end;
$$;

alter default privileges in schema public revoke all on tables from anon, authenticated;

-- The API connects with service_role. RLS bypass does not grant table
-- privileges, so make the grant explicit.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------------
-- approve_payment_request
-- Atomically: approve request, extend bot expiry, insert payment, mark notification.
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
-- reject_payment_request
-- ---------------------------------------------------------------------------
create or replace function public.reject_payment_request(
  p_request_id uuid,
  p_rejected_by text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.payment_requests%rowtype;
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

  update public.payment_requests
  set status = 'rejected', note = p_reason, updated_at = now()
  where id = p_request_id;

  insert into public.audit_logs (actor, action, target_type, target_id, meta)
  values (p_rejected_by, 'payment.reject', 'payment_request', p_request_id::text,
          jsonb_build_object('reason', p_reason));
end;
$$;

revoke all on function public.reject_payment_request(uuid, text, text) from public, anon, authenticated;
grant execute on function public.reject_payment_request(uuid, text, text) to service_role;
