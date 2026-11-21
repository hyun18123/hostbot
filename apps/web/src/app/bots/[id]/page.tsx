import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth";
import {
  ApiError,
  getBot,
  getBotEvents,
  getBotLogs,
  type BotEventRow,
  type BotRow,
} from "@/lib/api";
import { STATUS_LABELS, formatDate, formatDateTime } from "@/lib/format";
import { deleteBotAction, restartBotAction, stopBotAction } from "../../actions";

export const dynamic = "force-dynamic";

const LEVEL_CLASS: Record<BotEventRow["level"], string> = {
  debug: "stopped",
  info: "running",
  warn: "manual_review",
  error: "error",
};

export default async function BotDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  await requireAuth();
  const { id } = await params;
  const query = await searchParams;

  let bot: BotRow | null = null;
  let events: BotEventRow[] = [];
  let logs = "";
  let error: string | null = null;

  try {
    [bot, events, logs] = await Promise.all([
      getBot(id),
      getBotEvents(id, 50).catch(() => []),
      getBotLogs(id, 200).catch(() => "(로그를 불러오지 못했습니다)"),
    ]);
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) notFound();
    error = caught instanceof Error ? caught.message : "API에 연결할 수 없습니다.";
  }

  if (!bot) {
    return (
      <>
        <div className="alert error">{error ?? "봇을 찾을 수 없습니다."}</div>
        <Link className="btn ghost" href="/bots">
          목록으로
        </Link>
      </>
    );
  }

  const active = ["running", "starting", "installing"].includes(bot.status);

  return (
    <>
      <div className="page-head">
        <div>
          <Link className="muted small" href="/bots">
            ← 호스팅 봇
          </Link>
          <h1>{bot.name}</h1>
          <p className="muted small" style={{ margin: 0 }}>
            <span className={`badge ${bot.status}`}>{STATUS_LABELS[bot.status] ?? bot.statusLabel}</span>{" "}
            <span className="mono">{bot.id}</span>
          </p>
        </div>
        <div className="actions">
          {active ? (
            <form action={stopBotAction}>
              <input type="hidden" name="id" value={bot.id} />
              <input type="hidden" name="back" value={`/bots/${bot.id}`} />
              <button className="btn" type="submit">
                정지
              </button>
            </form>
          ) : bot.status !== "expired" && bot.status !== "awaiting_payment" && bot.status !== "deleted" ? (
            <form action={restartBotAction}>
              <input type="hidden" name="id" value={bot.id} />
              <input type="hidden" name="back" value={`/bots/${bot.id}`} />
              <button className="btn primary" type="submit">
                재시작
              </button>
            </form>
          ) : null}
          <form action={deleteBotAction} className="inline-form">
            <input type="hidden" name="id" value={bot.id} />
            <input name="confirm" placeholder="삭제" aria-label="삭제 확인" />
            <button className="btn danger" type="submit">
              삭제
            </button>
          </form>
        </div>
      </div>

      {query.ok ? <div className="alert ok">{query.ok}</div> : null}
      {query.error || error ? <div className="alert error">{query.error ?? error}</div> : null}

      <div className="grid cards" style={{ marginBottom: 20 }}>
        <div className="card">
          <div className="label">이용 만료</div>
          <div className="value" style={{ fontSize: 18 }}>
            {formatDate(bot.expiresAt)}
          </div>
          <div className="sub">{bot.daysRemaining !== null ? `${bot.daysRemaining}일 남음` : "결제 전"}</div>
        </div>
        <div className="card">
          <div className="label">디스코드 봇</div>
          <div className="value" style={{ fontSize: 18 }}>
            {bot.discordBotUsername ? `@${bot.discordBotUsername}` : "-"}
          </div>
          <div className="sub mono">{bot.discordBotId ?? "-"}</div>
        </div>
        <div className="card">
          <div className="label">엔트리포인트</div>
          <div className="value mono" style={{ fontSize: 16 }}>
            {bot.entrypoint ?? "-"}
          </div>
          <div className="sub">등록 {formatDateTime(bot.createdAt ?? null)}</div>
        </div>
        <div className="card">
          <div className="label">최근 오류</div>
          <div className="value" style={{ fontSize: 14, color: bot.lastError ? "var(--red)" : undefined }}>
            {bot.lastError ? bot.lastError.slice(0, 120) : "없음"}
          </div>
          <div className="sub">오류가 길면 아래 이벤트를 확인하세요.</div>
        </div>
      </div>

      <div className="panel">
        <h2>최근 실행 로그</h2>
        <pre
          className="mono"
          style={{
            margin: 0,
            maxHeight: 420,
            overflow: "auto",
            padding: 14,
            borderRadius: 10,
            background: "#0a0f1e",
            border: "1px solid var(--line)",
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
          }}
        >
          {logs || "(로그가 없습니다)"}
        </pre>
      </div>

      <div className="panel">
        <h2>호스팅 이벤트</h2>
        {events.length === 0 ? (
          <div className="empty">기록된 이벤트가 없습니다.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>시각</th>
                <th>단계</th>
                <th>이벤트</th>
                <th>내용</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td className="small">{formatDateTime(event.createdAt)}</td>
                  <td>
                    <span className={`badge ${LEVEL_CLASS[event.level]}`}>{event.level}</span>
                  </td>
                  <td className="mono small">{event.event}</td>
                  <td className="small" style={{ maxWidth: 420 }}>
                    {event.message ?? "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
