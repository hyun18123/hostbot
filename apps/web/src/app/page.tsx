import Link from "next/link";
import { requireAuth } from "@/lib/auth";
import { getBots, getStats, type BotRow, type Stats } from "@/lib/api";
import { STATUS_LABELS, formatDate, formatKrw } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  await requireAuth();
  let stats: Stats | null = null;
  let bots: BotRow[] = [];
  let error: string | null = null;
  try {
    [stats, bots] = await Promise.all([getStats(), getBots()]);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "API에 연결할 수 없습니다.";
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>운영 개요</h1>
          <p className="muted small" style={{ margin: 0 }}>
            호스팅 현황과 이번 달 매출을 한눈에 확인합니다.
          </p>
        </div>
        <Link className="btn primary" href="/payments">
          결제 처리
        </Link>
      </div>

      {error ? <div className="alert error">{error}</div> : null}

      {stats ? (
        <>
          <div className="grid cards" style={{ marginBottom: 20 }}>
            <div className="card">
              <div className="label">등록 봇</div>
              <div className="value">{stats.bots.total}</div>
              <div className="sub">실행 중 {stats.bots.running}개</div>
            </div>
            <div className="card">
              <div className="label">사용자</div>
              <div className="value">{stats.users}</div>
              <div className="sub">호스팅 이용 고객</div>
            </div>
            <div className="card">
              <div className="label">이번 달 매출</div>
              <div className="value">{formatKrw(stats.revenue.thisMonthKrw)}</div>
              <div className="sub">최근 30일 {formatKrw(stats.revenue.last30DaysKrw)}</div>
            </div>
            <div className="card">
              <div className="label">확인 필요</div>
              <div className="value">{stats.pending.manualReview}</div>
              <div className="sub">수동 결제 검토 {stats.pending.manualReview}건</div>
            </div>
          </div>

          <div className="panel">
            <h2>봇 상태 분포</h2>
            <div className="grid cards">
              {[
                ["실행 중", stats.bots.running, "running"],
                ["중지", stats.bots.stopped, "stopped"],
                ["만료", stats.bots.expired, "expired"],
                ["오류", stats.bots.error, "error"],
                ["입금 대기", stats.bots.awaitingPayment, "awaiting_payment"],
              ].map(([label, count]) => (
                <div key={String(label)} className="card">
                  <div className="label">{label}</div>
                  <div className="value">{count}</div>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}

      <div className="panel">
        <div className="page-head" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>최근 등록 봇</h2>
          <Link className="btn ghost sm" href="/bots">
            전체 보기
          </Link>
        </div>
        {bots.length === 0 ? (
          <div className="empty">아직 등록된 봇이 없습니다.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>봇</th>
                <th>상태</th>
                <th>만료일</th>
                <th>디스코드 봇</th>
              </tr>
            </thead>
            <tbody>
              {bots.slice(0, 10).map((bot) => (
                <tr key={bot.id}>
                  <td>
                    <strong>{bot.name}</strong>
                    <div className="mono">{bot.id.slice(0, 8)}</div>
                  </td>
                  <td>
                    <span className={`badge ${bot.status}`}>{STATUS_LABELS[bot.status] ?? bot.status}</span>
                  </td>
                  <td>{formatDate(bot.expiresAt)}</td>
                  <td>{bot.discordBotUsername ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
