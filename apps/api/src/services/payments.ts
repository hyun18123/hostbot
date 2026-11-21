import { createHash } from "node:crypto";
import {
  PAYMENT_REQUEST_STATUS_LABELS,
  PRICE_PER_BOT_KRW,
  depositorNameMatches,
  normalizeDepositorName,
  requestCode,
  type HostedBotRow,
  type ParsedDeposit,
  type PaymentDto,
  type PaymentRequestDto,
} from "@hostbot/shared";
import { config } from "../config.js";
import { AppError, ConflictError, NotFoundError, isUniqueViolation } from "../lib/errors.js";
import { sha256Hex } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";
import { db, unwrap } from "../lib/supabase.js";
import { autoStartAfterPayment, getOwnedBot, mapBot, stopBot } from "./bots.js";
import {
  enqueueAdminAlert,
  enqueueNotification,
} from "./notifications.js";
import { parseBankParserRules, parseDepositNotification, type BankParserRule } from "./payment-parser.js";
import { getBankInfo, getSetting } from "./settings.js";

interface PaymentRequestRow {
  id: string;
  code: string;
  user_id: string;
  bot_id: string;
  amount: number;
  months: number;
  depositor_name: string;
  depositor_name_normalized: string;
  status: PaymentRequestDto["status"];
  note: string | null;
  requested_at: string;
  expires_at: string;
  approved_at: string | null;
  matched_notification_id: number | null;
}

interface BotNameJoin {
  name: string;
}

interface PaymentJoinRow {
  id: string;
  bot_id: string;
  amount: number;
  months: number;
  status: PaymentDto["status"];
  depositor_name: string | null;
  bank_txn_id: string | null;
  approved_at: string | null;
  created_at: string;
  refunded_at?: string | null;
  refund_amount?: number | null;
  refund_reason?: string | null;
  hosted_bots?: BotNameJoin | BotNameJoin[] | null;
  payment_requests?: { code: string } | { code: string }[] | null;
}

function mapPayment(row: PaymentJoinRow): PaymentDto {
  const botEmbed = Array.isArray(row.hosted_bots) ? row.hosted_bots[0] : row.hosted_bots;
  const requestEmbed = Array.isArray(row.payment_requests) ? row.payment_requests[0] : row.payment_requests;
  return {
    id: row.id,
    requestCode: requestEmbed?.code ?? null,
    botId: row.bot_id,
    botName: botEmbed?.name ?? "알 수 없는 봇",
    amount: row.amount,
    months: row.months,
    status: row.status,
    depositorName: row.depositor_name,
    bankTxnId: row.bank_txn_id,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    refundedAt: row.refunded_at ?? null,
    refundAmount: row.refund_amount ?? null,
    refundReason: row.refund_reason ?? null,
  };
}

function mapRequest(row: PaymentRequestRow & { hosted_bots?: BotNameJoin | BotNameJoin[] | null }): PaymentRequestDto {
  const embedded = Array.isArray(row.hosted_bots) ? row.hosted_bots[0] : row.hosted_bots;
  return {
    id: row.id,
    code: row.code,
    botId: row.bot_id,
    botName: embedded?.name ?? "알 수 없는 봇",
    amount: row.amount,
    months: row.months,
    status: row.status,
    statusLabel: PAYMENT_REQUEST_STATUS_LABELS[row.status] ?? row.status,
    depositorName: row.depositor_name,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    note: row.note,
  };
}

async function monthlyPrice(): Promise<number> {
  const { data, error } = await db()
    .from("hosting_plans")
    .select("price_krw")
    .eq("code", "monthly")
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const value = (data as { price_krw: number } | null)?.price_krw;
  return typeof value === "number" && value > 0 ? value : PRICE_PER_BOT_KRW;
}

async function findActiveRequest(botId: string): Promise<PaymentRequestRow | null> {
  const { data, error } = await db()
    .from("payment_requests")
    .select("*")
    .eq("bot_id", botId)
    .in("status", ["awaiting_deposit", "manual_review"])
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PaymentRequestRow | null) ?? null;
}

export interface CreatePaymentRequestInput {
  discordUserId: string;
  botId: string;
  depositorName: string;
  months?: number;
}

export async function createPaymentRequest(input: CreatePaymentRequestInput): Promise<{
  request: PaymentRequestDto;
  bank: Awaited<ReturnType<typeof getBankInfo>>;
}> {
  const bot = await getOwnedBot(input.botId, input.discordUserId);
  if (bot.deleted_at) throw new NotFoundError("삭제된 봇입니다.");
  if (!bot.source_path || !bot.entrypoint) {
    throw new AppError(
      "source_expired",
      "보관 기간이 지나 봇 소스가 삭제되었습니다. 기존 봇을 삭제하고 다시 등록해 주세요.",
      409,
    );
  }
  const months = Math.min(Math.max(input.months ?? 1, 1), 3);
  const active = await findActiveRequest(bot.id);
  if (active) {
    // Refresh the depositor name so a typo can be corrected before deposit.
    if (active.status === "awaiting_deposit") {
      const { error } = await db()
        .from("payment_requests")
        .update({
          depositor_name: input.depositorName,
          depositor_name_normalized: normalizeDepositorName(input.depositorName),
        })
        .eq("id", active.id);
      if (error) throw new Error(error.message);
      active.depositor_name = input.depositorName;
      active.depositor_name_normalized = normalizeDepositorName(input.depositorName);
    }
    return {
      request: mapRequest({ ...active, hosted_bots: { name: bot.name } }),
      bank: await getBankInfo(),
    };
  }

  const price = await monthlyPrice();
  const amount = price * months;
  const cfg = config();
  const requestedAt = new Date();
  const expiresAt = new Date(requestedAt.getTime() + cfg.PAYMENT_REQUEST_DAYS * 86_400_000);

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = requestCode();
    const { data, error } = await db()
      .from("payment_requests")
      .insert({
        code,
        user_id: bot.user_id,
        bot_id: bot.id,
        amount,
        months,
        depositor_name: input.depositorName,
        depositor_name_normalized: normalizeDepositorName(input.depositorName),
        status: "awaiting_deposit",
        requested_at: requestedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
      })
      .select("*")
      .single();
    if (!error && data) {
      return {
        request: mapRequest({ ...(data as PaymentRequestRow), hosted_bots: { name: bot.name } }),
        bank: await getBankInfo(),
      };
    }
    lastError = error;
    if (!isUniqueViolation(error)) break;
    const existing = await findActiveRequest(bot.id);
    if (existing) {
      return { request: mapRequest({ ...existing, hosted_bots: { name: bot.name } }), bank: await getBankInfo() };
    }
  }
  throw new Error(
    `failed to create payment request: ${lastError && typeof lastError === "object" && "message" in lastError ? String(lastError.message) : "unknown"}`,
  );
}

export async function getPaymentStatus(discordUserId: string): Promise<{
  requests: PaymentRequestDto[];
  payments: PaymentDto[];
}> {
  const { data: user, error: userError } = await db()
    .from("users")
    .select("id")
    .eq("discord_id", discordUserId)
    .maybeSingle();
  if (userError) throw new Error(userError.message);
  if (!user) return { requests: [], payments: [] };
  const userId = (user as { id: string }).id;

  const requests = unwrap(
    await db()
      .from("payment_requests")
      .select("*, hosted_bots(name)")
      .eq("user_id", userId)
      .order("requested_at", { ascending: false })
      .limit(20),
  ) as Array<PaymentRequestRow & { hosted_bots?: BotNameJoin | BotNameJoin[] }>;

  const payments = unwrap(
    await db()
      .from("payments")
      .select("*, hosted_bots(name), payment_requests(code)")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20),
  ) as PaymentJoinRow[];

  return {
    requests: requests.map(mapRequest),
    payments: payments.map(mapPayment),
  };
}

export async function listPaymentRequests(options: {
  status?: string;
  limit?: number;
} = {}): Promise<PaymentRequestDto[]> {
  let query = db()
    .from("payment_requests")
    .select("*, hosted_bots(name)")
    .order("requested_at", { ascending: false })
    .limit(Math.min(Math.max(options.limit ?? 50, 1), 200));
  if (options.status) {
    const statuses = options.status
      .split(",")
      .map((status) => status.trim())
      .filter(Boolean);
    query = statuses.length > 1 ? query.in("status", statuses) : query.eq("status", statuses[0]!);
  }
  const rows = unwrap(await query) as Array<PaymentRequestRow & { hosted_bots?: BotNameJoin | BotNameJoin[] }>;
  return rows.map(mapRequest);
}

export async function listPayments(options: { limit?: number; status?: string } = {}): Promise<PaymentDto[]> {
  let query = db()
    .from("payments")
    .select("*, hosted_bots(name), payment_requests(code)")
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(options.limit ?? 50, 1), 200));
  if (options.status) {
    const statuses = options.status
      .split(",")
      .map((status) => status.trim())
      .filter(Boolean);
    query = statuses.length > 1 ? query.in("status", statuses) : query.eq("status", statuses[0]!);
  }
  const rows = unwrap(await query) as PaymentJoinRow[];
  return rows.map(mapPayment);
}

async function findRequestByCodeOrId(codeOrId: string): Promise<PaymentRequestRow> {
  const trimmed = codeOrId.trim();
  const isUuid = /^[0-9a-f-]{36}$/i.test(trimmed);
  const { data, error } = await db()
    .from("payment_requests")
    .select("*")
    .eq(isUuid ? "id" : "code", isUuid ? trimmed : trimmed.toUpperCase())
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFoundError("결제 신청을 찾을 수 없습니다.");
  return data as PaymentRequestRow;
}

export interface ApprovalResult {
  paymentId: string;
  botId: string;
  periodStart: string;
  periodEnd: string;
  months: number;
}

export async function approvePaymentRequest(
  requestCodeOrId: string,
  approvedBy: string,
  notificationId: number | null = null,
): Promise<ApprovalResult> {
  const request = await findRequestByCodeOrId(requestCodeOrId);
  if (!["awaiting_deposit", "manual_review"].includes(request.status)) {
    throw new ConflictError("request_not_pending", "이미 처리되었거나 대기 상태가 아닌 결제 신청입니다.");
  }

  const { data, error } = await db().rpc("approve_payment_request", {
    p_request_id: request.id,
    p_approved_by: approvedBy,
    p_notification_id: notificationId,
  });
  if (error) {
    if (error.message.includes("request_not_pending")) {
      throw new ConflictError("request_not_pending", "이미 처리된 결제 신청입니다.");
    }
    if (error.message.includes("bot_not_found")) {
      throw new NotFoundError("결제 대상 봇을 찾을 수 없습니다.");
    }
    throw new Error(error.message);
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { payment_id: string; bot_id: string; period_start: string; period_end: string; months: number }
    | null;
  if (!row) throw new Error("approval RPC returned no result");

  const { data: bot } = await db()
    .from("hosted_bots")
    .select("*, users(discord_id)")
    .eq("id", row.bot_id)
    .maybeSingle();
  if (bot) {
    const botRow = bot as HostedBotRow & { users?: { discord_id: string } | { discord_id: string }[] };
    const userEmbed = Array.isArray(botRow.users) ? botRow.users[0] : botRow.users;
    if (userEmbed?.discord_id) {
      await enqueueNotification({
        channel: "dm",
        discordId: userEmbed.discord_id,
        type: "payment_approved",
        payload: {
          botId: row.bot_id,
          botName: botRow.name,
          amount: request.amount,
          months: row.months,
          periodEnd: row.period_end,
        },
      });
    }
    await enqueueAdminAlert("payment_approved", {
      requestCode: request.code,
      botName: botRow.name,
      amount: request.amount,
      approvedBy,
      auto: notificationId !== null,
      periodEnd: row.period_end,
    });
    void autoStartAfterPayment(row.bot_id);
  }

  return {
    paymentId: row.payment_id,
    botId: row.bot_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    months: row.months,
  };
}

export async function rejectPaymentRequest(
  requestCodeOrId: string,
  rejectedBy: string,
  reason: string,
): Promise<void> {
  const request = await findRequestByCodeOrId(requestCodeOrId);
  const { error } = await db().rpc("reject_payment_request", {
    p_request_id: request.id,
    p_rejected_by: rejectedBy,
    p_reason: reason.slice(0, 500),
  });
  if (error) {
    if (error.message.includes("request_not_pending")) {
      throw new ConflictError("request_not_pending", "이미 처리된 결제 신청입니다.");
    }
    throw new Error(error.message);
  }

  const { data: bot } = await db()
    .from("hosted_bots")
    .select("*, users(discord_id)")
    .eq("id", request.bot_id)
    .maybeSingle();
  if (bot) {
    const botRow = bot as HostedBotRow & { users?: { discord_id: string } | { discord_id: string }[] };
    const userEmbed = Array.isArray(botRow.users) ? botRow.users[0] : botRow.users;
    if (userEmbed?.discord_id) {
      await enqueueNotification({
        channel: "dm",
        discordId: userEmbed.discord_id,
        type: "payment_rejected",
        payload: { botId: request.bot_id, botName: botRow.name, requestCode: request.code, reason },
      });
    }
    await enqueueAdminAlert("payment_rejected", {
      requestCode: request.code,
      botName: botRow.name,
      rejectedBy,
      reason,
    });
  }
}

export interface RefundResult {
  paymentId: string;
  botId: string;
  amount: number;
  expiresAt: string;
  botStatus: string;
}

/**
 * Full refund only (the product has no partial refunds). Revokes the period the
 * payment granted and stops the bot when that leaves it expired.
 */
export async function refundPayment(
  paymentId: string,
  refundedBy: string,
  reason: string,
): Promise<RefundResult> {
  if (!/^[0-9a-f-]{36}$/i.test(paymentId)) throw new NotFoundError("결제 내역을 찾을 수 없습니다.");
  const trimmedReason = reason.trim().slice(0, 500);
  if (!trimmedReason) throw new AppError("validation_error", "환불 사유를 입력해 주세요.");

  const { data: payment, error: paymentError } = await db()
    .from("payments")
    .select("id, amount, bot_id, status")
    .eq("id", paymentId)
    .maybeSingle();
  if (paymentError) throw new Error(paymentError.message);
  if (!payment) throw new NotFoundError("결제 내역을 찾을 수 없습니다.");
  const row = payment as { id: string; amount: number; bot_id: string; status: string };
  if (row.status !== "approved") {
    throw new ConflictError("payment_not_refundable", "승인된 결제만 환불할 수 있습니다.");
  }

  const { data, error } = await db().rpc("refund_payment", {
    p_payment_id: paymentId,
    p_refunded_by: refundedBy,
    p_reason: trimmedReason,
  });
  if (error) {
    if (error.message.includes("payment_not_found")) throw new NotFoundError("결제 내역을 찾을 수 없습니다.");
    if (error.message.includes("payment_not_refundable")) {
      throw new ConflictError("payment_not_refundable", "승인된 결제만 환불할 수 있습니다.");
    }
    throw new Error(error.message);
  }

  const result = (Array.isArray(data) ? data[0] : data) as
    | { bot_id: string; expires_at: string; bot_status: string; changed: boolean }
    | null;
  if (!result) throw new Error("refund RPC returned no result");

  if (result.bot_status === "expired") {
    await stopBot(result.bot_id, null, {
      status: "expired",
      reason: "환불로 이용 기간이 종료되었습니다.",
    }).catch((error) => logger.warn({ err: error, botId: result.bot_id }, "failed to stop refunded bot"));
  }

  const { data: bot } = await db()
    .from("hosted_bots")
    .select("*, users(discord_id)")
    .eq("id", result.bot_id)
    .maybeSingle();
  if (bot) {
    const botRow = bot as HostedBotRow & { users?: { discord_id: string } | { discord_id: string }[] };
    const userEmbed = Array.isArray(botRow.users) ? botRow.users[0] : botRow.users;
    if (userEmbed?.discord_id) {
      await enqueueNotification({
        channel: "dm",
        discordId: userEmbed.discord_id,
        type: "payment_refunded",
        payload: {
          botId: result.bot_id,
          botName: botRow.name,
          amount: row.amount,
          reason: trimmedReason,
          expiresAt: result.expires_at,
        },
      });
    }
    await enqueueAdminAlert("payment_refunded", {
      botName: botRow.name,
      amount: row.amount,
      refundedBy,
      reason: trimmedReason,
      expiresAt: result.expires_at,
    });
  }

  return {
    paymentId,
    botId: result.bot_id,
    amount: row.amount,
    expiresAt: result.expires_at,
    botStatus: result.bot_status,
  };
}

export async function expirePaymentRequests(): Promise<void> {
  const { error } = await db()
    .from("payment_requests")
    .update({ status: "expired", note: "입금 기한이 지나 자동 만료되었습니다." })
    .in("status", ["awaiting_deposit", "manual_review"])
    .lt("expires_at", new Date().toISOString());
  if (error) logger.warn({ err: error }, "failed to expire payment requests");
}
export interface DepositNotificationInput {
  source: string;
  eventId?: string;
  appName?: string;
  title?: string;
  body: string;
  receivedAt?: Date;
  raw?: Record<string, unknown>;
}

export type DepositProcessResult =
  | { outcome: "ignored"; notificationId: number; reason: string }
  | { outcome: "duplicate"; notificationId: number | null; reason: string }
  | { outcome: "matched"; notificationId: number; requestCode: string; paymentId: string }
  | { outcome: "manual_review"; notificationId: number; reason: string }
  | { outcome: "unmatched"; notificationId: number; reason: string };

function dedupeKey(input: DepositNotificationInput, parsed: ParsedDeposit): string {
  if (parsed.txnId) {
    return `txn:${sha256Hex(`${parsed.bankName ?? ""}|${parsed.txnId}`)}`;
  }
  if (input.eventId) {
    return `event:${sha256Hex(`${input.source}|${input.eventId}`)}`;
  }
  const bucket = Math.floor((input.receivedAt ?? new Date()).getTime() / (10 * 60_000));
  return `soft:${sha256Hex(
    `${input.source}|${parsed.amount ?? "x"}|${normalizeDepositorName(parsed.depositorName)}|${bucket}`,
  )}`;
}

function detectKind(input: DepositNotificationInput): "bank_app" | "sms" | "unknown" {
  const text = `${input.appName ?? ""} ${input.title ?? ""}`.toLowerCase();
  if (/sms|mms|메시지|문자|message/.test(text)) return "sms";
  if (input.source === "pushbullet") return "bank_app";
  return "unknown";
}

async function findRecentDuplicate(
  notificationId: number,
  parsed: ParsedDeposit,
  receivedAt: Date,
): Promise<boolean> {
  if (!parsed.amount || !parsed.depositorName) return false;
  const cfg = config();
  const since = new Date(receivedAt.getTime() - cfg.PAYMENT_DEDUPE_WINDOW_MINUTES * 60_000).toISOString();
  const { data, error } = await db()
    .from("payment_notifications")
    .select("id, parsed_amount, parsed_depositor_name, status")
    .gte("received_at", since)
    .neq("id", notificationId)
    .in("status", ["matched", "manual_review", "ambiguous", "duplicate"])
    .limit(25);
  if (error) {
    logger.warn({ err: error }, "recent duplicate lookup failed");
    return false;
  }
  const target = normalizeDepositorName(parsed.depositorName);
  return (data as Array<{ parsed_amount: number | null; parsed_depositor_name: string | null }>).some(
    (row) =>
      row.parsed_amount === parsed.amount &&
      normalizeDepositorName(row.parsed_depositor_name) === target,
  );
}

async function loadParserRules(): Promise<BankParserRule[]> {
  const raw = await getSetting<unknown>("bank_parsers", []);
  return parseBankParserRules(raw);
}

async function markManualReviewRequests(
  requests: PaymentRequestRow[],
  note: string,
): Promise<void> {
  if (requests.length === 0) return;
  const { error } = await db()
    .from("payment_requests")
    .update({ status: "manual_review", note: note.slice(0, 500) })
    .in("id", requests.map((request) => request.id))
    .eq("status", "awaiting_deposit");
  if (error) logger.warn({ err: error }, "failed to mark payment requests manual_review");
}

/**
 * Entry point for Pushbullet mirror pushes and generic Android webhooks.
 * The match is intentionally conservative: exact amount, exact depositor name,
 * exactly one open request. Everything else goes to an operator.
 */
export async function processDepositNotification(input: DepositNotificationInput): Promise<DepositProcessResult> {
  const receivedAt = input.receivedAt ?? new Date();
  const rules = await loadParserRules();
  const parsed = parseDepositNotification(
    { title: input.title, body: input.body, appName: input.appName, source: input.source, receivedAt },
    rules,
  );

  const key = dedupeKey(input, parsed);
  const { data: inserted, error: insertError } = await db()
    .from("payment_notifications")
    .insert({
      source: input.source.slice(0, 40),
      event_id: input.eventId?.slice(0, 200) ?? null,
      dedupe_key: key,
      kind: detectKind(input),
      app_name: input.appName?.slice(0, 80) ?? null,
      title: input.title?.slice(0, 300) ?? null,
      body: input.body.slice(0, 5000),
      raw: input.raw ?? {},
      received_at: receivedAt.toISOString(),
      parsed_amount: parsed.amount,
      parsed_depositor_name: parsed.depositorName,
      parsed_bank_name: parsed.bankName,
      parsed_txn_id: parsed.txnId,
      parse_confidence: parsed.confidence,
      status: parsed.isDeposit ? "received" : "ignored",
      note: parsed.reason,
    })
    .select("id")
    .single();

  if (insertError) {
    if (isUniqueViolation(insertError)) {
      return { outcome: "duplicate", notificationId: null, reason: "duplicate_event" };
    }
    throw new Error(insertError.message);
  }
  const notificationId = (inserted as { id: number }).id;

  if (!parsed.isDeposit) {
    return { outcome: "ignored", notificationId, reason: parsed.reason };
  }

  if (parsed.amount === null || !parsed.depositorName) {
    await markNotification(notificationId, "manual_review", "금액 또는 입금자명을 확실하게 추출하지 못했습니다.");
    await enqueueAdminAlert("payment_manual_review", {
      notificationId,
      reason: "금액 또는 입금자명을 확실하게 추출하지 못했습니다.",
      parsed,
      rawText: parsed.rawText.slice(0, 1500),
    });
    return { outcome: "manual_review", notificationId, reason: "unparseable" };
  }

  if (await findRecentDuplicate(notificationId, parsed, receivedAt)) {
    await markNotification(notificationId, "duplicate", "중복으로 수신된 입금 알림으로 판단했습니다.");
    return { outcome: "duplicate", notificationId, reason: "recent_duplicate" };
  }

  const { data: candidatesData, error: candidateError } = await db()
    .from("payment_requests")
    .select("*")
    .eq("status", "awaiting_deposit")
    .eq("amount", parsed.amount)
    .gt("expires_at", new Date().toISOString())
    .order("requested_at", { ascending: true })
    .limit(50);
  if (candidateError) throw new Error(candidateError.message);
  const amountCandidates = candidatesData as PaymentRequestRow[];

  const exactMatches: PaymentRequestRow[] = [];
  const maskedMatches: PaymentRequestRow[] = [];
  for (const request of amountCandidates) {
    const match = depositorNameMatches(request.depositor_name, parsed.depositorName);
    if (match === "exact") exactMatches.push(request);
    else if (match === "masked") maskedMatches.push(request);
  }

  const needsManual =
    parsed.confidence === "low" ||
    parsed.depositorMasked ||
    exactMatches.length > 1 ||
    maskedMatches.length > 0 ||
    (exactMatches.length === 0 && amountCandidates.length > 0);

  if (needsManual) {
    const candidatesForNote = [...exactMatches, ...maskedMatches, ...amountCandidates];
    const uniqueCandidates = [...new Map(candidatesForNote.map((request) => [request.id, request])).values()];
    const reason =
      parsed.confidence === "low"
        ? "입금 알림의 신뢰도가 낮아 자동 승인하지 않았습니다."
        : parsed.depositorMasked
          ? "입금자명이 마스킹되어 있어 자동 승인하지 않았습니다."
          : exactMatches.length > 1
            ? "동일 금액의 결제 신청이 여러 건 있어 자동 승인하지 않았습니다."
            : amountCandidates.length > 0
              ? "입금자명이 일치하는 결제 신청을 찾지 못했습니다."
              : "해당 금액의 결제 신청을 찾지 못했습니다.";
    await markNotification(notificationId, "manual_review", reason);
    // Only requests that already look like a plausible match are frozen into
    // manual review. A mismatched-name deposit must not block unrelated open
    // requests that happen to have the same amount.
    const frozen = [...exactMatches, ...maskedMatches];
    if (frozen.length > 0) {
      await markManualReviewRequests(frozen, `입금 알림 #${notificationId}: ${reason}`);
    }
    await enqueueAdminAlert("payment_manual_review", {
      notificationId,
      reason,
      amount: parsed.amount,
      depositorName: parsed.depositorName,
      bankName: parsed.bankName,
      txnId: parsed.txnId,
      confidence: parsed.confidence,
      candidates: uniqueCandidates.map((request) => ({
        requestId: request.id,
        code: request.code,
        registeredDepositor: request.depositor_name,
      })),
      rawText: parsed.rawText.slice(0, 1500),
    });
    return { outcome: "manual_review", notificationId, reason };
  }

  if (exactMatches.length === 0) {
    await markNotification(notificationId, "unmatched", "결제 대기 중인 신청과 일치하지 않습니다.");
    await enqueueAdminAlert("payment_unmatched", {
      notificationId,
      amount: parsed.amount,
      depositorName: parsed.depositorName,
      bankName: parsed.bankName,
      txnId: parsed.txnId,
      rawText: parsed.rawText.slice(0, 1500),
    });
    return { outcome: "unmatched", notificationId, reason: "no_open_request" };
  }

  const request = exactMatches[0]!;
  const approval = await approvePaymentRequest(request.code, `auto:notification#${notificationId}`, notificationId);
  await markNotification(
    notificationId,
    "matched",
    `결제 신청 ${request.code} 자동 승인`,
    request.id,
    approval.paymentId,
  );
  return { outcome: "matched", notificationId, requestCode: request.code, paymentId: approval.paymentId };
}

async function markNotification(
  id: number,
  status: "ignored" | "unmatched" | "duplicate" | "ambiguous" | "matched" | "manual_review" | "error",
  note: string,
  requestId: string | null = null,
  paymentId: string | null = null,
): Promise<void> {
  const { error } = await db()
    .from("payment_notifications")
    .update({
      status,
      note: note.slice(0, 500),
      matched_request_id: requestId,
      matched_payment_id: paymentId,
    })
    .eq("id", id);
  if (error) logger.warn({ err: error, id }, "failed to update payment notification");
}

export async function getBotPaymentState(bot: HostedBotRow): Promise<{
  bot: ReturnType<typeof mapBot>;
  request: PaymentRequestDto | null;
}> {
  const request = await findActiveRequest(bot.id);
  return { bot: mapBot(bot), request: request ? mapRequest(request) : null };
}

export function hashNotificationBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}
