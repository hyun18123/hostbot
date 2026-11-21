import type { Client, Interaction } from "discord.js";
import type { ApiClient } from "./api.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { handleAdminCommand } from "./handlers/admin.js";
import { handleAutocomplete } from "./handlers/autocomplete.js";
import {
  beginPayment,
  handleHostingCommand,
  handlePaymentModal,
  handleRegisterModal,
  showPaymentStatus,
  showPricing,
} from "./handlers/hosting.js";
import { errorEmbed } from "./ui.js";

export function registerInteractionHandler(client: Client, api: ApiClient): void {
  client.on("interactionCreate", (interaction) => {
    void handleInteraction(interaction, api).catch(async (error) => {
      logger.error({ err: error }, "interaction handler failed");
      await safeError(interaction, "명령어 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    });
  });
}

async function handleInteraction(interaction: Interaction, api: ApiClient): Promise<void> {
  const cfg = config();

  if (
    interaction.isChatInputCommand() ||
    interaction.isAutocomplete() ||
    interaction.isModalSubmit()
  ) {
    if (interaction.guildId !== cfg.managementGuildId) {
      if (interaction.isAutocomplete()) {
        await interaction.respond([]).catch(() => undefined);
      } else if (interaction.isRepliable() && !interaction.replied) {
        await interaction
          .reply({
            embeds: [errorEmbed("이 봇은 운영자 서버에서만 사용할 수 있습니다.")],
            ephemeral: true,
          })
          .catch(() => undefined);
      }
      return;
    }
  }

  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "관리자" && !cfg.adminDiscordIds.has(interaction.user.id)) {
      await interaction.reply({
        embeds: [errorEmbed("관리자만 사용할 수 있는 명령어입니다.")],
        ephemeral: true,
      });
      return;
    }

    switch (interaction.commandName) {
      case "호스팅":
        await handleHostingCommand(interaction, api);
        break;
      case "결제":
        if (interaction.options.getSubcommand(true) === "신청") await beginPayment(interaction, api);
        else await showPaymentStatus(interaction, api);
        break;
      case "요금제":
        await showPricing(interaction, api);
        break;
      case "관리자":
        await handleAdminCommand(interaction, api);
        break;
      default:
        await interaction.reply({ embeds: [errorEmbed("알 수 없는 명령어입니다.")], ephemeral: true });
    }
    return;
  }

  if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction, api);
    return;
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith("hostbot:register:")) {
      await handleRegisterModal(interaction, api);
      return;
    }
    if (interaction.customId.startsWith("hostbot:payment:")) {
      await handlePaymentModal(interaction, api);
      return;
    }
  }
}

async function safeError(interaction: Interaction, message: string): Promise<void> {
  if (!interaction.isRepliable()) return;
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ embeds: [errorEmbed(message)], ephemeral: true });
    } else {
      await interaction.reply({ embeds: [errorEmbed(message)], ephemeral: true });
    }
  } catch {
    // interaction token expired; nothing else to do
  }
}
