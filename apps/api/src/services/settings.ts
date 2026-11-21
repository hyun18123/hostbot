import { db, unwrap } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;
  try {
    const { data, error } = await db().from("admin_settings").select("value").eq("key", key).maybeSingle();
    if (error) throw new Error(error.message);
    const value = data ? (data.value as T) : fallback;
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (error) {
    logger.warn({ err: error, key }, "failed to read admin setting; using fallback");
    return fallback;
  }
}

export async function getAllSettings(): Promise<Record<string, unknown>> {
  const rows = unwrap(
    await db().from("admin_settings").select("key, value, updated_at").order("key"),
  ) as Array<{ key: string; value: unknown; updated_at: string }>;
  const result: Record<string, unknown> = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

export async function setSetting(key: string, value: unknown, updatedBy: string): Promise<void> {
  const { error } = await db()
    .from("admin_settings")
    .upsert({ key, value, updated_by: updatedBy, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  cache.delete(key);
}

export async function getBankInfo(): Promise<{
  bankName: string;
  accountNumber: string;
  accountHolder: string;
  instructions: string;
}> {
  const value = await getSetting<Record<string, unknown>>("bank_account", {});
  const instructions = await getSetting<string>("payment_instructions", "");
  return {
    bankName: typeof value.bankName === "string" ? value.bankName : process.env.BANK_NAME ?? "국민은행",
    accountNumber:
      typeof value.accountNumber === "string"
        ? value.accountNumber
        : process.env.BANK_ACCOUNT_NUMBER ?? "000000-00-000000",
    accountHolder:
      typeof value.accountHolder === "string"
        ? value.accountHolder
        : process.env.BANK_ACCOUNT_HOLDER ?? "예금주",
    instructions: typeof instructions === "string" ? instructions : "",
  };
}

export function invalidateSettingCache(): void {
  cache.clear();
}
