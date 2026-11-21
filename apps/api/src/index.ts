import dotenv from "dotenv";

dotenv.config();

const { loadConfig } = await import("./config.js");
const config = loadConfig();

const { logger } = await import("./lib/logger.js");
const { ensureDataDirs } = await import("./services/storage.js");
const { initDocker } = await import("./services/docker.js");
const { buildApp } = await import("./app.js");
const { startScheduler, stopScheduler } = await import("./services/scheduler.js");
const { startPushbullet, stopPushbullet } = await import("./services/pushbullet.js");

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled promise rejection");
});
process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "uncaught exception");
});

try {
  await ensureDataDirs();
  await initDocker();
  if (config.NODE_ENV === "production" && !config.DOCKER_ENABLED) {
    logger.warn("DOCKER_ENABLED=false in production - customer bots will not actually run");
  }

  const app = await buildApp();
  startScheduler();
  startPushbullet();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    stopScheduler();
    stopPushbullet();
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info(
    {
      port: config.PORT,
      docker: config.DOCKER_ENABLED,
      pushbullet: Boolean(config.PUSHBULLET_ACCESS_TOKEN),
      dataDir: config.dataDir,
    },
    "hostbot api listening",
  );
} catch (error) {
  logger.fatal({ err: error }, "failed to start API");
  process.exit(1);
}
