import type { BotStatus, PaymentRequestStatus, PaymentStatus } from "./constants.js";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface UserRow {
  id: string;
  discord_id: string;
  username: string;
  is_admin: boolean;
  created_at: string;
  updated_at: string;
}

export interface HostedBotRow {
  id: string;
  user_id: string;
  name: string;
  slug: string | null;
  status: BotStatus;
  plan_id: string | null;
  expires_at: string | null;
  source_path: string | null;
  source_sha256: string | null;
  source_size: number | null;
  entrypoint: string | null;
  discord_bot_id: string | null;
  discord_bot_username: string | null;
  container_id: string | null;
  container_name: string | null;
  last_started_at: string | null;
  last_stopped_at: string | null;
  last_error: string | null;
  restart_count: number;
  expiry_notice_days: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Public bot shape returned to the management bot; never contains the token. */
export interface BotDto {
  id: string;
  name: string;
  status: BotStatus;
  statusLabel: string;
  expiresAt: string | null;
  daysRemaining: number | null;
  entrypoint: string | null;
  lastError: string | null;
  createdAt: string;
  paymentDue: boolean;
  discordBotId: string | null;
  discordBotUsername: string | null;
}

export interface PaymentRequestDto {
  id: string;
  code: string;
  botId: string;
  botName: string;
  amount: number;
  months: number;
  status: PaymentRequestStatus;
  statusLabel: string;
  depositorName: string;
  requestedAt: string;
  expiresAt: string;
  note: string | null;
}

export interface PaymentDto {
  id: string;
  requestCode: string | null;
  botId: string;
  botName: string;
  amount: number;
  months: number;
  status: PaymentStatus;
  depositorName: string | null;
  bankTxnId: string | null;
  approvedAt: string | null;
  createdAt: string;
  refundedAt: string | null;
  refundAmount: number | null;
  refundReason: string | null;
}

export interface NotificationDto {
  id: number;
  channel: "dm" | "admin";
  discordId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RegistrationResult {
  bot: BotDto;
  paymentRequest: PaymentRequestDto;
  bank: {
    bankName: string;
    accountNumber: string;
    accountHolder: string;
    amount: number;
    depositorName: string;
    requestCode: string;
    expiresAt: string;
  };
}

export interface StatsResult {
  users: number;
  bots: {
    total: number;
    running: number;
    stopped: number;
    expired: number;
    error: number;
    awaitingPayment: number;
  };
  revenue: {
    thisMonthKrw: number;
    last30DaysKrw: number;
    totalKrw: number;
  };
  pending: {
    paymentRequests: number;
    manualReview: number;
  };
}

export interface ParsedDeposit {
  isDeposit: boolean;
  amount: number | null;
  depositorName: string | null;
  depositorMasked: boolean;
  bankName: string | null;
  txnId: string | null;
  confidence: "high" | "medium" | "low";
  reason: string;
  rawText: string;
}
