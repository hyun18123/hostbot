import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseInput } from "../lib/http.js";
import {
  acknowledgeNotifications,
  takePendingNotifications,
} from "../services/notifications.js";

const ackSchema = z.object({
  ids: z.array(z.number().int().positive()).max(50),
  success: z.boolean().default(true),
  error: z.string().max(1000).optional(),
});

export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/internal/notifications", async (request) => {
    const query = request.query as { limit?: string };
    const limit = Number(query.limit ?? 20);
    return { notifications: await takePendingNotifications(Number.isFinite(limit) ? limit : 20) };
  });

  app.post("/internal/notifications/ack", async (request) => {
    const body = parseInput(ackSchema, request.body ?? {});
    await acknowledgeNotifications(body.ids, body.success, body.error);
    return { ok: true };
  });
}
