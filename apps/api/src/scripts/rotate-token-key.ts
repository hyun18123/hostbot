/**
 * Bot token encryption key rotation.
 *
 * Usage (from apps/api):
 *   TOKEN_ENCRYPTION_KEY=<old> NEW_TOKEN_ENCRYPTION_KEY=<new> npm run rotate-token-key
 *   ... -- --apply
 *
 * Without --apply this is a dry run: every stored token is decrypted and
 * re-encrypted in memory, but nothing is written.
 *
 * Generate a key with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */
import dotenv from "dotenv";

dotenv.config();

import { createClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret, tokenAad } from "../lib/crypto.js";

const PAGE_SIZE = 200;
const APPLY = process.argv.includes("--apply");

function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}

function readKey(name: string): Buffer {
  const value = process.env[name];
  if (!value) fail(`${name} is not set`);
  const buffer = Buffer.from(value, "base64");
  if (buffer.length !== 32) {
    fail(`${name} must decode to exactly 32 bytes (got ${buffer.length})`);
  }
  return buffer;
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) fail("SUPABASE_URL is not set");
  if (!serviceKey) fail("SUPABASE_SERVICE_ROLE_KEY is not set");

  const oldKey = readKey(process.env.OLD_TOKEN_ENCRYPTION_KEY ? "OLD_TOKEN_ENCRYPTION_KEY" : "TOKEN_ENCRYPTION_KEY");
  const newKey = readKey("NEW_TOKEN_ENCRYPTION_KEY");
  if (oldKey.equals(newKey)) fail("new key must differ from the current key");

  const db = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`mode: ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}`);

  let from = 0;
  let scanned = 0;
  let rotated = 0;
  const failures: Array<{ botId: string; error: string }> = [];

  for (;;) {
    const { data, error } = await db
      .from("bot_secrets")
      .select("bot_id, token_encrypted, key_version")
      .order("bot_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) fail(`failed to read bot_secrets: ${error.message}`);

    const rows = (data ?? []) as Array<{ bot_id: string; token_encrypted: string; key_version: number }>;
    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      let plaintext: string;
      try {
        plaintext = decryptSecret(row.token_encrypted, oldKey, tokenAad(row.bot_id));
      } catch (oldError) {
        // Idempotent rerun: if the token already decrypts with the new key,
        // skip it instead of failing.
        try {
          decryptSecret(row.token_encrypted, newKey, tokenAad(row.bot_id));
          console.log(`· ${row.bot_id} already uses the new key, skipping`);
          continue;
        } catch {
          failures.push({
            botId: row.bot_id,
            error: oldError instanceof Error ? oldError.message : String(oldError),
          });
          continue;
        }
      }

      const reencrypted = encryptSecret(plaintext, newKey, tokenAad(row.bot_id));
      // Sanity check before writing anything.
      if (decryptSecret(reencrypted, newKey, tokenAad(row.bot_id)) !== plaintext) {
        failures.push({ botId: row.bot_id, error: "round-trip verification failed" });
        continue;
      }

      if (APPLY) {
        const { error: updateError } = await db
          .from("bot_secrets")
          .update({ token_encrypted: reencrypted, key_version: row.key_version + 1 })
          .eq("bot_id", row.bot_id);
        if (updateError) {
          failures.push({ botId: row.bot_id, error: updateError.message });
          continue;
        }
      }
      rotated += 1;
    }

    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  console.log(`scanned: ${scanned}`);
  console.log(`${APPLY ? "rotated" : "rotatable"}: ${rotated}`);
  if (failures.length > 0) {
    console.error(`failed: ${failures.length}`);
    for (const failure of failures) console.error(`  - ${failure.botId}: ${failure.error}`);
    process.exit(1);
  }
  if (!APPLY && rotated > 0) {
    console.log("Re-run with --apply to write the new ciphertexts.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
