import { z } from "zod";

export const discordIdSchema = z
  .string()
  .regex(/^\d{5,25}$/, "올바른 디스코드 ID가 아닙니다.");

export const botNameSchema = z
  .string()
  .trim()
  .min(1, "봇 이름을 입력해 주세요.")
  .max(40, "봇 이름은 40자 이하여야 합니다.");

export const depositorNameSchema = z
  .string()
  .trim()
  .min(1, "입금자명을 입력해 주세요.")
  .max(30, "입금자명은 30자 이하여야 합니다.");

export const botTokenSchema = z
  .string()
  .trim()
  .min(20, "봇 토큰이 너무 짧습니다.")
  .max(200, "봇 토큰이 너무 깁니다.")
  .regex(/^[A-Za-z0-9_.-]+$/, "봇 토큰에 허용되지 않는 문자가 있습니다.");

export const registerBotFieldsSchema = z.object({
  discordUserId: discordIdSchema,
  discordUsername: z.string().trim().min(1).max(80),
  guildId: discordIdSchema,
  name: botNameSchema,
  token: botTokenSchema,
  entrypoint: z.string().trim().max(200).optional(),
});

export const createPaymentRequestSchema = z.object({
  discordUserId: discordIdSchema,
  botId: z.string().uuid(),
  depositorName: depositorNameSchema,
  months: z.number().int().min(1).max(3).default(1),
});

export const pushWebhookSchema = z.object({
  source: z.string().trim().min(1).max(40).default("android"),
  appName: z.string().trim().max(80).optional(),
  title: z.string().trim().max(300).optional(),
  body: z.string().trim().max(2000),
  receivedAt: z.string().datetime().optional(),
  eventId: z.string().trim().max(200).optional(),
});
