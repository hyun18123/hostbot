import type { AutocompleteInteraction } from "discord.js";
import { BOT_STATUS_LABELS, type BotDto } from "@hostbot/shared";
import type { ApiClient } from "../api.js";
import { config } from "../config.js";

export async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  api: ApiClient,
): Promise<void> {
  try {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "bot") {
      await interaction.respond([]);
      return;
    }

    const adminCommand = interaction.commandName === "관리자";
    if (adminCommand && !config().adminDiscordIds.has(interaction.user.id)) {
      await interaction.respond([]);
      return;
    }

    let bots: BotDto[] = [];
    if (adminCommand) {
      bots = (await api.adminBots(200)).bots;
    } else if (interaction.commandName === "호스팅" || interaction.commandName === "결제") {
      bots = (await api.listBots(interaction.user.id)).bots;
    }

    const search = String(focused.value).toLowerCase();
    const choices = bots
      .filter(
        (bot) =>
          bot.name.toLowerCase().includes(search) ||
          bot.id.toLowerCase().includes(search) ||
          (BOT_STATUS_LABELS[bot.status] ?? "").includes(search),
      )
      .slice(0, 25)
      .map((bot) => ({
        name: `${bot.name} · ${BOT_STATUS_LABELS[bot.status] ?? bot.status}`.slice(0, 100),
        value: bot.id,
      }));

    await interaction.respond(choices);
  } catch {
    if (!interaction.responded) {
      await interaction.respond([]).catch(() => undefined);
    }
  }
}
