import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  LIMITS,
  botNameSchema,
  botTokenSchema,
  depositorNameSchema,
  discordIdSchema,
  type PaymentRequestDto,
} from "@hostbot/shared";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { parseInput } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import {
  botLogs,
  deleteBot,
  getOwnedBot,
  listBotsForDiscord,
  mapBot,
  registerBot,
  restartBot,
  startBot,
  stopBot,
} from "../services/bots.js";
import { createPaymentRequest } from "../services/payments.js";
import { getBankInfo } from "../services/settings.js";

interface MultipartUpload {
  fields: Record<string, string>;
  filePath: string;
  filename: string;
}

async function readUpload(request: FastifyRequest): Promise<MultipartUpload> {
  const fields: Record<string, string> = {};
  let filePath: string | null = null;
  let filename = "bot.zip";

  try {
    const parts = request.parts();
    for await (const part of parts) {
      if (part.type === "file") {
        if (filePath) {
          part.file.resume();
          throw new AppError("too_many_files", "ZIP 파일은 하나만 업로드할 수 있습니다.");
        }
        if (part.fieldname !== "file") {
          part.file.resume();
          throw new AppError("validation_error", "ZIP 파일 필드 이름은 file이어야 합니다.");
        }
        filename = path.basename(part.filename || "bot.zip").slice(0, 200);
        filePath = path.join(config().tempDir, `${randomUUID()}.zip`);
        await pipeline(part.file, createWriteStream(filePath, { flags: "wx", mode: 0o600 }));
        if (part.file.truncated) {
          throw new AppError(
            "zip_too_large",
            `ZIP 파일은 ${Math.round(LIMITS.zipBytes / 1024 / 1024)}MB 이하여야 합니다.`,
          );
        }
      } else if (typeof part.value === "string") {
        fields[part.fieldname] = part.value;
      }
    }
  } catch (error) {
    if (filePath) await fs.rm(filePath, { force: true });
    throw error;
  }

  if (!filePath) {
    throw new AppError("zip_required", "ZIP 파일을 첨부해 주세요.");
  }
  return { fields, filePath, filename };
}

export async function registerBotRoutes(app: FastifyInstance): Promise<void> {
  app.post("/internal/bots", async (request) => {
    if (!request.isMultipart()) {
      throw new AppError("invalid_content_type", "multipart/form-data 요청이 필요합니다.");
    }

    const upload = await readUpload(request);
    try {
      const fields = upload.fields;
      const discordUserId = parseInput(discordIdSchema, fields.discordUserId);
      const guildId = parseInput(discordIdSchema, fields.guildId);
      const discordUsername = String(fields.discordUsername ?? "").slice(0, 80) || "unknown";
      const name = parseInput(botNameSchema, fields.name);
      const token = parseInput(botTokenSchema, fields.token);
      const depositorName = parseInput(depositorNameSchema, fields.depositorName);

      const registration = await registerBot({
        discordUserId,
        discordUsername,
        guildId,
        name,
        token,
        depositorName,
        zipPath: upload.filePath,
        originalFilename: upload.filename,
      });

      const payment = await createPaymentRequest({
        discordUserId,
        botId: registration.bot.id,
        depositorName,
        months: 1,
      });
      const bank = await getBankInfo();

      return {
        bot: mapBot(registration.bot),
        paymentRequest: payment.request,
        bank: {
          bankName: bank.bankName,
          accountNumber: bank.accountNumber,
          accountHolder: bank.accountHolder,
          amount: payment.request.amount,
          depositorName: payment.request.depositorName,
          requestCode: payment.request.code,
          expiresAt: payment.request.expiresAt,
        },
      };
    } finally {
      await fs.rm(upload.filePath, { force: true }).catch(() => undefined);
    }
  });

  app.get("/internal/bots", async (request) => {
    const query = request.query as { discordUserId?: string };
    const discordUserId = parseInput(discordIdSchema, query.discordUserId);
    return { bots: await listBotsForDiscord(discordUserId) };
  });

  app.get("/internal/bots/:id", async (request) => {
    const params = request.params as { id: string };
    const query = request.query as { discordUserId?: string };
    const discordUserId = parseInput(discordIdSchema, query.discordUserId);
    const bot = await getOwnedBot(params.id, discordUserId);
    return { bot: mapBot(bot) };
  });

  app.post("/internal/bots/:id/start", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { discordUserId?: string };
    const discordUserId = parseInput(discordIdSchema, body.discordUserId);
    return { bot: await startBot(params.id, discordUserId) };
  });

  app.post("/internal/bots/:id/stop", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { discordUserId?: string };
    const discordUserId = parseInput(discordIdSchema, body.discordUserId);
    return { bot: await stopBot(params.id, discordUserId) };
  });

  app.post("/internal/bots/:id/restart", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { discordUserId?: string };
    const discordUserId = parseInput(discordIdSchema, body.discordUserId);
    return { bot: await restartBot(params.id, discordUserId) };
  });

  app.get("/internal/bots/:id/logs", async (request) => {
    const params = request.params as { id: string };
    const query = request.query as { discordUserId?: string; lines?: string };
    const discordUserId = parseInput(discordIdSchema, query.discordUserId);
    const lines = Number(query.lines ?? 100);
    return { logs: await botLogs(params.id, discordUserId, Number.isFinite(lines) ? lines : 100) };
  });

  app.delete("/internal/bots/:id", async (request) => {
    const params = request.params as { id: string };
    const query = request.query as { discordUserId?: string };
    const discordUserId = parseInput(discordIdSchema, query.discordUserId);
    await deleteBot(params.id, discordUserId, false);
    return { ok: true };
  });

  app.post("/internal/bots/:id/payment-request", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const discordUserId = parseInput(discordIdSchema, body.discordUserId);
    const depositorName = parseInput(depositorNameSchema, body.depositorName);
    const months = Number(body.months ?? 1);
    const result = await createPaymentRequest({
      discordUserId,
      botId: params.id,
      depositorName,
      months: Number.isFinite(months) ? months : 1,
    });
    return {
      paymentRequest: result.request satisfies PaymentRequestDto,
      bank: {
        bankName: result.bank.bankName,
        accountNumber: result.bank.accountNumber,
        accountHolder: result.bank.accountHolder,
        instructions: result.bank.instructions,
      },
    };
  });

  logger.info("bot routes registered");
}
