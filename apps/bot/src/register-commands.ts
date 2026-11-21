import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: process.env.ENV_FILE ?? path.resolve(process.cwd(), "../../.env") });
dotenv.config();

const { loadConfig } = await import("./config.js");
const { commandsJson } = await import("./definitions.js");

const config = loadConfig();

const { REST, Routes } = await import("discord.js");

const rest = new REST({ version: "10" }).setToken(config.token);
const body = commandsJson();

try {
  if (config.devGuildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.devGuildId), { body });
    console.log(`Registered ${body.length} guild commands in ${config.devGuildId}`);
  } else {
    await rest.put(Routes.applicationCommands(config.clientId), { body });
    console.log(`Registered ${body.length} global commands (propagation may take up to 1 hour)`);
  }
} catch (error) {
  console.error("Failed to register commands:", error);
  process.exit(1);
}
