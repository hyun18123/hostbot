import WebSocket from "ws";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { processDepositNotification } from "./payments.js";

/**
 * Pushbullet streaming API.
 *
 * Pushbullet does not offer webhooks for Android notification mirroring. The
 * documented route is the streaming WebSocket (`wss://stream.pushbullet.com`),
 * which delivers `mirror` and `sms_changed` pushes. This requires:
 *   - Pushbullet Android app installed and logged in
 *   - Notification access granted
 *   - Notification mirroring enabled
 *   - SMS access granted for SMS mirroring
 *
 * Bank apps do not all use the same notification text. Parsing is delegated to
 * the conservative adapter in payment-parser.ts, and ambiguous matches always
 * go to an operator.
 */
let socket: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let stopped = false;
let attempts = 0;

const status = {
  enabled: false,
  connected: false,
  lastEventAt: null as string | null,
  lastError: null as string | null,
  reconnects: 0,
  startedAt: null as string | null,
};

export function pushbulletStatus(): typeof status {
  return { ...status };
}

export function startPushbullet(): void {
  const token = config().PUSHBULLET_ACCESS_TOKEN;
  if (!token) {
    logger.warn("PUSHBULLET_ACCESS_TOKEN is not set; automatic deposit detection is disabled");
    status.enabled = false;
    return;
  }
  status.enabled = true;
  status.startedAt = new Date().toISOString();
  stopped = false;
  connect(token);
}

export function stopPushbullet(): void {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (pingTimer) clearInterval(pingTimer);
  reconnectTimer = null;
  pingTimer = null;
  socket?.close();
  socket = null;
}

function scheduleReconnect(token: string): void {
  if (stopped) return;
  attempts += 1;
  status.reconnects = attempts;
  const delay = Math.min(60_000, 2_000 * 2 ** Math.min(attempts, 5));
  logger.info({ delayMs: delay }, "reconnecting to Pushbullet stream");
  reconnectTimer = setTimeout(() => connect(token), delay);
  reconnectTimer.unref();
}

function connect(token: string): void {
  if (stopped) return;
  const url = `wss://stream.pushbullet.com/streaming/${encodeURIComponent(token)}`;
  const ws = new WebSocket(url, { handshakeTimeout: 20_000 });
  socket = ws;

  ws.on("open", () => {
    attempts = 0;
    status.connected = true;
    status.lastError = null;
    logger.info("Pushbullet stream connected");
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      try {
        ws.ping();
      } catch {
        // ignore
      }
    }, 30_000);
    pingTimer.unref();
  });

  ws.on("message", (data) => {
    try {
      handleMessage(data.toString());
    } catch (error) {
      logger.warn({ err: error }, "failed to handle Pushbullet message");
    }
  });

  ws.on("error", (error) => {
    status.lastError = error.message;
    logger.warn({ err: error }, "Pushbullet stream error");
  });

  ws.on("close", (code) => {
    status.connected = false;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    socket = null;
    logger.warn({ code }, "Pushbullet stream closed");
    scheduleReconnect(token);
  });
}

interface PushbulletPush {
  type?: string;
  title?: string;
  body?: string;
  application_name?: string;
  package_name?: string;
  notification_id?: string;
  notifications?: Array<{
    title?: string;
    body?: string;
    timestamp?: number;
    notification_id?: string;
    package_name?: string;
  }>;
}

function handleMessage(raw: string): void {
  const message = JSON.parse(raw) as { type?: string; push?: PushbulletPush };
  if (message.type === "nop") return;
  if (message.type !== "push" || !message.push) return;
  const push = message.push;

  if (push.type === "mirror") {
    if (!push.body) return;
    status.lastEventAt = new Date().toISOString();
    void processDepositNotification({
      source: "pushbullet",
      eventId: push.notification_id ?? `${push.package_name ?? "app"}:${hashText(push.body)}`,
      appName: push.application_name ?? push.package_name,
      title: push.title,
      body: push.body,
      receivedAt: new Date(),
      raw: {
        type: push.type,
        application_name: push.application_name,
        package_name: push.package_name,
        notification_id: push.notification_id,
        title: push.title,
      },
    }).catch((error) => logger.error({ err: error }, "failed to process Pushbullet mirror push"));
    return;
  }

  if (push.type === "sms_changed" && Array.isArray(push.notifications)) {
    for (const item of push.notifications) {
      if (!item.body) continue;
      status.lastEventAt = new Date().toISOString();
      void processDepositNotification({
        source: "pushbullet:sms",
        eventId: item.notification_id ?? `${item.timestamp ?? Date.now()}:${hashText(item.body)}`,
        appName: "SMS",
        title: item.title,
        body: item.body,
        receivedAt: smsTimestampToDate(item.timestamp),
        raw: {
          type: "sms_changed",
          title: item.title,
          timestamp: item.timestamp,
          notification_id: item.notification_id,
        },
      }).catch((error) => logger.error({ err: error }, "failed to process Pushbullet SMS push"));
    }
  }
}

/**
 * Pushbullet has shipped both second- and millisecond-based timestamps for
 * SMS pushes depending on client version. Normalize defensively.
 */
function smsTimestampToDate(timestamp: number | undefined): Date {
  if (!timestamp || !Number.isFinite(timestamp) || timestamp <= 0) return new Date();
  const millis = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function hashText(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(31, hash) + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16);
}
