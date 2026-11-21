import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  BOT_STATUS_LABELS,
  MAX_BOTS_PER_USER,
  daysRemaining,
  expiryReminderStage,
  shouldSendExpiryReminder,
  type BotDto,
  type HostedBotRow,
  type StatsResult,
} from "@hostbot/shared";
import { config } from "../config.js";
import { AppError, ConflictError, NotFoundError, isUniqueViolation } from "../lib/errors.js";
import { decryptSecret, encryptSecret, sha256Hex, tokenAad } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";
import { db, unwrap } from "../lib/supabase.js";
import {
  getBotLogs,
  installBotDependencies,
  removeBotContainer,
  startBotContainer,
  stopBotContainer,
  getContainerState,
} from "./docker.js";
import { verifyBotToken } from "./discord.js";
import { scanDirectoryWithClamAv, scanFileWithClamAv } from "./malware.js";
import { enqueueNotification } from "./notifications.js";
import { getSetting } from "./settings.js";
import { prepareBotDirs, removeBotDir } from "./storage.js";
import { extractAndInspectBotZip } from "./zip.js";
import { countUserBots, upsertUser } from "./users.js";

const provisioning = new Map<string, Promise<void>>();

export function mapBot(row: HostedBotRow): BotDto {
  const days = daysRemaining(row.expires_at);
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    statusLabel: BOT_STATUS_LABELS[row.status] ?? row.status,
    expiresAt: row.expires_at,
    daysRemaining: days,
    entrypoint: row.entrypoint,
    lastError: row.last_error,
    createdAt: row.created_at,
    paymentDue: !row.expires_at || new Date(row.expires_at).getTime() <= Date.now(),
    discordBotId: row.discord_bot_id,
    discordBotUsername: row.discord_bot_username,
  };
}

function slugify(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return `${base || "bot"}-${id.slice(0, 8)}`;
}

async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function logEvent(
  botId: string,
  level: "debug" | "info" | "warn" | "error",
  event: string,
  message: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db().from("hosting_logs").insert({ bot_id: botId, level, event, message, meta });
  } catch (error) {
    logger.warn({ err: error, botId }, "failed to write hosting log");
  }
}

async function getBotRow(botId: string): Promise<HostedBotRow | null> {
  const { data, error } = await db().from("hosted_bots").select("*").eq("id", botId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as HostedBotRow | null) ?? null;
}

export async function getOwnedBot(botId: string, discordId: string): Promise<HostedBotRow> {
  const row = await getBotRow(botId);
  if (!row || row.deleted_at) throw new NotFoundError("봇을 찾을 수 없습니다.");
  const { data: user, error } = await db().from("users").select("discord_id").eq("id", row.user_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!user || (user as { discord_id: string }).discord_id !== discordId) {
    throw new NotFoundError("봇을 찾을 수 없습니다.");
  }
  return row;
}

export async function getAdminBot(botId: string): Promise<HostedBotRow> {
  const row = await getBotRow(botId);
  if (!row) throw new NotFoundError("봇을 찾을 수 없습니다.");
  return row;
}

export async function listBotsForDiscord(discordId: string): Promise<BotDto[]> {
  const { data: user, error: userError } = await db()
    .from("users")
    .select("id")
    .eq("discord_id", discordId)
    .maybeSingle();
  if (userError) throw new Error(userError.message);
  if (!user) return [];
  const rows = unwrap(
    await db()
      .from("hosted_bots")
      .select("*")
      .eq("user_id", (user as { id: string }).id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
  ) as HostedBotRow[];
  return rows.map(mapBot);
}

export async function listAllBots(limit = 100): Promise<BotDto[]> {
  const rows = unwrap(
    await db()
      .from("hosted_bots")
      .select("*")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 500)),
  ) as HostedBotRow[];
  return rows.map(mapBot);
}

export interface RegisterBotInput {
  discordUserId: string;
  discordUsername: string;
  guildId: string;
  name: string;
  token: string;
  depositorName: string;
  zipPath: string;
  originalFilename: string;
}

export interface RegisteredBot {
  bot: HostedBotRow;
  tokenFingerprint: string;
}

export async function registerBot(input: RegisterBotInput): Promise<RegisteredBot> {
  const cfg = config();
  const registrationEnabled = await getSetting<boolean>("registration_enabled", true);
  if (!registrationEnabled) {
    throw new AppError("registration_disabled", "현재 신규 봇 등록이 일시 중단되었습니다.", 503);
  }

  const user = await upsertUser(input.discordUserId, input.discordUsername);
  const maxBotsSetting = await getSetting<number | string>("max_bots_per_user", MAX_BOTS_PER_USER);
  const maxBots = Number(maxBotsSetting) || MAX_BOTS_PER_USER;
  const existingCount = await countUserBots(user.id);
  if (existingCount >= maxBots) {
    throw new ConflictError(
      "bot_limit_reached",
      `한 계정당 최대 ${maxBots}개의 봇을 호스팅할 수 있습니다. 기존 봇을 삭제한 뒤 다시 시도해 주세요.`,
    );
  }

  // Verify the token with Discord before storing anything.
  const identity = await verifyBotToken(input.token);
  const tokenFingerprint = sha256Hex(input.token);
  const { data: sameToken } = await db()
    .from("bot_secrets")
    .select("bot_id")
    .eq("token_fingerprint", tokenFingerprint)
    .maybeSingle();
  if (sameToken) {
    throw new ConflictError("token_already_registered", "이미 등록된 봇 토큰입니다.");
  }
  const { data: sameBot, error: sameBotError } = await db()
    .from("hosted_bots")
    .select("id")
    .eq("discord_bot_id", identity.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (sameBotError) throw new Error(sameBotError.message);
  if (sameBot) {
    throw new ConflictError(
      "discord_bot_already_hosted",
      "이 디스코드 봇은 이미 호스팅 중입니다. 기존 봇을 삭제한 뒤 다시 등록해 주세요.",
    );
  }

  const id = randomUUID();
  const paths = await prepareBotDirs(id);

  try {
    const sourceSha = await hashFile(input.zipPath);
    await scanFileWithClamAv(input.zipPath);
    const inspection = await extractAndInspectBotZip(input.zipPath, paths.app);
    await scanDirectoryWithClamAv(paths.app);
    const stat = await fs.stat(input.zipPath);

    const { data: plan } = await db()
      .from("hosting_plans")
      .select("id")
      .eq("code", "monthly")
      .eq("is_active", true)
      .maybeSingle();

    const row = unwrap(
      await db()
        .from("hosted_bots")
        .insert({
          id,
          user_id: user.id,
          name: input.name,
          slug: slugify(input.name, id),
          status: "awaiting_payment",
          plan_id: (plan as { id: string } | null)?.id ?? null,
          source_path: `bots/${id}/app`,
          source_sha256: sourceSha,
          source_size: stat.size,
          entrypoint: inspection.entrypoint,
          discord_bot_id: identity.id,
          discord_bot_username: identity.username,
        })
        .select("*")
        .single(),
    ) as HostedBotRow;

    const encrypted = encryptSecret(input.token, cfg.tokenKey, tokenAad(id));
    const { error: secretError } = await db().from("bot_secrets").insert({
      bot_id: id,
      token_encrypted: encrypted,
      token_fingerprint: tokenFingerprint,
      key_version: 1,
    });
    if (secretError) throw new Error(secretError.message);

    await logEvent(id, "info", "bot.registered", `봇이 등록되었습니다. (${input.originalFilename})`, {
      entrypoint: inspection.entrypoint,
      warnings: inspection.warnings,
      uncompressedBytes: inspection.uncompressedBytes,
    });

    return { bot: row, tokenFingerprint };
  } catch (error) {
    await fs.rm(paths.root, { recursive: true, force: true }).catch(() => undefined);
    await db().from("hosted_bots").delete().eq("id", id).then(
      () => undefined,
      () => undefined,
    );
    if (isUniqueViolation(error)) {
      throw new ConflictError("token_already_registered", "이미 등록된 봇 토큰입니다.");
    }
    throw error;
  }
}

export async function getBotToken(botId: string): Promise<string | null> {
  const { data, error } = await db()
    .from("bot_secrets")
    .select("token_encrypted")
    .eq("bot_id", botId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  try {
    return decryptSecret(
      (data as { token_encrypted: string }).token_encrypted,
      config().tokenKey,
      tokenAad(botId),
    );
  } catch (error) {
    logger.error({ err: error, botId }, "failed to decrypt bot token");
    throw new AppError(
      "token_decryption_failed",
      "봇 토큰을 복호화하지 못했습니다. 운영자에게 문의해 주세요.",
      500,
    );
  }
}

async function patchBot(botId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db().from("hosted_bots").update(patch).eq("id", botId);
  if (error) throw new Error(error.message);
}

export function redactToken(text: string, token: string | null): string {
  let output = text;
  if (token) output = output.split(token).join("[REDACTED_TOKEN]");
  return output.replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, "[REDACTED_TOKEN]");
}

/** Installs dependencies and starts the container. Safe to call repeatedly. */
export async function provisionBot(botId: string): Promise<void> {
  const existing = provisioning.get(botId);
  if (existing) return existing;

  const task = (async () => {
    const bot = await getBotRow(botId);
    if (!bot || bot.deleted_at) return;

    if (!bot.expires_at || new Date(bot.expires_at).getTime() <= Date.now()) {
      await patchBot(botId, { status: "expired", last_error: "이용 기간이 만료되었습니다." });
      return;
    }

    const token = await getBotToken(botId);
    if (!token) {
      await patchBot(botId, { status: "error", last_error: "저장된 봇 토큰이 없습니다." });
      await logEvent(botId, "error", "bot.token_missing", "저장된 봇 토큰이 없습니다.");
      return;
    }

    try {
      await patchBot(botId, { status: "installing", last_error: null });
      await logEvent(botId, "info", "bot.install_started", "의존성 설치를 시작합니다.");
      const install = await installBotDependencies(botId);
      if (install.installed) {
        await logEvent(botId, "info", "bot.install_finished", "의존성 설치가 완료되었습니다.");
      }

      const current = await getBotRow(botId);
      if (!current || current.status !== "installing") {
        await logEvent(botId, "warn", "bot.start_cancelled", "시작 요청이 취소되어 컨테이너를 실행하지 않습니다.");
        return;
      }

      await patchBot(botId, { status: "starting" });
      await logEvent(botId, "info", "bot.starting", "컨테이너를 시작합니다.");
      const result = await startBotContainer(current, token, current.entrypoint ?? "index.js");
      await patchBot(botId, {
        status: "running",
        container_id: result.containerId,
        container_name: result.containerName,
        last_started_at: new Date().toISOString(),
        last_error: null,
      });
      await logEvent(botId, "info", "bot.started", "봇이 실행되었습니다.", {
        container: result.containerName,
      });
    } catch (error) {
      const message =
        error instanceof AppError ? error.message : "봇을 시작하는 중 알 수 없는 오류가 발생했습니다.";
      const details = error instanceof AppError ? error.details : undefined;
      const safeDetails = typeof details === "string" ? redactToken(details, token) : undefined;
      await patchBot(botId, {
        status: "error",
        last_error: message.slice(0, 1000),
        container_id: null,
        container_name: null,
      });
      await logEvent(botId, "error", "bot.start_failed", message, {
        details: safeDetails?.slice(-3000),
      });
      logger.error({ err: error, botId }, "bot provisioning failed");

      const fresh = await getBotRow(botId);
      if (fresh) {
        const { data: user } = await db().from("users").select("discord_id").eq("id", fresh.user_id).maybeSingle();
        if (user) {
          await enqueueNotification({
            channel: "dm",
            discordId: (user as { discord_id: string }).discord_id,
            type: "bot_error",
            payload: { botId, botName: fresh.name, message },
          });
        }
      }
    }
  })().finally(() => {
    provisioning.delete(botId);
  });

  provisioning.set(botId, task);
  return task;
}

export async function startBot(botId: string, discordId: string | null): Promise<BotDto> {
  const bot = discordId ? await getOwnedBot(botId, discordId) : await getAdminBot(botId);
  if (bot.deleted_at) throw new NotFoundError("삭제된 봇입니다.");
  if (!bot.expires_at || new Date(bot.expires_at).getTime() <= Date.now()) {
    throw new AppError("payment_required", "이용 기간이 만료되었습니다. 먼저 결제를 진행해 주세요.", 402);
  }
  if (bot.status === "running" || bot.status === "starting" || bot.status === "installing") {
    return mapBot(bot);
  }
  await patchBot(botId, { status: "installing", restart_count: 0, last_error: null });
  void provisionBot(botId);
  return mapBot({ ...bot, status: "installing", restart_count: 0, last_error: null });
}

export async function autoStartAfterPayment(botId: string): Promise<void> {
  const bot = await getBotRow(botId);
  if (!bot || bot.deleted_at) return;
  if (!bot.expires_at || new Date(bot.expires_at).getTime() <= Date.now()) return;
  if (bot.status === "running" || bot.status === "starting" || bot.status === "installing") return;
  await patchBot(botId, { status: "installing", restart_count: 0, last_error: null });
  void provisionBot(botId);
}

export async function stopBot(
  botId: string,
  discordId: string | null,
  options: { status?: "stopped" | "expired" | "error"; reason?: string } = {},
): Promise<BotDto> {
  const bot = discordId ? await getOwnedBot(botId, discordId) : await getAdminBot(botId);
  if (bot.deleted_at) throw new NotFoundError("삭제된 봇입니다.");
  await stopBotContainer(bot);
  const status = options.status ?? "stopped";
  await patchBot(botId, {
    status,
    container_id: null,
    container_name: null,
    last_stopped_at: new Date().toISOString(),
    last_error: options.reason ?? null,
  });
  await logEvent(botId, "info", "bot.stopped", options.reason ?? "봇이 중지되었습니다.", { status });
  return mapBot((await getBotRow(botId))!);
}

export async function restartBot(botId: string, discordId: string | null): Promise<BotDto> {
  const bot = discordId ? await getOwnedBot(botId, discordId) : await getAdminBot(botId);
  if (bot.deleted_at) throw new NotFoundError("삭제된 봇입니다.");
  await stopBotContainer(bot);
  await patchBot(botId, {
    status: "installing",
    container_id: null,
    container_name: null,
    restart_count: 0,
    last_error: null,
  });
  await logEvent(botId, "info", "bot.restarting", "사용자 요청으로 봇을 재시작합니다.");
  void provisionBot(botId);
  return mapBot((await getBotRow(botId))!);
}

export async function botLogs(botId: string, discordId: string | null, lines: number): Promise<string> {
  const bot = discordId ? await getOwnedBot(botId, discordId) : await getAdminBot(botId);
  const [token, logs] = await Promise.all([
    getBotToken(botId).catch(() => null),
    getBotLogs(bot, Math.min(Math.max(lines, 10), 500)),
  ]);
  return redactToken(logs || "(로그가 없습니다)", token);
}

export async function deleteBot(botId: string, actor: string, admin: boolean): Promise<void> {
  const bot = admin ? await getAdminBot(botId) : await getOwnedBot(botId, actor);
  if (bot.deleted_at) return;
  await patchBot(botId, { status: "deleting" });
  try {
    await removeBotContainer(bot);
  } catch (error) {
    logger.warn({ err: error, botId }, "failed to remove container during deletion");
  }
  await removeBotDir(botId).catch(() => undefined);
  await db().from("bot_secrets").delete().eq("bot_id", botId);
  await db()
    .from("payment_requests")
    .update({ status: "expired", note: "봇 삭제로 결제 신청이 종료되었습니다." })
    .eq("bot_id", botId)
    .in("status", ["awaiting_deposit", "manual_review"]);
  await patchBot(botId, {
    status: "deleted",
    name: "삭제된 봇",
    source_path: null,
    source_sha256: null,
    source_size: null,
    entrypoint: null,
    container_id: null,
    container_name: null,
    deleted_at: new Date().toISOString(),
    last_error: null,
  });
  await logEvent(botId, "info", "bot.deleted", "호스팅 데이터가 삭제되었습니다.");
  await db().from("audit_logs").insert({
    actor,
    action: "bot.delete",
    target_type: "hosted_bot",
    target_id: botId,
  });
}

export async function expireBots(): Promise<number> {
  const rows = unwrap(
    await db()
      .from("hosted_bots")
      .select("*")
      .in("status", ["running", "starting", "installing", "stopped", "error"])
      .lt("expires_at", new Date().toISOString())
      .is("deleted_at", null)
      .limit(100),
  ) as HostedBotRow[];

  let count = 0;
  for (const bot of rows) {
    try {
      await stopBotContainer(bot);
      await patchBot(bot.id, {
        status: "expired",
        container_id: null,
        container_name: null,
        last_stopped_at: new Date().toISOString(),
        last_error: "이용 기간이 만료되었습니다.",
      });
      await logEvent(bot.id, "warn", "bot.expired", "이용 기간이 만료되어 봇을 중지했습니다.");
      const { data: user } = await db().from("users").select("discord_id").eq("id", bot.user_id).maybeSingle();
      if (user) {
        await enqueueNotification({
          channel: "dm",
          discordId: (user as { discord_id: string }).discord_id,
          type: "bot_expired",
          payload: { botId: bot.id, botName: bot.name, expiresAt: bot.expires_at },
        });
      }
      count += 1;
    } catch (error) {
      logger.error({ err: error, botId: bot.id }, "failed to expire bot");
    }
  }
  if (count > 0) logger.info({ count }, "expired bots stopped");
  return count;
}

export async function listBotEvents(botId: string, limit = 50): Promise<
  Array<{
    id: number;
    level: "debug" | "info" | "warn" | "error";
    event: string;
    message: string | null;
    meta: Record<string, unknown>;
    createdAt: string;
  }>
> {
  const rows = unwrap(
    await db()
      .from("hosting_logs")
      .select("id, level, event, message, meta, created_at")
      .eq("bot_id", botId)
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 200)),
  ) as Array<{
    id: number;
    level: "debug" | "info" | "warn" | "error";
    event: string;
    message: string | null;
    meta: Record<string, unknown>;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    level: row.level,
    event: row.event,
    message: row.message,
    meta: row.meta,
    createdAt: row.created_at,
  }));
}

export async function reconcileBots(): Promise<void> {
  const rows = unwrap(
    await db()
      .from("hosted_bots")
      .select("*")
      .in("status", ["running", "starting", "installing"])
      .gt("expires_at", new Date().toISOString())
      .is("deleted_at", null)
      .limit(100),
  ) as HostedBotRow[];

  for (const bot of rows) {
    try {
      if (bot.status === "installing" || bot.status === "starting") {
        const startedAt = new Date(bot.updated_at).getTime();
        if (Date.now() - startedAt > 20 * 60_000) {
          await patchBot(bot.id, {
            status: "error",
            last_error: "시작 작업이 시간 초과되었습니다. 다시 시작해 주세요.",
          });
          await logEvent(bot.id, "error", "bot.start_timeout", "시작 작업이 시간 초과되었습니다.");
        }
        continue;
      }

      const state = await getContainerState(bot);
      if (state.running) continue;

      if (bot.restart_count < 3) {
        await patchBot(bot.id, {
          status: "installing",
          restart_count: bot.restart_count + 1,
          last_error: "예기치 않게 종료되어 자동 재시작합니다.",
        });
        await logEvent(bot.id, "warn", "bot.auto_restart", "봇이 종료되어 자동 재시작합니다.", {
          attempt: bot.restart_count + 1,
        });
        void provisionBot(bot.id);
      } else {
        await patchBot(bot.id, {
          status: "error",
          last_error: "봇이 반복적으로 종료되었습니다. 로그를 확인해 주세요.",
        });
        await logEvent(bot.id, "error", "bot.crash_loop", "자동 재시작 횟수를 초과했습니다.");
        const { data: user } = await db().from("users").select("discord_id").eq("id", bot.user_id).maybeSingle();
        if (user) {
          await enqueueNotification({
            channel: "dm",
            discordId: (user as { discord_id: string }).discord_id,
            type: "bot_crash_loop",
            payload: { botId: bot.id, botName: bot.name },
          });
        }
      }
    } catch (error) {
      logger.error({ err: error, botId: bot.id }, "reconcile failed for bot");
    }
  }
}

/**
 * Sends D-3 / D-1 / D-day renewal reminders. Each threshold is delivered once
 * per billing period; approving a payment resets the stage to null.
 */
export async function sendExpiryReminders(): Promise<number> {
  const now = new Date();
  const horizon = new Date(now.getTime() + 4 * 86_400_000).toISOString();
  const rows = unwrap(
    await db()
      .from("hosted_bots")
      .select("*, users(discord_id)")
      .in("status", ["running", "stopped", "error"])
      .is("deleted_at", null)
      .not("expires_at", "is", null)
      .gt("expires_at", now.toISOString())
      .lte("expires_at", horizon)
      .order("expires_at", { ascending: true })
      .limit(100),
  ) as Array<HostedBotRow & { users?: { discord_id: string } | { discord_id: string }[] }>;

  let sent = 0;
  for (const bot of rows) {
    if (!bot.expires_at) continue;
    const daysLeft = Math.max(0, Math.floor((new Date(bot.expires_at).getTime() - now.getTime()) / 86_400_000));
    const stage = expiryReminderStage(daysLeft);
    if (stage === null || !shouldSendExpiryReminder(stage, bot.expiry_notice_days)) continue;

    const userEmbed = Array.isArray(bot.users) ? bot.users[0] : bot.users;
    if (userEmbed?.discord_id) {
      await enqueueNotification({
        channel: "dm",
        discordId: userEmbed.discord_id,
        type: "bot_expiry_soon",
        payload: {
          botId: bot.id,
          botName: bot.name,
          daysLeft,
          stage,
          expiresAt: bot.expires_at,
        },
      });
    }
    await patchBot(bot.id, { expiry_notice_days: stage });
    await logEvent(
      bot.id,
      "info",
      "bot.expiry_reminder",
      daysLeft <= 0
        ? "이용 만료일 안내를 발송했습니다."
        : `이용 만료 ${daysLeft}일 전 안내를 발송했습니다.`,
      { stage, daysLeft },
    );
    sent += 1;
  }
  if (sent > 0) logger.info({ sent }, "expiry reminders queued");
  return sent;
}

export async function getStats(): Promise<StatsResult> {  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const last30 = new Date(now.getTime() - 30 * 86_400_000);

  const count = async (builder: PromiseLike<{ count: number | null; error: { message: string } | null }>) => {
    const result = await builder;
    if (result.error) throw new Error(result.error.message);
    return result.count ?? 0;
  };

  const [
    users,
    total,
    running,
    stopped,
    expired,
    errorBots,
    awaitingPayment,
    pendingRequests,
    manualReview,
  ] = await Promise.all([
    count(db().from("users").select("id", { count: "exact", head: true })),
    count(db().from("hosted_bots").select("id", { count: "exact", head: true }).is("deleted_at", null)),
    count(db().from("hosted_bots").select("id", { count: "exact", head: true }).eq("status", "running")),
    count(db().from("hosted_bots").select("id", { count: "exact", head: true }).eq("status", "stopped")),
    count(db().from("hosted_bots").select("id", { count: "exact", head: true }).eq("status", "expired")),
    count(db().from("hosted_bots").select("id", { count: "exact", head: true }).eq("status", "error")),
    count(
      db()
        .from("hosted_bots")
        .select("id", { count: "exact", head: true })
        .eq("status", "awaiting_payment")
        .is("deleted_at", null),
    ),
    count(
      db()
        .from("payment_requests")
        .select("id", { count: "exact", head: true })
        .in("status", ["awaiting_deposit", "manual_review"]),
    ),
    count(
      db()
        .from("payment_requests")
        .select("id", { count: "exact", head: true })
        .eq("status", "manual_review"),
    ),
  ]);

  const payments = unwrap(
    await db()
      .from("payments")
      .select("amount, approved_at")
      .eq("status", "approved")
      .gte("approved_at", last30.toISOString()),
  ) as Array<{ amount: number; approved_at: string }>;

  const allTime = unwrap(
    await db().from("payments").select("amount").eq("status", "approved"),
  ) as Array<{ amount: number }>;

  const sum = (rows: Array<{ amount: number }>) => rows.reduce((totalValue, row) => totalValue + row.amount, 0);

  return {
    users,
    bots: { total, running, stopped, expired, error: errorBots, awaitingPayment },
    revenue: {
      thisMonthKrw: sum(payments.filter((payment) => new Date(payment.approved_at) >= monthStart)),
      last30DaysKrw: sum(payments),
      totalKrw: sum(allTime),
    },
    pending: { paymentRequests: pendingRequests, manualReview },
  };
}

export async function removeSourceAfterRetention(days: number): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const expired = unwrap(
    await db()
      .from("hosted_bots")
      .select("id, status")
      .in("status", ["expired", "error"])
      .lt("expires_at", cutoff)
      .is("deleted_at", null)
      .not("source_path", "is", null)
      .limit(50),
  ) as Array<{ id: string; status: string }>;
  const abandoned = unwrap(
    await db()
      .from("hosted_bots")
      .select("id, status")
      .eq("status", "awaiting_payment")
      .lt("created_at", cutoff)
      .is("deleted_at", null)
      .not("source_path", "is", null)
      .limit(50),
  ) as Array<{ id: string; status: string }>;

  let count = 0;
  for (const row of [...expired, ...abandoned]) {
    await removeBotDir(row.id).catch(() => undefined);
    await patchBot(row.id, {
      source_path: null,
      entrypoint: null,
      ...(row.status === "awaiting_payment"
        ? { status: "expired", last_error: "미결제 등록이 만료되어 소스가 삭제되었습니다." }
        : {}),
    });
    await db().from("bot_secrets").delete().eq("bot_id", row.id);
    await logEvent(
      row.id,
      "info",
      "bot.source_retention_expired",
      row.status === "awaiting_payment"
        ? "미결제 등록이 만료되어 소스와 토큰을 삭제했습니다."
        : "보관 기간이 지나 소스와 토큰을 삭제했습니다.",
    );
    count += 1;
  }
  return count;
}
