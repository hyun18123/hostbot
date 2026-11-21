import { EmbedBuilder } from "discord.js";
import {
  BOT_STATUS_LABELS,
  PAYMENT_REQUEST_STATUS_LABELS,
  formatKrw,
  formatKstDate,
  formatKstDateTime,
  type BotDto,
  type PaymentDto,
  type PaymentRequestDto,
} from "@hostbot/shared";

const STATUS_COLORS: Record<string, number> = {
  running: 0x2ecc71,
  starting: 0xf1c40f,
  installing: 0xf1c40f,
  awaiting_payment: 0xf39c12,
  stopped: 0x95a5a6,
  expired: 0xe67e22,
  error: 0xe74c3c,
  deleting: 0xe74c3c,
  deleted: 0x95a5a6,
};

export function statusEmoji(status: string): string {
  switch (status) {
    case "running":
      return "🟢";
    case "starting":
    case "installing":
      return "🟡";
    case "awaiting_payment":
      return "🟠";
    case "stopped":
      return "⚪";
    case "expired":
      return "🟤";
    case "error":
      return "🔴";
    default:
      return "⚫";
  }
}

export function botEmbed(bot: BotDto): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`${statusEmoji(bot.status)} ${bot.name}`)
    .setColor(STATUS_COLORS[bot.status] ?? 0x5865f2)
    .addFields(
      { name: "상태", value: BOT_STATUS_LABELS[bot.status] ?? bot.status, inline: true },
      {
        name: "이용 만료",
        value: bot.expiresAt
          ? `${formatKstDate(bot.expiresAt)}${bot.daysRemaining !== null ? ` (${bot.daysRemaining}일 남음)` : ""}`
          : "미결제",
        inline: true,
      },
    )
    .setFooter({ text: `봇 ID: ${bot.id.slice(0, 8)}` })
    .setTimestamp(new Date());
  if (bot.discordBotUsername) {
    embed.addFields({ name: "디스코드 봇", value: `${bot.discordBotUsername}`, inline: true });
  }
  if (bot.lastError) {
    embed.addFields({ name: "최근 오류", value: truncateField(bot.lastError, 900) });
  }
  return embed;
}

export function botListEmbed(bots: BotDto[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("내 호스팅 봇")
    .setColor(0x5865f2)
    .setTimestamp(new Date());
  if (bots.length === 0) {
    embed.setDescription("아직 등록한 봇이 없습니다. `/호스팅 등록`으로 시작해 보세요.");
    return embed;
  }
  for (const bot of bots.slice(0, 20)) {
    const expiry = bot.expiresAt ? formatKstDate(bot.expiresAt) : "미결제";
    embed.addFields({
      name: `${statusEmoji(bot.status)} ${bot.name}`,
      value: `상태: **${BOT_STATUS_LABELS[bot.status] ?? bot.status}**\n만료: ${expiry}\nID: \`${bot.id}\``,
    });
  }
  if (bots.length > 20) embed.setFooter({ text: `외 ${bots.length - 20}개` });
  return embed;
}

export function paymentRequestEmbed(
  request: PaymentRequestDto,
  bank: { bankName: string; accountNumber: string; accountHolder: string; instructions?: string },
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("💳 입금 안내")
    .setColor(0xf39c12)
    .setDescription(
      "아래 계좌로 **정확한 금액**을 입금해 주세요.\n입금이 확인되면 자동으로 승인되고 봇이 시작됩니다.",
    )
    .addFields(
      { name: "입금 금액", value: `**${formatKrw(request.amount)}**`, inline: true },
      { name: "이용 기간", value: `${request.months * 30}일`, inline: true },
      { name: "입금자명", value: request.depositorName, inline: true },
      { name: "은행", value: bank.bankName, inline: true },
      { name: "계좌번호", value: `\`${bank.accountNumber}\``, inline: true },
      { name: "예금주", value: bank.accountHolder, inline: true },
      { name: "신청 코드", value: `\`${request.code}\``, inline: false },
      { name: "입금 기한", value: formatKstDateTime(request.expiresAt), inline: true },
      { name: "대상 봇", value: request.botName, inline: true },
    )
    .setFooter({ text: "입금자명이 다르면 자동 승인이 되지 않을 수 있습니다." })
    .setTimestamp(new Date());
  if (bank.instructions) embed.addFields({ name: "안내", value: truncateField(bank.instructions, 500) });
  return embed;
}

export function paymentStatusEmbed(requests: PaymentRequestDto[], payments: PaymentDto[]): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle("결제 상태").setColor(0x5865f2).setTimestamp(new Date());
  if (requests.length === 0 && payments.length === 0) {
    embed.setDescription("결제 내역이 없습니다.");
    return embed;
  }
  for (const request of requests.slice(0, 5)) {
    embed.addFields({
      name: `${request.botName} · ${request.code}`,
      value:
        `상태: **${PAYMENT_REQUEST_STATUS_LABELS[request.status] ?? request.status}**\n` +
        `금액: ${formatKrw(request.amount)}\n` +
        `신청: ${formatKstDateTime(request.requestedAt)}\n` +
        `기한: ${formatKstDateTime(request.expiresAt)}`,
    });
  }
  for (const payment of payments.slice(0, 5)) {
    embed.addFields({
      name: `✅ 결제 완료 · ${payment.botName}`,
      value:
        `${formatKrw(payment.amount)} / ${payment.months * 30}일\n` +
        `승인: ${formatKstDateTime(payment.approvedAt ?? payment.createdAt)}\n` +
        (payment.requestCode ? `신청 코드: \`${payment.requestCode}\`` : ""),
    });
  }
  return embed;
}

export function truncateField(value: string, max: number): string {
  const cleaned = value.replace(/\u0000/g, "");
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1)}…`;
}

export function splitMessage(text: string, maxLength = 1800): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    let index = rest.lastIndexOf("\n", maxLength);
    if (index < Math.floor(maxLength / 2)) index = maxLength;
    chunks.push(rest.slice(0, index));
    rest = rest.slice(index).replace(/^\n/, "");
  }
  return chunks;
}

export function codeBlock(value: string): string {
  return `\`\`\`\n${value.replace(/```/g, "'''")}\n\`\`\``;
}

export function errorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder().setTitle("오류").setColor(0xe74c3c).setDescription(truncateField(message, 1800));
}

export function okEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder().setTitle(title).setColor(0x2ecc71).setDescription(truncateField(description, 1800));
}
