import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { ZodError } from "zod";
import { LIMITS } from "@hostbot/shared";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { AppError } from "./lib/errors.js";
import { requireAdminKey, requireBotKey } from "./lib/auth.js";
import { registerBotRoutes } from "./routes/bots.js";
import { registerPaymentRoutes } from "./routes/payments.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { pushbulletStatus } from "./services/pushbullet.js";

export async function buildApp() {
  const cfg = config();
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    requestTimeout: 120_000,
  });

  if (cfg.WORKER_PROXY_SECRET) {
    app.addHook("onRequest", async (request, reply) => {
      const matches = (provided: string | string[] | undefined, expected: string): boolean => {
        if (typeof provided !== "string") return false;
        const actualBytes = Buffer.from(provided);
        const expectedBytes = Buffer.from(expected);
        return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
      };
      const gatewayAuthorized = matches(request.headers["x-hostbot-proxy-secret"], cfg.WORKER_PROXY_SECRET);
      const botAuthorized = matches(request.headers["x-bot-api-key"], cfg.BOT_API_KEY);
      const adminAuthorized = matches(request.headers["x-admin-api-key"], cfg.ADMIN_API_KEY);
      if (!gatewayAuthorized && !botAuthorized && !adminAuthorized) {
        return reply.code(401).send({
          error: { code: "invalid_gateway_secret", message: "API gateway authentication required." },
        });
      }
    });
  }

  await app.register(multipart, {
    limits: {
      fileSize: LIMITS.zipBytes + 1024 * 1024,
      files: 1,
      fields: 20,
      parts: 25,
    },
  });

  if (cfg.CORS_ORIGIN.trim()) {
    const origins = cfg.CORS_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean);
    await app.register(cors, { origin: origins, credentials: false });
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      void reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }
    if (error instanceof ZodError) {
      void reply.code(400).send({
        error: {
          code: "validation_error",
          message: error.issues[0]?.message ?? "입력값이 올바르지 않습니다.",
          details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        },
      });
      return;
    }
    const code = (error as { code?: string }).code;
    if (code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT") {
      void reply.code(413).send({
        error: {
          code: "file_too_large",
          message: `ZIP 파일은 ${Math.round(LIMITS.zipBytes / 1024 / 1024)}MB 이하여야 합니다.`,
        },
      });
      return;
    }
    if (code === "FST_INVALID_MULTIPART_CONTENT_TYPE") {
      void reply.code(400).send({
        error: { code: "invalid_content_type", message: "multipart/form-data 요청이 필요합니다." },
      });
      return;
    }

    logger.error({ err: error, url: request.url, requestId: request.id }, "unhandled request error");
    void reply.code(500).send({
      error: {
        code: "internal_error",
        message:
          cfg.NODE_ENV === "production"
            ? "서버 내부 오류가 발생했습니다. 잠시 후 다시 시도해 주세요."
            : error instanceof Error
              ? error.message
              : String(error),
      },
    });
  });

  app.get("/health", async () => ({
    ok: true,
    service: "hostbot-api",
    time: new Date().toISOString(),
    dockerEnabled: cfg.DOCKER_ENABLED,
    pushbullet: pushbulletStatus(),
  }));

  await app.register(async (scope) => {
    scope.addHook("preHandler", requireBotKey);
    await registerBotRoutes(scope);
    await registerPaymentRoutes(scope);
    await registerNotificationRoutes(scope);
  });

  await app.register(async (scope) => {
    scope.addHook("preHandler", requireAdminKey);
    await registerAdminRoutes(scope);
  });

  await app.register(registerWebhookRoutes);

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: { code: "not_found", message: `경로를 찾을 수 없습니다: ${request.method} ${request.url}` },
    });
  });

  return app;
}
