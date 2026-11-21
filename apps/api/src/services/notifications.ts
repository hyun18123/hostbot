import { db, unwrap } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";
import { env } from "../lib/env.js";

export type NotificationChannel = "dm" | "admin";

export interface EnqueueNotificationInput {
  channel: NotificationChannel;
  discordId?: string | null;
  type: string;
  payload?: Record<string, unknown>;
}

/** Best-effort outbox insert: notification failures must not break payments. */
export async function enqueueNotification(input: EnqueueNotificationInput): Promise<void> {
  try {
    const { error } = await db().from("notifications").insert({
      channel: input.channel,
      discord_id: input.channel === "dm" ? input.discordId ?? null : null,
      type: input.type,
      payload: input.payload ?? {},
    });
    if (error) throw new Error(error.message);
  } catch (error) {
    logger.error({ err: error, type: input.type }, "failed to enqueue notification");
  }
}

export async function enqueueAdminAlert(type: string, payload: Record<string, unknown>): Promise<void> {
  await enqueueNotification({ channel: "admin", type, payload });
  if (env.ADMIN_LOG_CHANNEL_ID) {
    // The management bot resolves the channel id itself; nothing else needed.
    logger.info({ type, channelId: env.ADMIN_LOG_CHANNEL_ID }, "admin alert queued");
  }
}

export async function takePendingNotifications(limit = 20): Promise<
  Array<{
    id: number;
    channel: NotificationChannel;
    discordId: string | null;
    type: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>
> {
  const rows = unwrap(
    await db()
      .from("notifications")
      .select("id, channel, discord_id, type, payload, created_at")
      .eq("status", "pending")
      .order("id", { ascending: true })
      .limit(Math.min(Math.max(limit, 1), 50)),
  ) as Array<{
    id: number;
    channel: NotificationChannel;
    discord_id: string | null;
    type: string;
    payload: Record<string, unknown>;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    discordId: row.discord_id,
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at,
  }));
}

export async function acknowledgeNotifications(
  ids: number[],
  success: boolean,
  errorMessage?: string,
): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await db()
    .from("notifications")
    .update({
      status: success ? "sent" : "failed",
      sent_at: new Date().toISOString(),
      last_error: success ? null : (errorMessage ?? "unknown error").slice(0, 1000),
    })
    .in("id", ids);
  if (error) throw new Error(error.message);
}

export async function broadcastNotice(payload: Record<string, unknown>): Promise<number> {
  const users = unwrap(await db().from("users").select("discord_id")) as Array<{ discord_id: string }>;
  if (users.length === 0) return 0;
  const rows = users.map((user) => ({
    channel: "dm",
    discord_id: user.discord_id,
    type: "notice",
    payload,
  }));
  const chunkSize = 500;
  for (let index = 0; index < rows.length; index += chunkSize) {
    const { error } = await db().from("notifications").insert(rows.slice(index, index + chunkSize));
    if (error) throw new Error(error.message);
  }
  return rows.length;
}
