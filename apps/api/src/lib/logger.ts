import pino from "pino";

/** Logger must not depend on loadConfig(), because it is imported at module load. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers['x-bot-api-key']",
      "req.headers['x-admin-api-key']",
      "*.token",
      "*.tokenEncrypted",
      "*.body.token",
    ],
    censor: "[REDACTED]",
  },
  base: { service: "hostbot-api" },
});
