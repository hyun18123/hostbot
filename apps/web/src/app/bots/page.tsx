import { requireAuth } from "@/lib/auth";
import Link from "next/link";
import { getBots, type BotRow } from "@/lib/api";
import { STATUS_LABELS, formatDate } from "@/lib/format";
import { deleteBotAction, restartBotAction, stopBotAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function BotsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  await requireAuth();
  const params = await searchParams;
  let bots: BotRow[] = [];
  let error: string | null = null;
  try {
    bots = await getBots();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "API에 연결할 수 없습니다.";
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>호스팅 봇</h1>
          <p className="muted small" style={{ margin: 0 }}>
            전체 고객 봇의 상태와 이용 기간을 관리합니다.
          </p>
        </div>
      </div>

      {params.ok ? <div className="alert ok">{params.ok}</div> : null}
      {params.error || error ? <div className="alert error">{params.error ?? error}</div> : null}

      <div className="panel">
        {bots.length === 0 ? (
          <div className="empty">등록된 봇이 없습니다.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>봇</th>
                <th>상태</th>
                <th>만료</th>
                <th>최근 오류</th>
                <th>작업</th>
              </tr>
            </thead>
            <tbody>
              {bots.map((bot) => (
                <tr key={bot.id}>
                  <td>
                    <Link href={`/bots/${bot.id}`}>
                      <strong>{bot.name}</strong>
                    </Link>
                    <div className="mono">{bot.id}</div>
                    {bot.discordBotUsername ? <div className="small muted">@{bot.discordBotUsername}</div> : null}
                  </td>
                  <td>
                    <span className={`badge ${bot.status}`}>{STATUS_LABELS[bot.status] ?? bot.status}</span>
                    {bot.daysRemaining !== null ? (
                      <div className="small muted">{bot.daysRemaining}일 남음</div>
                    ) : null}
                  </td>
                  <td>{formatDate(bot.expiresAt)}</td>
                  <td className="small muted" style={{ maxWidth: 280 }}>
                    {bot.lastError ?? "-"}
                  </td>
                  <td>
                    <div className="actions">
                      {bot.status === "running" || bot.status === "starting" || bot.status === "installing" ? (
                        <form action={stopBotAction}>
                          <input type="hidden" name="id" value={bot.id} />
                          <button className="btn sm" type="submit">
                            정지
                          </button>
                        </form>
                      ) : bot.status !== "expired" && bot.status !== "awaiting_payment" && bot.status !== "deleted" ? (
                        <form action={restartBotAction}>
                          <input type="hidden" name="id" value={bot.id} />
                          <button className="btn sm" type="submit">
                            재시작
                          </button>
                        </form>
                      ) : null}
                      <form action={deleteBotAction} className="inline-form">
                        <input type="hidden" name="id" value={bot.id} />
                        <input name="confirm" placeholder="삭제" aria-label="삭제 확인" />
                        <button className="btn danger sm" type="submit">
                          삭제
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="muted small">
        삭제 시 컨테이너, 소스 파일, 봇 토큰이 즉시 제거됩니다. 결제 기록은 회계 목적으로 익명 보관됩니다.
      </p>
    </>
  );
}
