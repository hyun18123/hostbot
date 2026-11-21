import path from "node:path";
import { z } from "zod";

const boolFromEnv = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false", "1", "0"])
    .default(defaultValue)
    .transform((value) => value === "true" || value === "1");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  HOST: z.string().default("0.0.0.0"),
  API_PUBLIC_URL: z.string().url().default("http://localhost:3001"),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  BOT_API_KEY: z.string().min(24),
  ADMIN_API_KEY: z.string().min(24),
  TOKEN_ENCRYPTION_KEY: z.string().min(20),

  DATA_DIR: z.string().default("./data"),

  DOCKER_ENABLED: boolFromEnv("false"),
  DOCKER_SOCKET_PATH: z.string().default("/var/run/docker.sock"),
  BOT_RUNTIME_IMAGE: z.string().default("hostbot/runtime-node:22"),
  BOT_MEMORY_MB: z.coerce.number().int().min(64).max(8192).default(256),
  BOT_CPU_LIMIT: z.coerce.number().min(0.1).max(8).default(0.5),
  BOT_PIDS_LIMIT: z.coerce.number().int().min(32).max(4096).default(128),
  BOT_STORAGE_MB: z.coerce.number().int().min(16).max(10_240).default(200),
  BOT_LOG_TAIL_LINES: z.coerce.number().int().min(10).max(1000).default(150),
  INSTALL_TIMEOUT_MS: z.coerce.number().int().min(30_000).default(600_000),
  START_TIMEOUT_MS: z.coerce.number().int().min(5_000).default(60_000),

  PAYMENT_DEDUPE_WINDOW_MINUTES: z.coerce.number().int().min(1).max(120).default(10),
  PAYMENT_REQUEST_DAYS: z.coerce.number().int().min(1).max(30).default(7),

  PUSHBULLET_ACCESS_TOKEN: z.string().optional().default(""),
  NOTIFICATION_WEBHOOK_SECRET: z.string().optional().default(""),

  BANK_NAME: z.string().default("국민은행"),
  BANK_ACCOUNT_NUMBER: z.string().default("000000-00-000000"),
  BANK_ACCOUNT_HOLDER: z.string().default("예금주"),

  DISCORD_API_BASE: z.string().url().default("https://discord.com/api/v10"),
  DISCORD_BOT_VALIDATION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),

  DATA_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),

  CORS_ORIGIN: z.string().optional().default(""),
});

export type AppConfig = z.infer<typeof envSchema> & {
  dataDir: string;
  botsDir: string;
  tempDir: string;
  tokenKey: Buffer;
};

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n  ");
    throw new Error(`Invalid environment configuration:\n  ${issues}`);
  }

  const value = parsed.data;
  let tokenKey: Buffer;
  try {
    tokenKey = Buffer.from(value.TOKEN_ENCRYPTION_KEY, "base64");
  } catch {
    throw new Error("TOKEN_ENCRYPTION_KEY must be valid base64");
  }

  if (tokenKey.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${tokenKey.length}). ` +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }

  if (value.BOT_API_KEY === value.ADMIN_API_KEY) {
    throw new Error("BOT_API_KEY and ADMIN_API_KEY must be different secrets");
  }

  const dataDir = path.resolve(value.DATA_DIR);
  const config: AppConfig = {
    ...value,
    dataDir,
    botsDir: path.join(dataDir, "bots"),
    tempDir: path.join(dataDir, "tmp"),
    tokenKey,
  };

  if (value.NODE_ENV === "production" && value.DOCKER_ENABLED && !value.BOT_RUNTIME_IMAGE) {
    throw new Error("BOT_RUNTIME_IMAGE is required when Docker is enabled");
  }

  cached = config;
  return config;
}

export function config(): AppConfig {
  if (!cached) throw new Error("Configuration has not been loaded");
  return cached;
}
