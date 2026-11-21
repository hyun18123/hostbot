import { requireAuth } from "@/lib/auth";
import {
  getPaymentRequests,
  getPayments,
  type PaymentRequestRow,
  type PaymentRow,
} from "@/lib/api";
import { STATUS_LABELS, formatDateTime, formatKrw } from "@/lib/format";
import { approveAction, refundAction, rejectAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  await requireAuth();
  const params = await searchParams;
  let requests: PaymentRequestRow[] = [];
  let payments: PaymentRow[] = [];
  let error: string | null = null;

  try {
    [requests, payments] = await Promise.all([
      getPaymentRequests("awaiting_deposit,manual_review"),
      getPayments(),
    ]);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "API에 연결할 수 없습니다.";
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>결제 관리</h1>
          <p className="muted small" style={{ margin: 0 }}>
            자동 매칭되지 않은 입금을 확인하고 수동으로 승인·거절합니다.
          </p>
        </div>
      </div>

      {params.ok ? <div className="alert ok">{params.ok}</div> : null}
      {params.error || error ? <div className="alert error">{params.error ?? error}</div> : null}

      <div className="panel">
        <h2>대기 중인 결제 신청</h2>
        {requests.length === 0 ? (
          <div className="empty">처리할 결제 신청이 없습니다.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>신청 코드</th>
                <th>봇 / 입금자</th>
                <th>금액</th>
                <th>상태</th>
                <th>기한</th>
                <th>처리</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => (
                <tr key={request.id}>
                  <td>
                    <strong>{request.code}</strong>
                    <div className="mono">{request.id.slice(0, 8)}</div>
                  </td>
                  <td>
                    {request.botName}
                    <div className="small muted">{request.depositorName}</div>
                  </td>
                  <td>
                    {formatKrw(request.amount)}
                    <div className="small muted">{request.months}개월</div>
                  </td>
                  <td>
                    <span className={`badge ${request.status}`}>
                      {STATUS_LABELS[request.status] ?? request.status}
                    </span>
                    {request.note ? <div className="small muted">{request.note}</div> : null}
                  </td>
                  <td className="small">{formatDateTime(request.expiresAt)}</td>
                  <td>
                    <div className="actions">
                      <form action={approveAction}>
                        <input type="hidden" name="id" value={request.id} />
                        <button className="btn primary sm" type="submit">
                          승인
                        </button>
                      </form>
                      <form action={rejectAction} className="inline-form">
                        <input type="hidden" name="id" value={request.id} />
                        <input name="reason" placeholder="거절 사유" aria-label="거절 사유" required />
                        <button className="btn danger sm" type="submit">
                          거절
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

      <div className="panel">
        <h2>최근 결제 내역</h2>
        {payments.length === 0 ? (
          <div className="empty">결제 내역이 없습니다.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>신청 코드</th>
                <th>봇</th>
                <th>금액</th>
                <th>입금자</th>
                <th>상태</th>
                <th>처리 시각</th>
                <th>환불</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id}>
                  <td>{payment.requestCode ?? "-"}</td>
                  <td>{payment.botName}</td>
                  <td>{formatKrw(payment.amount)}</td>
                  <td>{payment.depositorName ?? "-"}</td>
                  <td>
                    <span className={`badge ${payment.status}`}>
                      {STATUS_LABELS[payment.status] ?? payment.status}
                    </span>
                    {payment.refundReason ? (
                      <div className="small muted">사유: {payment.refundReason}</div>
                    ) : null}
                  </td>
                  <td className="small">
                    {payment.status === "refunded"
                      ? formatDateTime(payment.refundedAt)
                      : formatDateTime(payment.approvedAt ?? payment.createdAt)}
                  </td>
                  <td>
                    {payment.status === "approved" ? (
                      <form action={refundAction} className="inline-form">
                        <input type="hidden" name="id" value={payment.id} />
                        <input name="reason" placeholder="환불 사유" aria-label="환불 사유" required />
                        <button className="btn danger sm" type="submit">
                          환불
                        </button>
                      </form>
                    ) : payment.refundAmount !== null ? (
                      <span className="small muted">{formatKrw(payment.refundAmount)}</span>
                    ) : (
                      <span className="small muted">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small" style={{ marginBottom: 0 }}>
          환불은 결제 1건 전체를 되돌리고, 해당 결제가 부여한 이용 기간을 차감합니다. 기간이 남지 않으면 봇이
          즉시 만료 처리됩니다.
        </p>
      </div>
    </>
  );
}
