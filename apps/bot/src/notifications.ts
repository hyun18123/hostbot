import { EmbedBuilder, type Client, type TextChannel } from "discord.js";
import { formatKrw, formatKstDateTime } from "@hostbot/shared";
import { type ApiClient, type NotificationItem } from "./api.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { truncateField } from "./ui.js";

export function startNotificationPoller(client: Client, api: ApiClient): () => void {
  let running = false;

  const tick = async () => {
    if (running || !client.isReady()) return;
    running = true;
    try {
      const { notifications } = await api.takeNotifications(20);
      if (notifications.length === 0) return;
      const sent: number[] = [];
      const failed: Array<{ id: number; error: string }> = [];

      for (const notification of notifications) {
        try {
          await deliver(client, notification);
          sent.push(notification.id);
        } catch (error) {
          failed.push({
            id: notification.id,
            error: error instanceof Error ? error.message.slice(0, 500) : "unknown error",
          });
        }
      }

      if (sent.length > 0) await api.ackNotifications(sent, true);
      for (const item of failed) {
        await api.ackNotifications([item.id], false, item.error).catch(() => undefined);
        logger.warn({ id: item.id, error: item.error }, "notification delivery failed");
      }
    } catch (error) {
      logger.warn({ err: error }, "notification poll failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), 30_000);
  timer.unref();
  setTimeout(() => void tick(), 5_000).unref();
  logger.info("notification poller started");
  return () => clearInterval(timer);
}

async function deliver(client: Client, notification: NotificationItem): Promise<void> {
  const embed = render(notification);
  if (!embed) return;

  if (notification.channel === "admin") {
    const channelId = config().adminLogChannelId;
    if (!channelId) {
      logger.warn({ type: notification.type }, "admin alert skipped: ADMIN_LOG_CHANNEL_ID is empty");
      return;
    }
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      throw new Error("관리자 알림 채널을 찾을 수 없습니다.");
    }
    await (channel as TextChannel).send({ embeds: [embed] });
    return;
  }

  if (!notification.discordId) {
    logger.warn({ id: notification.id, type: notification.type }, "DM notification has no discord id");
    return;
  }
  const user = await client.users.fetch(notification.discordId);
  await user.send({ embeds: [embed] });
}

function text(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function number(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function render(notification: NotificationItem): EmbedBuilder | null {
  const payload = notification.payload;

  switch (notification.type) {
    case "payment_approved":
      return new EmbedBuilder()
        .setTitle("✅ 결제가 승인되었습니다")
        .setColor(0x2ecc71)
        .setDescription(
          `**${text(payload, "botName")}** 봇의 결제가 승인되었습니다.\n` +
            (number(payload, "amount") ? `금액: ${formatKrw(number(payload, "amount")!)} / ${number(payload, "months") ?? 1}개월\n` : "") +
            (text(payload, "periodEnd") ? `이용 만료: ${formatKstDateTime(text(payload, "periodEnd"))}\n` : "") +
            "봇을 자동으로 시작합니다.",
        )
        .setTimestamp(new Date());

    case "payment_rejected":
      return new EmbedBuilder()
        .setTitle("결제가 거절되었습니다")
        .setColor(0xe74c3c)
        .setDescription(
          `**${text(payload, "botName")}** 봇의 결제 신청(${text(payload, "requestCode")})이 거절되었습니다.\n` +
            `사유: ${text(payload, "reason") || "사유 미기재"}`,
        );

    case "bot_expired":
      return new EmbedBuilder()
        .setTitle("이용 기간이 만료되었습니다")
        .setColor(0xe67e22)
        .setDescription(
          `**${text(payload, "botName")}** 봇의 이용 기간이 만료되어 정지되었습니다.\n` +
            "`/결제 신청`으로 재결제하면 봇이 다시 시작됩니다.",
        );

    case "bot_expiry_soon": {
      const daysLeft = number(payload, "daysLeft") ?? 0;
      return new EmbedBuilder()
        .setTitle(daysLeft <= 0 ? "⏰ 오늘 이용 기간이 만료됩니다" : `⏰ 이용 기간이 ${daysLeft}일 남았습니다`)
        .setColor(0xf2c94c)
        .setDescription(
          `**${text(payload, "botName")}** 봇의 이용 기간이 ${text(payload, "expiresAt") ? formatKstDateTime(text(payload, "expiresAt")) : "곧"} 만료됩니다.\n` +
            "만료 후에도 계속 사용하려면 `/결제 신청`으로 미리 재결제해 주세요.",
        )
        .setTimestamp(new Date());
    }

    case "payment_refunded":
      return new EmbedBuilder()
        .setTitle("결제가 환불되었습니다")
        .setColor(0x95a5a6)
        .setDescription(
          `**${text(payload, "botName")}** 봇 결제가 환불 처리되었습니다.\n` +
            (number(payload, "amount") ? `금액: ${formatKrw(number(payload, "amount")!)}\n` : "") +
            `사유: ${text(payload, "reason") || "-"}\n` +
            (text(payload, "expiresAt") ? `변경된 이용 만료: ${formatKstDateTime(text(payload, "expiresAt"))}` : ""),
        );

    case "bot_error":
      return new EmbedBuilder()
        .setTitle("봇 실행 오류")
        .setColor(0xe74c3c)
        .setDescription(
          `**${text(payload, "botName")}** 봇을 시작하지 못했습니다.\n${truncateField(text(payload, "message"), 800)}`,
        );

    case "bot_crash_loop":
      return new EmbedBuilder()
        .setTitle("봇이 반복 종료되었습니다")
        .setColor(0xe74c3c)
        .setDescription(
          `**${text(payload, "botName")}** 봇이 반복적으로 종료되어 자동 재시작을 중단했습니다.\n` +
            "`/호스팅 로그`로 원인을 확인한 뒤 `/호스팅 재시작`을 실행해 주세요.",
        );

    case "notice":
      return new EmbedBuilder()
        .setTitle(`📢 ${text(payload, "title") || "호스팅 공지"}`)
        .setColor(0x5865f2)
        .setDescription(truncateField(text(payload, "message"), 1800))
        .setTimestamp(new Date());

    case "payment_manual_review": {
      const candidates = Array.isArray(payload.candidates)
        ? (payload.candidates as Array<Record<string, unknown>>)
        : [];
      const embed = new EmbedBuilder()
        .setTitle("⚠️ 입금 수동 확인 필요")
        .setColor(0xe67e22)
        .addFields(
          { name: "사유", value: truncateField(text(payload, "reason") || "-", 600) },
          {
            name: "입금 정보",
            value:
              `금액: ${number(payload, "amount") ? formatKrw(number(payload, "amount")!) : "-"}\n` +
              `입금자: ${text(payload, "depositorName") || "-"}\n` +
              `은행: ${text(payload, "bankName") || "-"}\n` +
              `거래번호: ${text(payload, "txnId") || "-"}\n` +
              `신뢰도: ${text(payload, "confidence") || "-"}`,
          },
        );
      if (candidates.length > 0) {
        embed.addFields({
          name: "후보 결제 신청",
          value: candidates
            .slice(0, 8)
            .map(
              (candidate) =>
                `• ${String(candidate.code ?? "-")} / 등록 입금자: ${String(candidate.registeredDepositor ?? "-")}`,
            )
            .join("\n"),
        });
      }
      embed.setFooter({ text: "`/관리자 결제승인` 또는 `/관리자 결제거절`로 처리하세요." });
      return embed;
    }

    case "payment_unmatched":
      return new EmbedBuilder()
        .setTitle("❓ 미확인 입금")
        .setColor(0xe67e22)
        .setDescription(
          `대기 중인 결제 신청과 일치하지 않는 입금이 감지되었습니다.\n` +
            `금액: ${number(payload, "amount") ? formatKrw(number(payload, "amount")!) : "-"}\n` +
            `입금자: ${text(payload, "depositorName") || "-"}\n` +
            `은행: ${text(payload, "bankName") || "-"}`,
        );

    case "payment_approved_admin":
      return new EmbedBuilder()
        .setTitle("💰 결제 자동 승인")
        .setColor(0x2ecc71)
        .setDescription(
          `신청 ${text(payload, "requestCode")} / ${text(payload, "botName")}\n` +
            `${number(payload, "amount") ? formatKrw(number(payload, "amount")!) : ""} · ${text(payload, "approvedBy")}`,
        );

    default:
      return new EmbedBuilder()
        .setTitle(`알림: ${notification.type}`)
        .setColor(0x95a5a6)
        .setDescription(truncateField(JSON.stringify(payload, null, 2), 1500));
  }
}

// payment_approved is enqueued both as a DM and as an admin alert.
// The admin variant uses the same type; render() gives it the DM wording as well.
