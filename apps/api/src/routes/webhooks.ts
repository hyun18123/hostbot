import type { FastifyInstance } from "fastify";
import { pushWebhookSchema } from "@hostbot/shared";
import { config } from "../config.js";
import { constantTimeEqual } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { processDepositNotification } from "../services/payments.js";

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/webhooks/notifications/:secret", async (request, reply) => {
    const expected = config().NOTIFICATION_WEBHOOK_SECRET;
    if (!expected) {
      throw new AppError("webhook_disabled", "알림 웹훅이 설정되어 있지 않습니다.", 404);
    }
    const params = request.params as { secret: string };
    if (!constantTimeEqual(params.secret, expected)) {
      throw new AppError("unauthorized", "웹훅 인증에 실패했습니다.", 401);
    }
    const body = pushWebhookSchema.parse(request.body ?? {});
    const result = await processDepositNotification({
      source: body.source,
      eventId: body.eventId,
      appName: body.appName,
      title: body.title,
      body: body.body,
      receivedAt: body.receivedAt ? new Date(body.receivedAt) : new Date(),
      raw: body as unknown as Record<string, unknown>,
    }).catch((error) => {
      logger.error({ err: error }, "webhook notification processing failed");
      throw error;
    });

    reply.code(202);
    return { ok: true, outcome: result.outcome };
  });
}
