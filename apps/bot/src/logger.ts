import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "hostbot-management-bot" },
  redact: {
    paths: ["*.token", "*.body.token", "token"],
    censor: "[REDACTED]",
  },
});
