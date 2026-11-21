/**
 * Small, safe subset of environment values that do not require full validation.
 * Used by modules imported before loadConfig() (logger, notifications).
 */
export const env = {
  ADMIN_LOG_CHANNEL_ID: process.env.ADMIN_LOG_CHANNEL_ID ?? "",
  NODE_ENV: process.env.NODE_ENV ?? "development",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
};
