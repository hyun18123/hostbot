import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import {
  PAYMENT_REQUEST_STATUS_LABELS,
  formatKrw,
  formatKstDate,
  formatKstDateTime,
  type PaymentRequestDto,
  type StatsResult,
} from "@hostbot/shared";
import { type ApiClient } from "../api.js";
import { codeBlock, errorEmbed, okEmbed, splitMessage, truncateField } from "../ui.js";
import { errorMessage } from "./hosting.js";

export async function handleAdminCommand(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand(true);

  switch (subcommand) {
    case "통계":
      return showStats(interaction, api);
    case "결제내역":
      return showPayments(interaction, api);
    case "결제승인":
      return approvePayment(interaction, api);
    case "결제거절":
      return rejectPayment(interaction, api);
    case "호스팅정지":
      return stopBot(interaction, api);
    case "호스팅삭제":
      return deleteBot(interaction, api);
    case "공지":
      return broadcast(interaction, api);
    case "설정":
      return settings(interaction, api);
    default:
      await interaction.reply({ embeds: [errorEmbed("알 수 없는 관리자 명령어입니다.")], ephemeral: true });
  }
}

async function showStats(interaction: ChatInputCommandInteraction, api: ApiClient): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  try {
    const stats = await api.adminStats();
    const embed = new EmbedBuilder()
      .setTitle("📊 호스팅 통계")
      .setColor(0x5865f2)
      .addFields(
        { name: "사용자", value: `${stats.users}명`, inline: true },
        { name: "등록 봇", value: `${stats.bots.total}개`, inline: true },
        { name: "실행 중", value: `${stats.bots.running}개`, inline: true },
        { name: "중지", value: `${stats.bots.stopped}개`, inline: true },
        { name: "만료", value: `${stats.bots.expired}개`, inline: true },
        { name: "오류", value: `${stats.bots.error}개`, inline: true },
        { name: "입금 대기 봇", value: `${stats.bots.awaitingPayment}개`, inline: true },
        { name: "이번 달 매출", value: formatKrw(stats.revenue.thisMonthKrw), inline: true },
        { name: "최근 30일 매출", value: formatKrw(stats.revenue.last30DaysKrw), inline: true },
        { name: "누적 매출", value: formatKrw(stats.revenue.totalKrw), inline: true },
        { name: "대기 결제 신청", value: `${stats.pending.paymentRequests}건`, inline: true },
        { name: "관리자 확인 필요", value: `${stats.pending.manualReview}건`, inline: true },
      )
      .setTimestamp(new Date());
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    await interaction.editReply({ embeds: [errorEmbed(errorMessage(error))] });
  }
}

async function showPayments(interaction: ChatInputCommandInteraction, api: ApiClient): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  try {
    const status = interaction.options.getString("status") ?? undefined;
    const [{ requests }, { payments }] = await Promise.all([
      api.adminRequests(status, 25),
      api.adminPayments(15),
    ]);

    const embed = new EmbedBuilder().setTitle("🧾 결제 내역").setColor(0x5865f2).setTimestamp(new Date());
    if (requests.length === 0) {
      embed.setDescription(status ? "해당 상태의 결제 신청이 없습니다." : "결제 신청이 없습니다.");
    }
    for (const request of requests.slice(0, 15)) {
      embed.addFields({
        name: `${request.botName} · ${request.code}`,
        value:
          `상태: **${PAYMENT_REQUEST_STATUS_LABELS[request.status] ?? request.status}**\n` +
          `금액: ${formatKrw(request.amount)} / ${request.months}개월\n` +
          `입금자: ${request.depositorName}\n` +
          `기한: ${formatKstDateTime(request.expiresAt)}`,
      });
    }
    if (payments.length > 0) {
      embed.addFields({
        name: "최근 승인",
        value: payments
          .slice(0, 8)
          .map(
            (payment) =>
              `• ${formatKstDate(payment.approvedAt ?? payment.createdAt)} · ${payment.botName} · ${formatKrw(payment.amount)}`,
          )
          .join("\n"),
      });
    }
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    await interaction.editReply({ embeds: [errorEmbed(errorMessage(error))] });
  }
}

async function approvePayment(interaction: ChatInputCommandInteraction, api: ApiClient): Promise<void> {
  const code = interaction.options.getString("code", true).trim();
  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await api.adminApprove(code);
    await interaction.editReply({
      embeds: [
        okEmbed(
          "결제 승인 완료",
          `결제가 승인되었습니다.\n이용 만료: ${formatKstDateTime(result.periodEnd)}\n봇을 자동으로 시작합니다.`,
        ),
      ],
    });
  } catch (error) {
    await interaction.editReply({ embeds: [errorEmbed(errorMessage(error))] });
  }
}

async function rejectPayment(interaction: ChatInputCommandInteraction, api: ApiClient): Promise<void> {
  const code = interaction.options.getString("code", true).trim();
  const reason = interaction.options.getString("reason", true).trim();
  await interaction.deferReply({ ephemeral: true });
  try {
    await api.adminReject(code, reason);
    await interaction.editReply({ embeds: [okEmbed("결제 거절", `결제 신청 ${code}을(를) 거절했습니다.`)] });
  } catch (error) {
    await interaction.editReply({ embeds: [errorEmbed(errorMessage(error))] });
  }
}

async function stopBot(interaction: ChatInputCommandInteraction, api: ApiClient): Promise<void> {
  const botId = interaction.options.getString("bot", true);
  await interaction.deferReply({ ephemeral: true });
  try {
    const { bot } = await api.adminStopBot(botId);
    await interaction.editReply({ embeds: [okEmbed("호스팅 정지", `${bot.name} 봇을 정지했습니다.`)] });
  } catch (error) {
    await interaction.editReply({ embeds: [errorEmbed(errorMessage(error))] });
  }
}

async function deleteBot(interaction: ChatInputCommandInteraction, api: ApiClient): Promise<void> {
  const botId = interaction.options.getString("bot", true);
  const confirm = interaction.options.getString("confirm", true).trim();
  if (confirm !== "삭제") {
    await interaction.reply({
      embeds: [errorEmbed("삭제하려면 confirm 값에 정확히 `삭제`를 입력해야 합니다.")],
      ephemeral: true,
    });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    await api.adminDeleteBot(botId);
    await interaction.editReply({
      embeds: [okEmbed("호스팅 삭제", "봇 컨테이너, 소스 파일, 토큰을 삭제했습니다. 결제 기록은 회계 목적으로 익명 보관됩니다.")],
    });
  } catch (error) {
    await interaction.editReply({ embeds: [errorEmbed(errorMessage(error))] });
  }
}

async function broadcast(interaction: ChatInputCommandInteraction, api: ApiClient): Promise<void> {
  const message = interaction.options.getString("message", true).trim();
  if (message.length < 2) {
    await interaction.reply({ embeds: [errorEmbed("공지 내용을 입력해 주세요.")], ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await api.adminBroadcast(message);
    await interaction.editReply({
      embeds: [okEmbed("공지 발송", `${result.queued}명의 사용자에게 DM 공지를 예약했습니다.`)]
    });
  } catch (error) {
    await interaction.editReply({ embeds: [errorEmbed(errorMessage(error))] });
  }
}

async function settings(interaction: ChatInputCommandInteraction, api: ApiClient): Promise<void> {
  const key = interaction.options.getString("key")?.trim();
  const rawValue = interaction.options.getString("value");
  await interaction.deferReply({ ephemeral: true });
  try {
    if (key && rawValue !== null) {
      const value = parseSettingValue(rawValue);
      await api.adminSetSetting(key, value);
      await interaction.editReply({ embeds: [okEmbed("설정 변경", `${key} 값을 변경했습니다.`)] });
      return;
    }
    const { settings } = await api.adminSettings();
    const selected = key ? { [key]: settings[key] } : settings;
    const text = JSON.stringify(selected, null, 2);
    const chunks = splitMessage(codeBlock(text.length > 12_000 ? `${text.slice(0, 12_000)}\n...(생략)` : text));
    await interaction.editReply({ content: chunks[0] ?? "설정이 없습니다." });
    for (const chunk of chunks.slice(1, 3)) {
      await interaction.followUp({ content: chunk, ephemeral: true });
    }
  } catch (error) {
    await interaction.editReply({ embeds: [errorEmbed(errorMessage(error))] });
  }
}

function parseSettingValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

export function requestLine(request: PaymentRequestDto): string {
  return `${request.code} · ${request.botName} · ${formatKrw(request.amount)} · ${PAYMENT_REQUEST_STATUS_LABELS[request.status] ?? request.status}`;
}

export function statsText(stats: StatsResult): string {
  return truncateField(
    `사용자 ${stats.users}명 / 봇 ${stats.bots.total}개 / 실행 ${stats.bots.running}개 / 매출 ${formatKrw(stats.revenue.thisMonthKrw)}`,
    1800,
  );
}
