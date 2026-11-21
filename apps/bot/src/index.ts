import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: process.env.ENV_FILE ?? path.resolve(process.cwd(), "../../.env") });
dotenv.config();

const { loadConfig } = await import("./config.js");
const config = loadConfig();

const { Client, GatewayIntentBits, ActivityType } = await import("discord.js");
const { ApiClient } = await import("./api.js");
const { logger } = await import("./logger.js");
const { registerInteractionHandler } = await import("./interactions.js");
const { startNotificationPoller } = await import("./notifications.js");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const api = new ApiClient();
registerInteractionHandler(client, api);

let stopPoller: (() => void) | null = null;
let shuttingDown = false;

client.once("ready", () => {
  logger.info(
    { user: client.user?.tag, guilds: client.guilds.cache.size, guildId: config.managementGuildId },
    "management bot ready",
  );
  client.user?.setPresence({
    status: "online",
    activities: [{ name: "봇 호스팅 관리", type: ActivityType.Watching }],
  });
  stopPoller = startNotificationPoller(client, api);
});

client.on("error", (error) => logger.error({ err: error }, "discord client error"));
client.on("warn", (message) => logger.warn({ message }, "discord client warning"));

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down management bot");
  stopPoller?.();
  await client.destroy();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "unhandled rejection"));
process.on("uncaughtException", (error) => logger.fatal({ err: error }, "uncaught exception"));

try {
  await client.login(config.token);
} catch (error) {
  logger.fatal({ err: error }, "failed to login to Discord");
  process.exit(1);
}
