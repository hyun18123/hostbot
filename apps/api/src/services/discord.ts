import { config } from "../config.js";
import { AppError } from "../lib/errors.js";

export interface DiscordBotIdentity {
  id: string;
  username: string;
  discriminator: string;
  globalName: string | null;
}

/**
 * Verifies a customer bot token against Discord before it is ever stored.
 * A bad token is rejected early, and the real bot identity is recorded.
 */
export async function verifyBotToken(token: string): Promise<DiscordBotIdentity> {
  const cfg = config();
  let response: Response;
  try {
    response = await fetch(`${cfg.DISCORD_API_BASE}/users/@me`, {
      headers: {
        Authorization: `Bot ${token}`,
        "User-Agent": "DiscordBotHosting/0.1 (https://github.com/hostbot)",
      },
      signal: AbortSignal.timeout(cfg.DISCORD_BOT_VALIDATION_TIMEOUT_MS),
    });
  } catch {
    throw new AppError(
      "discord_unreachable",
      "디스코드에 연결하지 못해 봇 토큰을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
      502,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new AppError("invalid_bot_token", "봇 토큰이 올바르지 않습니다. 디스코드 개발자 포털에서 다시 확인해 주세요.");
  }
  if (!response.ok) {
    throw new AppError("discord_error", `디스코드 토큰 확인에 실패했습니다. (HTTP ${response.status})`, 502);
  }

  const data = (await response.json()) as {
    id?: string;
    username?: string;
    discriminator?: string;
    global_name?: string | null;
    bot?: boolean;
  };

  if (!data.id || !data.username) {
    throw new AppError("invalid_bot_token", "디스코드에서 올바른 봇 정보를 받지 못했습니다.");
  }
  if (data.bot !== true) {
    throw new AppError("not_a_bot_token", "봇 토큰이 아닌 사용자 토큰입니다.");
  }

  return {
    id: data.id,
    username: data.username,
    discriminator: data.discriminator ?? "0",
    globalName: data.global_name ?? null,
  };
}
