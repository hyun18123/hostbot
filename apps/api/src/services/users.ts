import type { UserRow } from "@hostbot/shared";
import { db, unwrap } from "../lib/supabase.js";

export async function upsertUser(discordId: string, username: string): Promise<UserRow> {
  const row = unwrap(
    await db()
      .from("users")
      .upsert(
        { discord_id: discordId, username: username.slice(0, 80) },
        { onConflict: "discord_id" },
      )
      .select("*")
      .single(),
  ) as UserRow;
  return row;
}

export async function getUserByDiscordId(discordId: string): Promise<UserRow | null> {
  const { data, error } = await db().from("users").select("*").eq("discord_id", discordId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as UserRow | null) ?? null;
}

export async function countUserBots(userId: string): Promise<number> {
  const { count, error } = await db()
    .from("hosted_bots")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("deleted_at", null);
  if (error) throw new Error(error.message);
  return count ?? 0;
}
