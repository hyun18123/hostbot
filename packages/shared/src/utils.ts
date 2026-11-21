import { BILLING_PERIOD_DAYS, PRICE_PER_BOT_KRW } from "./constants.js";

export function lookup<K extends string, V>(map: Record<K, V>, key: string, fallback: V): V {
  return (map as Record<string, V>)[key] ?? fallback;
}

/** "홍 길동" / "홍길동" / "HONG GILDONG" -> comparable key. */
export function normalizeDepositorName(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s._-]/g, "")
    .trim();
}

export function isMaskedName(value: string | null | undefined): boolean {
  return /[*○●xX]{1,}/.test(value ?? "");
}

/** Compare a parsed depositor name against the name a customer registered. */
export function depositorNameMatches(
  registered: string,
  parsed: string,
): "exact" | "masked" | "mismatch" {
  if (isMaskedName(parsed)) {
    const normalized = normalizeDepositorName(parsed);
    const registeredNormalized = normalizeDepositorName(registered);
    if (normalized.length === 0) return "masked";
    // Only accept a masked name when every visible character matches in place.
    const pattern = new RegExp(
      "^" +
        normalized
          .split("")
          .map((ch) => (ch === "*" || ch === "○" || ch === "●" ? "." : escapeRegExp(ch)))
          .join("") +
        "$",
    );
    if (pattern.test(registeredNormalized)) return "masked";
    return "mismatch";
  }
  return normalizeDepositorName(registered) === normalizeDepositorName(parsed) ? "exact" : "mismatch";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function priceForBots(count: number): number {
  return Math.max(0, Math.trunc(count)) * PRICE_PER_BOT_KRW;
}

export function formatKrw(amount: number): string {
  return `${new Intl.NumberFormat("ko-KR").format(amount)}원`;
}

export function daysRemaining(expiresAt: string | null, now = new Date()): number | null {
  if (!expiresAt) return null;
  const diff = new Date(expiresAt).getTime() - now.getTime();
  return Math.ceil(diff / 86_400_000);
}

/**
 * Expiry reminder thresholds (days before expiry). A bot gets at most one
 * reminder per threshold: D-3, D-1, then the expiry day itself.
 */
export const EXPIRY_REMINDER_STAGES = [3, 1, 0] as const;

export type ExpiryReminderStage = (typeof EXPIRY_REMINDER_STAGES)[number];

/** Which reminder threshold applies for the given remaining days. */
export function expiryReminderStage(daysLeft: number): ExpiryReminderStage | null {
  if (daysLeft <= 0) return 0;
  if (daysLeft <= 1) return 1;
  if (daysLeft <= 3) return 3;
  return null;
}

/** Reminders only move forward (3 -> 1 -> 0), so a stage is sent once. */
export function shouldSendExpiryReminder(
  stage: ExpiryReminderStage,
  lastSent: number | null | undefined,
): boolean {
  return lastSent === null || lastSent === undefined || stage < lastSent;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function periodEnd(start: Date, months = 1): Date {
  return addDays(start, BILLING_PERIOD_DAYS * months);
}

/** Dates are displayed in KST regardless of server timezone. */
export function formatKstDateTime(value: string | Date | null): string {
  if (!value) return "-";
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatKstDate(value: string | Date | null): string {
  if (!value) return "-";
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}

/** Fisher-Yates with crypto randomness, used for request codes. */
export function randomCode(length = 6): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += alphabet[byte % alphabet.length];
  }
  return out;
}

export function requestCode(): string {
  return `HB-${randomCode(6)}`;
}
