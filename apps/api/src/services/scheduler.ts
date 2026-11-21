import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { expireBots, reconcileBots, removeSourceAfterRetention, sendExpiryReminders } from "./bots.js";
import { expirePaymentRequests } from "./payments.js";

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastPaymentExpiry = 0;
let lastRetention = 0;
let lastExpiryReminder = 0;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await expireBots();
    await reconcileBots();

    const now = Date.now();
    if (now - lastPaymentExpiry > 5 * 60_000) {
      lastPaymentExpiry = now;
      await expirePaymentRequests();
    }
    if (now - lastRetention > 24 * 60 * 60_000) {
      lastRetention = now;
      const removed = await removeSourceAfterRetention(config().DATA_RETENTION_DAYS);
      if (removed > 0) logger.info({ removed }, "removed expired bot sources");
    }
    if (now - lastExpiryReminder > 6 * 60 * 60_000) {
      lastExpiryReminder = now;
      await sendExpiryReminders();
    }
  } catch (error) {
    logger.error({ err: error }, "scheduler tick failed");
  } finally {
    running = false;
  }
}

/**
 * Single-process scheduler. Run exactly one API instance per VPS; if you scale
 * horizontally, move this into a dedicated worker with a Postgres advisory lock.
 */
export function startScheduler(): void {
  const interval = config().RECONCILE_INTERVAL_MS;
  timer = setInterval(() => void tick(), interval);
  timer.unref();
  setTimeout(() => void tick(), 10_000).unref();
  logger.info({ intervalMs: interval }, "scheduler started");
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
