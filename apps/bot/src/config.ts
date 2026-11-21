import { z } from "zod";

const schema = z.object({
  DISCORD_TOKEN: z.string().min(20),
  DISCORD_CLIENT_ID: z.string().regex(/^\d{5,25}$/),
  MANAGEMENT_GUILD_ID: z.string().regex(/^\d{5,25}$/),
  ADMIN_DISCORD_IDS: z.string().default(""),
  ADMIN_LOG_CHANNEL_ID: z.string().default(""),
  DISCORD_DEV_GUILD_ID: z.string().default(""),
  API_BASE_URL: z.string().url().default("http://localhost:3001"),
  BOT_API_KEY: z.string().min(24),
  ADMIN_API_KEY: z.string().min(24),
  BOT_API_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(180_000).default(60_000),
});

export interface BotConfig {
  token: string;
  clientId: string;
  managementGuildId: string;
  adminDiscordIds: Set<string>;
  adminLogChannelId: string;
  devGuildId: string;
  apiBaseUrl: string;
  botApiKey: string;
  adminApiKey: string;
  apiTimeoutMs: number;
}

let value: BotConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n  ");
    throw new Error(`Invalid bot environment:\n  ${issues}`);
  }
  const data = parsed.data;
  value = {
    token: data.DISCORD_TOKEN,
    clientId: data.DISCORD_CLIENT_ID,
    managementGuildId: data.MANAGEMENT_GUILD_ID,
    adminDiscordIds: new Set(
      data.ADMIN_DISCORD_IDS.split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
    adminLogChannelId: data.ADMIN_LOG_CHANNEL_ID.trim(),
    devGuildId: data.DISCORD_DEV_GUILD_ID.trim(),
    apiBaseUrl: data.API_BASE_URL.replace(/\/+$/, ""),
    botApiKey: data.BOT_API_KEY,
    adminApiKey: data.ADMIN_API_KEY,
    apiTimeoutMs: data.BOT_API_TIMEOUT_MS,
  };
  return value;
}

export function config(): BotConfig {
  if (!value) throw new Error("Bot configuration has not been loaded");
  return value;
}
