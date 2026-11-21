export interface BotRow {
  id: string;
  name: string;
  status: string;
  statusLabel: string;
  expiresAt: string | null;
  daysRemaining: number | null;
  entrypoint?: string | null;
  lastError: string | null;
  createdAt?: string;
  paymentDue?: boolean;
  discordBotId?: string | null;
  discordBotUsername: string | null;
}

export interface BotEventRow {
  id: number;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  message: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

export interface PaymentRequestRow {
  id: string;
  code: string;
  botId: string;
  botName: string;
  amount: number;
  months: number;
  status: string;
  statusLabel: string;
  depositorName: string;
  requestedAt: string;
  expiresAt: string;
  note: string | null;
}

export interface PaymentRow {
  id: string;
  requestCode: string | null;
  botId: string;
  botName: string;
  amount: number;
  months: number;
  status: string;
  depositorName: string | null;
  approvedAt: string | null;
  createdAt: string;
  refundedAt: string | null;
  refundAmount: number | null;
  refundReason: string | null;
}

export interface Stats {
  users: number;
  bots: {
    total: number;
    running: number;
    stopped: number;
    expired: number;
    error: number;
    awaitingPayment: number;
  };
  revenue: { thisMonthKrw: number; last30DaysKrw: number; totalKrw: number };
  pending: { paymentRequests: number; manualReview: number };
}

function baseUrl(): string {
  return (process.env.API_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");
}

function headers(): Record<string, string> {
  const key = process.env.ADMIN_API_KEY;
  if (!key) throw new Error("ADMIN_API_KEY is not configured");
  return { "x-admin-api-key": key, accept: "application/json" };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      ...init,
      headers: {
        ...headers(),
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApiError("호스팅 API에 연결할 수 없습니다.", "network_error", 503);
  }
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }
  if (!response.ok) {
    const body = data as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      body?.error?.message ?? `API 오류 (HTTP ${response.status})`,
      body?.error?.code ?? "api_error",
      response.status,
    );
  }
  return data as T;
}

export function getStats(): Promise<Stats> {
  return request("/internal/admin/stats");
}

export async function getBots(): Promise<BotRow[]> {
  const data = await request<{ bots: BotRow[] }>("/internal/admin/bots?limit=200");
  return data.bots;
}

export async function getPaymentRequests(status = "awaiting_deposit,manual_review"): Promise<PaymentRequestRow[]> {
  const data = await request<{ requests: PaymentRequestRow[] }>(
    `/internal/admin/payment-requests?status=${encodeURIComponent(status)}&limit=100`,
  );
  return data.requests;
}

export async function getPayments(status?: string): Promise<PaymentRow[]> {
  const query = status ? `?status=${encodeURIComponent(status)}&limit=100` : "?limit=100";
  const data = await request<{ payments: PaymentRow[] }>(`/internal/admin/payments${query}`);
  return data.payments;
}

export async function getBot(id: string): Promise<BotRow> {
  const data = await request<{ bot: BotRow }>(`/internal/admin/bots/${encodeURIComponent(id)}`);
  return data.bot;
}

export async function getBotLogs(id: string, lines = 200): Promise<string> {
  const data = await request<{ logs: string }>(
    `/internal/admin/bots/${encodeURIComponent(id)}/logs?lines=${Math.min(Math.max(lines, 10), 500)}`,
  );
  return data.logs;
}

export async function getBotEvents(id: string, limit = 50): Promise<BotEventRow[]> {
  const data = await request<{ events: BotEventRow[] }>(
    `/internal/admin/bots/${encodeURIComponent(id)}/events?limit=${limit}`,
  );
  return data.events;
}

export function approveRequest(id: string): Promise<unknown> {
  return request(`/internal/admin/payment-requests/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    body: JSON.stringify({ admin: "dashboard" }),
  });
}

export function rejectRequest(id: string, reason: string): Promise<unknown> {
  return request(`/internal/admin/payment-requests/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    body: JSON.stringify({ admin: "dashboard", reason }),
  });
}

export function stopBot(id: string): Promise<unknown> {
  return request(`/internal/admin/bots/${encodeURIComponent(id)}/stop`, {
    method: "POST",
    body: JSON.stringify({ admin: "dashboard" }),
  });
}

export function restartBot(id: string): Promise<unknown> {
  return request(`/internal/admin/bots/${encodeURIComponent(id)}/restart`, {
    method: "POST",
    body: JSON.stringify({ admin: "dashboard" }),
  });
}

export function deleteBot(id: string): Promise<unknown> {
  return request(`/internal/admin/bots/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({ admin: "dashboard" }),
  });
}

export async function getSettings(): Promise<Record<string, unknown>> {
  const data = await request<{ settings: Record<string, unknown> }>("/internal/admin/settings");
  return data.settings;
}

export function saveSetting(key: string, value: unknown): Promise<unknown> {
  return request(`/internal/admin/settings/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify({ value, admin: "dashboard" }),
  });
}

export function refundPayment(id: string, reason: string): Promise<unknown> {
  return request(`/internal/admin/payments/${encodeURIComponent(id)}/refund`, {
    method: "POST",
    body: JSON.stringify({ admin: "dashboard", reason }),
  });
}

export interface ParserPreviewResult {
  parsed: {
    isDeposit: boolean;
    amount: number | null;
    depositorName: string | null;
    depositorMasked: boolean;
    bankName: string | null;
    txnId: string | null;
    confidence: "high" | "medium" | "low";
    reason: string;
    rawText: string;
  };
}

export function previewPaymentParser(input: {
  title?: string;
  body: string;
  appName?: string;
  source?: string;
}): Promise<ParserPreviewResult> {
  return request("/internal/admin/payment-parser/preview", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
