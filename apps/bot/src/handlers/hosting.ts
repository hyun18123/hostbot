import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import {
  LIMITS,
  botNameSchema,
  depositorNameSchema,
  formatKrw,
} from "@hostbot/shared";
import { ApiError, type ApiClient } from "../api.js";
import { takePendingUpload, putPendingUpload } from "../upload-cache.js";
import {
  botEmbed,
  botListEmbed,
  codeBlock,
  errorEmbed,
  okEmbed,
  paymentRequestEmbed,
  paymentStatusEmbed,
  splitMessage,
  statusEmoji,
} from "../ui.js";

export async function handleHostingCommand(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand(true);

  switch (subcommand) {
    case "등록":
      return beginRegistration(interaction);
    case "목록":
      return listBots(interaction, api);
    case "정보":
      return showBot(interaction, api);
    case "시작":
      return startBot(interaction, api);
    case "종료":
      return stopBot(interaction, api);
    case "재시작":
      return restartBot(interaction, api);
    case "로그":
      return showLogs(interaction, api);
    default:
      await interaction.reply({ content: "알 수 없는 하위 명령어입니다.", ephemeral: true });
  }
}

async function beginRegistration(interaction: ChatInputCommandInteraction): Promise<void> {
  const attachment = interaction.options.getAttachment("zip", true);
  if (attachment.size > LIMITS.zipBytes) {
    await interaction.reply({
      embeds: [errorEmbed(`ZIP 파일은 ${Math.round(LIMITS.zipBytes / 1024 / 1024)}MB 이하여야 합니다.`)],
      ephemeral: true,
    });
    return;
  }
  if (!interaction.guildId) {
    await interaction.reply({ content: "서버에서만 사용할 수 있습니다.", ephemeral: true });
    return;
  }

  const key = randomUUID();
  putPendingUpload(key, {
    url: attachment.url,
    filename: attachment.name,
    size: attachment.size,
    guildId: interaction.guildId,
    userId: interaction.user.id,
  });

  const modal = new ModalBuilder()
    .setCustomId(`hostbot:register:${key}`)
    .setTitle("봇 호스팅 등록")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("name")
          .setLabel("봇 이름 (관리용)")
          .setPlaceholder("예: 음악봇")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(40)
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("token")
          .setLabel("디스코드 봇 토큰")
          .setPlaceholder("디스코드 개발자 포털의 Bot 토큰")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(LIMITS.tokenLength)
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("depositor")
          .setLabel("입금자명")
          .setPlaceholder("실제 입금할 때 사용할 이름")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(30)
          .setRequired(true),
      ),
    );

  await interaction.showModal(modal);
}

export async function handleRegisterModal(
  interaction: ModalSubmitInteraction,
  api: ApiClient,
): Promise<void> {
  const key = interaction.customId.split(":")[2];
  const upload = key ? takePendingUpload(key) : null;
  if (!upload || upload.userId !== interaction.user.id) {
    await interaction.reply({
      embeds: [errorEmbed("등록 요청이 만료되었습니다. `/호스팅 등록`을 다시 실행해 주세요.")],
      ephemeral: true,
    });
    return;
  }

  const nameResult = botNameSchema.safeParse(interaction.fields.getTextInputValue("name"));
  const depositorResult = depositorNameSchema.safeParse(
    interaction.fields.getTextInputValue("depositor"),
  );
  const token = interaction.fields.getTextInputValue("token").trim();

  if (!nameResult.success) {
    await interaction.reply({ embeds: [errorEmbed(nameResult.error.issues[0]?.message ?? "봇 이름 오류")], ephemeral: true });
    return;
  }
  if (!depositorResult.success) {
    await interaction.reply({
      embeds: [errorEmbed(depositorResult.error.issues[0]?.message ?? "입금자명 오류")],
      ephemeral: true,
    });
    return;
  }
  if (!token || token.length > LIMITS.tokenLength) {
    await interaction.reply({ embeds: [errorEmbed("봇 토큰이 올바르지 않습니다.")], ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const response = await fetch(upload.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new Error(`첨부 파일을 내려받지 못했습니다. (HTTP ${response.status})`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > LIMITS.zipBytes) {
      throw new Error("ZIP 파일이 허용 크기를 초과했습니다.");
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > LIMITS.zipBytes) {
      throw new Error("ZIP 파일이 허용 크기를 초과했습니다.");
    }

    const form = new FormData();
    form.append("discordUserId", interaction.user.id);
    form.append("discordUsername", interaction.user.username);
    form.append("guildId", upload.guildId);
    form.append("name", nameResult.data);
    form.append("token", token);
    form.append("depositorName", depositorResult.data);
    form.append("file", new Blob([buffer], { type: "application/zip" }), upload.filename);

    const result = await api.registerBot(form);
    const embed = paymentRequestEmbed(result.paymentRequest, result.bank);
    embed.setTitle("✅ 봇 등록 완료 · 입금 안내");
    embed.setDescription(
      `${result.bot.name} 봇이 등록되었습니다.\n아래 계좌로 **${formatKrw(result.paymentRequest.amount)}**을 입금하면 자동으로 승인되고 봇이 시작됩니다.`,
    );
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "등록에 실패했습니다.";
    await interaction.editReply({ embeds: [errorEmbed(message)] });
  }
}

async function listBots(interaction: ChatInputCommandInteraction, api: ApiClient): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  try {
    const { bots } = await api.listBots(interaction.user.id);
    await interaction.editReply({ embeds: [botListEmbed(bots)] });
  } catch (error) {
    await interaction.editReply({ embeds: [errorEmbed(errorMessage(error))] });
  }
}

async function requireBot(interaction: ChatInputCommandInteraction): Promise<string | null> {
  const botId = interaction.options.getString("bot", true);
  if (!/^[0-9a-f-]{36}$/i.test(botId)) {
    await interaction.reply({ embeds: [errorEmbed("봇을 목록에서 선택해 주세요.")], ephemeral: true });
    return null;
  }
  return botId;
}

async function showBot(interaction: ChatInputCommandInteraction, api: ApiClient): Promise<void> {
  const botId = await requireBot(interaction);
  if (!botId) return;
  await interaction.deferReply({ ephemeral: true });
  try {
    const { bot } = await api.getBot(botId, interaction.user.id);
    await interaction.editReply({ embeds: [botEmbed(bot)] });
  } catch (error) {
    await interaction.editReply({ embeds: [errorEmbed(errorMessage(error))] });
  }
}

async function startBot(interaction: ChatInputCommandInteraction, api: ApiClient): Promise<void> {
  const botId = await requireBot(interaction);
  if (!botId) return;
  await interaction.deferReply({ ephemeral: true });
  try {
    const { bot } = await api.startBot(botId, interaction.user.id);
    await interaction.editReply({
      embeds: [
        okEmbed(
          `${statusEmoji(bot.status)} 시작 요청 완료`,
          `${bot.name} 봇을 시작합니다.\n의존성 설치와 실행에 수십 초가 걸릴 수 있습니다. \`/호스팅 정보\`로 상태를 확인하세요.`,
        ),
      ],
    });
  } catch (error) {
    await interaction.editReply({ embeds: [errorEmbed(errorMessage(error))] });
  }
}

async function stopBot(interaction: ChatInputCommandInteraction, api: ApiClient): Promise<void> {
  const botId = await requireBot(interaction);
  if (!botId) return;
  await interaction.deferReply({ ephemeral: true });
  try {
    const { bot } = await api.stopBot(botId, interaction.user.id);
    await interaction.editReply({ embeds: [okEmbed("봇 중지", `${bot.name} 봇을 중지했습니다.`)] });
  } catch (error) {
    await interaction.editReply({ embeds: [errorEmbed(errorMessage(error))] });
  }
}

async function restartBot(interaction: ChatInputCommandInteraction, api: ApiClient): Promise<void> {
  const botId = await requireBot(interaction);
  if (!botId) return;
  await interaction.deferReply({ ephemeral: true });
  try {
    const { bot } = await api.restartBot(botId, interaction.user.id);
    await interaction.editReply({
      embeds: [okEmbed("재시작 요청", `${bot.name} 봇을 재시작합니다. 잠시 후 상태를 확인해 주세요.`)],
    });
  } catch (error) {
    await interaction.editReply({ embeds: [errorEmbed(errorMessage(error))] });
  }
}

async function showLogs(interaction: ChatInputCommandInteraction, api: ApiClient): Promise<void> {
  const botId = await requireBot(interaction);
  if (!botId) return;
  const lines = interaction.options.getInteger("lines") ?? 100;
  await interaction.deferReply({ ephemeral: true });
  try {
    const { logs } = await api.logs(botId, interaction.user.id, lines);
    const trimmed = logs.length > 12_000 ? `...(앞부분 생략)...\n${logs.slice(-12_000)}` : logs;
    const chunks = splitMessage(codeBlock(trimmed || "(로그가 없습니다)"));
    await interaction.editReply({ content: chunks[0] ?? "(로그가 없습니다)" });
    for (const chunk of chunks.slice(1, 5)) {
      await interaction.followUp({ content: chunk, ephemeral: true });
    }
  } catch (error) {
    await interaction.editReply({ embeds: [errorEmbed(errorMessage(error))] });
  }
}

export async function beginPayment(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  const botId = interaction.options.getString("bot", true);
  const months = interaction.options.getInteger("months") ?? 1;
  if (!/^[0-9a-f-]{36}$/i.test(botId)) {
    await interaction.reply({ embeds: [errorEmbed("봇을 목록에서 선택해 주세요.")], ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`hostbot:payment:${botId}:${months}`)
    .setTitle("결제 신청")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("depositor")
          .setLabel("입금자명")
          .setPlaceholder("실제 입금할 때 사용할 이름")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(30)
          .setRequired(true),
      ),
    );
  await interaction.showModal(modal);
}

export async function handlePaymentModal(
  interaction: ModalSubmitInteraction,
  api: ApiClient,
): Promise<void> {
  const [, , botId, monthsRaw] = interaction.customId.split(":");
  if (!botId || !/^[0-9a-f-]{36}$/i.test(botId)) {
    await interaction.reply({ embeds: [errorEmbed("잘못된 요청입니다.")], ephemeral: true });
    return;
  }
  const depositorResult = depositorNameSchema.safeParse(
    interaction.fields.getTextInputValue("depositor"),
  );
  if (!depositorResult.success) {
    await interaction.reply({
      embeds: [errorEmbed(depositorResult.error.issues[0]?.message ?? "입금자명 오류")],
      ephemeral: true,
    });
    return;
  }
  const months = Number(monthsRaw ?? 1);
  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await api.createPaymentRequest(
      botId,
      interaction.user.id,
      depositorResult.data,
      Number.isFinite(months) ? months : 1,
    );
    await interaction.editReply({ embeds: [paymentRequestEmbed(result.paymentRequest, result.bank)] });
  } catch (error) {
    await interaction.editReply({ embeds: [errorEmbed(errorMessage(error))] });
  }
}

export async function showPaymentStatus(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  try {
    const status = await api.paymentStatus(interaction.user.id);
    await interaction.editReply({ embeds: [paymentStatusEmbed(status.requests, status.payments)] });
  } catch (error) {
    await interaction.editReply({ embeds: [errorEmbed(errorMessage(error))] });
  }
}

export async function showPricing(interaction: ChatInputCommandInteraction, api: ApiClient): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  try {
    const { plans, bank } = await api.plans();
    const plan = plans.find((candidate) => candidate.code === "monthly") ?? plans[0];
    const price = plan?.price_krw ?? 3900;
    const embed = {
      title: "💎 호스팅 요금제",
      color: 0x5865f2,
      description:
        `**봇 1개 · 30일 = ${formatKrw(price)}**\n` +
        `봇 2개 = ${formatKrw(price * 2)}\n` +
        `봇 3개 = ${formatKrw(price * 3)}\n\n` +
        "무료 체험은 제공하지 않습니다. 각 봇은 독립적으로 결제·만료됩니다.",
      fields: [
        { name: "은행", value: bank.bankName, inline: true },
        { name: "계좌번호", value: `\`${bank.accountNumber}\``, inline: true },
        { name: "예금주", value: bank.accountHolder, inline: true },
      ],
      footer: { text: "입금자명을 결제 신청 시 입력한 이름과 동일하게 입력해 주세요." },
    };
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    await interaction.editReply({ embeds: [errorEmbed(errorMessage(error))] });
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "알 수 없는 오류가 발생했습니다.";
}
