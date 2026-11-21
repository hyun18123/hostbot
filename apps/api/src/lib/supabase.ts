import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config.js";

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!client) {
    const cfg = config();
    client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        headers: {
          "x-application-name": "hostbot-api",
        },
      },
    });
  }
  return client;
}

/** Throw a readable error when a Supabase operation failed. */
export function unwrap<T>(result: { data: T; error: { message: string; code?: string } | null }): T {
  if (result.error) {
    const error = new Error(result.error.message) as Error & { code?: string };
    error.code = result.error.code;
    throw error;
  }
  return result.data;
}
