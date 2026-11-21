import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { constantTimeEqual } from "./crypto.js";
import { AppError } from "./errors.js";

function header(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export async function requireBotKey(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const provided = header(request, "x-bot-api-key");
  if (!provided || !constantTimeEqual(provided, config().BOT_API_KEY)) {
    throw new AppError("unauthorized", "관리 봇 인증에 실패했습니다.", 401);
  }
}

export async function requireAdminKey(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const provided = header(request, "x-admin-api-key");
  if (!provided || !constantTimeEqual(provided, config().ADMIN_API_KEY)) {
    throw new AppError("unauthorized", "관리자 인증에 실패했습니다.", 401);
  }
}

/** Discord user id that the management bot asserts on behalf of. */
export function actingUserId(request: FastifyRequest): string {
  const body = request.body as Record<string, unknown> | undefined;
  const query = request.query as Record<string, unknown> | undefined;
  const fromQuery = typeof query?.discordUserId === "string" ? query.discordUserId : undefined;
  const fromBody = typeof body?.discordUserId === "string" ? body.discordUserId : undefined;
  const value = fromQuery ?? fromBody ?? header(request, "x-discord-user-id");
  if (!value) {
    throw new AppError("missing_user", "디스코드 사용자 ID가 필요합니다.", 400);
  }
  return value;
}
