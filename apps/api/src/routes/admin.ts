import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, unwrap } from "../lib/supabase.js";
import { AppError } from "../lib/errors.js";
import { optionalString, parseInput, requireString } from "../lib/http.js";
import { getAdminBot, deleteBot, getStats, listAllBots, listBotEvents, restartBot, stopBot, botLogs } from "../services/bots.js";
import {
  approvePaymentRequest,
  listPaymentRequests,
  listPayments,
  refundPayment,
  rejectPaymentRequest,
} from "../services/payments.js";
import { getAllSettings, getSetting, setSetting } from "../services/settings.js";
import { broadcastNotice } from "../services/notifications.js";
import { parseBankParserRules, parseDepositNotification } from "../services/payment-parser.js";
import { pushbulletStatus } from "../services/pushbullet.js";

const settingKeySchema = z.string().regex(/^[a-z0-9_]{1,60}$/);

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/internal/admin/stats", async () => getStats());

  app.get("/internal/admin/bots", async (request) => {
    const query = request.query as { limit?: string };
    const limit = Number(query.limit ?? 100);
    return { bots: await listAllBots(Number.isFinite(limit) ? limit : 100) };
  });

  app.get("/internal/admin/bots/:id", async (request) => {
    const params = request.params as { id: string };
    return { bot: await getAdminBot(params.id) };
  });

  app.get("/internal/admin/bots/:id/logs", async (request) => {
    const params = request.params as { id: string };
    const query = request.query as { lines?: string };
    const lines = Number(query.lines ?? 200);
    return { logs: await botLogs(params.id, null, Number.isFinite(lines) ? lines : 200) };
  });

  app.get("/internal/admin/bots/:id/events", async (request) => {
    const params = request.params as { id: string };
    const query = request.query as { limit?: string };
    await getAdminBot(params.id);
    const limit = Number(query.limit ?? 50);
    return { events: await listBotEvents(params.id, Number.isFinite(limit) ? limit : 50) };
  });

  app.post("/internal/admin/bots/:id/restart", async (request) => {
    const params = request.params as { id: string };
    return { bot: await restartBot(params.id, null) };
  });

  app.post("/internal/admin/bots/:id/stop", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { admin?: string };
    const bot = await stopBot(params.id, null, { reason: "운영자에 의해 중지되었습니다." });
    return { bot, admin: optionalString(body.admin, 80) };
  });

  app.delete("/internal/admin/bots/:id", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { admin?: string };
    const admin = optionalString(body.admin, 80) ?? "operator";
    await deleteBot(params.id, admin, true);
    return { ok: true };
  });

  app.get("/internal/admin/payment-requests", async (request) => {
    const query = request.query as { status?: string; limit?: string };
    const limit = Number(query.limit ?? 50);
    return {
      requests: await listPaymentRequests({
        status: optionalString(query.status, 30),
        limit: Number.isFinite(limit) ? limit : 50,
      }),
    };
  });

  app.get("/internal/admin/payments", async (request) => {
    const query = request.query as { limit?: string; status?: string };
    const limit = Number(query.limit ?? 50);
    return {
      payments: await listPayments({
        limit: Number.isFinite(limit) ? limit : 50,
        status: optionalString(query.status, 40),
      }),
    };
  });

  app.post("/internal/admin/payments/:id/refund", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { admin?: string; reason?: string };
    const admin = optionalString(body.admin, 80) ?? "operator";
    const reason = requireString(body.reason, "환불 사유", 500);
    return refundPayment(params.id, `admin:${admin}`, reason);
  });

  app.get("/internal/admin/payment-notifications", async (request) => {
    const query = request.query as { status?: string; limit?: string };
    let builder = db()
      .from("payment_notifications")
      .select("id, source, kind, app_name, title, body, parsed_amount, parsed_depositor_name, parse_confidence, status, note, received_at")
      .order("received_at", { ascending: false })
      .limit(Math.min(Math.max(Number(query.limit ?? 30), 1), 100));
    if (query.status) builder = builder.eq("status", query.status);
    return { notifications: unwrap(await builder) };
  });

  app.post("/internal/admin/payment-requests/:id/approve", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { admin?: string };
    const admin = optionalString(body.admin, 80) ?? "operator";
    const result = await approvePaymentRequest(params.id, `admin:${admin}`, null);
    return result;
  });

  app.post("/internal/admin/payment-requests/:id/reject", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { admin?: string; reason?: string };
    const admin = optionalString(body.admin, 80) ?? "operator";
    const reason = requireString(body.reason, "거절 사유", 500);
    await rejectPaymentRequest(params.id, `admin:${admin}`, reason);
    return { ok: true };
  });

  app.post("/internal/admin/broadcast", async (request) => {
    const body = (request.body ?? {}) as { message?: string; title?: string };
    const message = requireString(body.message, "공지 내용", 1800);
    const title = optionalString(body.title, 100) ?? "호스팅 공지";
    const count = await broadcastNotice({ title, message });
    return { queued: count };
  });

  app.get("/internal/admin/settings", async () => ({ settings: await getAllSettings() }));

  app.put("/internal/admin/settings/:key", async (request) => {
    const params = request.params as { key: string };
    const key = parseInput(settingKeySchema, params.key);
    const body = (request.body ?? {}) as { value?: unknown; admin?: string };
    if (!("value" in body)) throw new AppError("validation_error", "value가 필요합니다.");
    await setSetting(key, body.value, optionalString(body.admin, 80) ?? "operator");
    return { ok: true };
  });

  app.get("/internal/admin/pushbullet", async () => pushbulletStatus());

  app.post("/internal/admin/payment-parser/preview", async (request) => {
    const body = (request.body ?? {}) as {
      title?: string;
      body?: string;
      appName?: string;
      source?: string;
    };
    const text = requireString(body.body, "알림 본문", 5000);
    const rules = parseBankParserRules(await getSetting<unknown>("bank_parsers", []));
    return {
      parsed: parseDepositNotification(
        { title: optionalString(body.title, 300), body: text, appName: optionalString(body.appName, 80), source: optionalString(body.source, 40) },
        rules,
      ),
    };
  });
}
