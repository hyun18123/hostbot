import type {
  BotDto,
  PaymentDto,
  PaymentRequestDto,
  RegistrationResult,
  StatsResult,
} from "@hostbot/shared";
import { config } from "./config.js";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "api_error", status = 500) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  admin?: boolean;
  timeoutMs?: number;
}

export interface PaymentRequestResponse {
  paymentRequest: PaymentRequestDto;
  bank: {
    bankName: string;
    accountNumber: string;
    accountHolder: string;
    instructions: string;
  };
}

export interface PaymentStatusResponse {
  requests: PaymentRequestDto[];
  payments: PaymentDto[];
}

export interface NotificationItem {
  id: number;
  channel: "dm" | "admin";
  discordId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly botKey: string;
  private readonly adminKey: string;
  private readonly timeoutMs: number;

  constructor(options?: { baseUrl?: string; botKey?: string; adminKey?: string; timeoutMs?: number }) {
    const cfg = config();
    this.baseUrl = (options?.baseUrl ?? cfg.apiBaseUrl).replace(/\/+$/, "");
    this.botKey = options?.botKey ?? cfg.botApiKey;
    this.adminKey = options?.adminKey ?? cfg.adminApiKey;
    this.timeoutMs = options?.timeoutMs ?? cfg.apiTimeoutMs;
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      ...(options.admin ? { "x-admin-api-key": this.adminKey } : { "x-bot-api-key": this.botKey }),
      accept: "application/json",
    };
    let body: BodyInit | undefined;
    if (options.body instanceof FormData) {
      body = options.body;
    } else if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method ?? "GET",
        headers,
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
      });
    } catch (error) {
      throw new ApiError(
        "호스팅 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.",
        "network_error",
        503,
      );
    }

    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON error body
    }

    if (!response.ok) {
      const errorBody = data as { error?: { code?: string; message?: string } } | null;
      throw new ApiError(
        errorBody?.error?.message ?? `호스팅 서버 오류 (HTTP ${response.status})`,
        errorBody?.error?.code ?? "api_error",
        response.status,
      );
    }
    return data as T;
  }

  registerBot(form: FormData): Promise<RegistrationResult> {
    return this.request<RegistrationResult>("/internal/bots", {
      method: "POST",
      body: form,
      timeoutMs: 120_000,
    });
  }

  listBots(discordUserId: string): Promise<{ bots: BotDto[] }> {
    return this.request("/internal/bots", { query: { discordUserId } });
  }

  getBot(botId: string, discordUserId: string): Promise<{ bot: BotDto }> {
    return this.request(`/internal/bots/${botId}`, { query: { discordUserId } });
  }

  startBot(botId: string, discordUserId: string): Promise<{ bot: BotDto }> {
    return this.request(`/internal/bots/${botId}/start`, { method: "POST", body: { discordUserId } });
  }

  stopBot(botId: string, discordUserId: string): Promise<{ bot: BotDto }> {
    return this.request(`/internal/bots/${botId}/stop`, { method: "POST", body: { discordUserId } });
  }

  restartBot(botId: string, discordUserId: string): Promise<{ bot: BotDto }> {
    return this.request(`/internal/bots/${botId}/restart`, { method: "POST", body: { discordUserId } });
  }

  logs(botId: string, discordUserId: string, lines = 100): Promise<{ logs: string }> {
    return this.request(`/internal/bots/${botId}/logs`, { query: { discordUserId, lines } });
  }

  createPaymentRequest(
    botId: string,
    discordUserId: string,
    depositorName: string,
    months = 1,
  ): Promise<PaymentRequestResponse> {
    return this.request(`/internal/bots/${botId}/payment-request`, {
      method: "POST",
      body: { discordUserId, depositorName, months },
    });
  }

  paymentStatus(discordUserId: string): Promise<PaymentStatusResponse> {
    return this.request("/internal/payments", { query: { discordUserId } });
  }

  plans(): Promise<{ plans: Array<{ code: string; name: string; price_krw: number; duration_days: number }>; bank: { bankName: string; accountNumber: string; accountHolder: string; instructions: string } }> {
    return this.request("/internal/plans");
  }

  takeNotifications(limit = 20): Promise<{ notifications: NotificationItem[] }> {
    return this.request("/internal/notifications", { query: { limit } });
  }

  ackNotifications(ids: number[], success: boolean, error?: string): Promise<{ ok: boolean }> {
    return this.request("/internal/notifications/ack", {
      method: "POST",
      body: { ids, success, error },
    });
  }

  // ---- admin -------------------------------------------------------------
  adminStats(): Promise<StatsResult> {
    return this.request("/internal/admin/stats", { admin: true });
  }

  adminBots(limit = 100): Promise<{ bots: BotDto[] }> {
    return this.request("/internal/admin/bots", { admin: true, query: { limit } });
  }

  adminStopBot(botId: string): Promise<{ bot: BotDto }> {
    return this.request(`/internal/admin/bots/${botId}/stop`, {
      method: "POST",
      admin: true,
      body: { admin: "management-bot" },
    });
  }

  adminDeleteBot(botId: string): Promise<{ ok: boolean }> {
    return this.request(`/internal/admin/bots/${botId}`, {
      method: "DELETE",
      admin: true,
      body: { admin: "management-bot" },
    });
  }

  adminRequests(status?: string, limit = 30): Promise<{ requests: PaymentRequestDto[] }> {
    return this.request("/internal/admin/payment-requests", { admin: true, query: { status, limit } });
  }

  adminPayments(limit = 30): Promise<{ payments: PaymentDto[] }> {
    return this.request("/internal/admin/payments", { admin: true, query: { limit } });
  }

  adminApprove(codeOrId: string): Promise<{ paymentId: string; botId: string; periodEnd: string; months: number }> {
    return this.request(`/internal/admin/payment-requests/${encodeURIComponent(codeOrId)}/approve`, {
      method: "POST",
      admin: true,
      body: { admin: "management-bot" },
    });
  }

  adminReject(codeOrId: string, reason: string): Promise<{ ok: boolean }> {
    return this.request(`/internal/admin/payment-requests/${encodeURIComponent(codeOrId)}/reject`, {
      method: "POST",
      admin: true,
      body: { admin: "management-bot", reason },
    });
  }

  adminBroadcast(message: string): Promise<{ queued: number }> {
    return this.request("/internal/admin/broadcast", {
      method: "POST",
      admin: true,
      body: { message, title: "호스팅 공지" },
    });
  }

  adminSettings(): Promise<{ settings: Record<string, unknown> }> {
    return this.request("/internal/admin/settings", { admin: true });
  }

  adminSetSetting(key: string, value: unknown): Promise<{ ok: boolean }> {
    return this.request(`/internal/admin/settings/${encodeURIComponent(key)}`, {
      method: "PUT",
      admin: true,
      body: { value, admin: "management-bot" },
    });
  }
}
