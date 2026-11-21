import { requireAuth } from "@/lib/auth";
import { ApiError, previewPaymentParser, type ParserPreviewResult } from "@/lib/api";
import { formatKrw } from "@/lib/format";

export const dynamic = "force-dynamic";

const CONFIDENCE_CLASS: Record<string, string> = {
  high: "approved",
  medium: "manual_review",
  low: "error",
};

const SAMPLE = "홍길동 3,900원 입금 잔액 50,000원";

export default async function ParserPage({
  searchParams,
}: {
  searchParams: Promise<{ title?: string; body?: string; appName?: string; source?: string }>;
}) {
  await requireAuth();
  const params = await searchParams;
  const body = (params.body ?? "").trim();
  let preview: ParserPreviewResult | null = null;
  let error: string | null = null;

  if (body) {
    try {
      preview = await previewPaymentParser({
        body,
        title: params.title?.trim() || undefined,
        appName: params.appName?.trim() || undefined,
        source: params.source?.trim() || "android",
      });
    } catch (caught) {
      error =
        caught instanceof ApiError ? caught.message : caught instanceof Error ? caught.message : "파싱에 실패했습니다.";
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>알림 파서 프리뷰</h1>
          <p className="muted small" style={{ margin: 0 }}>
            실제 입금 알림을 붙여넣어 금액·입금자명·신뢰도를 미리 확인합니다. 저장이나 승인은 일어나지 않습니다.
          </p>
        </div>
      </div>

      {error ? <div className="alert error">{error}</div> : null}

      <div className="panel">
        <form method="get" action="/parser">
          <div className="form-row">
            <label className="muted small" htmlFor="appName">
              앱 이름 (예: 국민은행)
            </label>
            <input id="appName" name="appName" defaultValue={params.appName ?? ""} placeholder="국민은행" />
          </div>
          <div className="form-row">
            <label className="muted small" htmlFor="title">
              알림 제목
            </label>
            <input id="title" name="title" defaultValue={params.title ?? ""} placeholder="입금 알림" />
          </div>
          <div className="form-row">
            <label className="muted small" htmlFor="source">
              수신 경로
            </label>
            <select id="source" name="source" defaultValue={params.source ?? "android"}>
              <option value="android">Android 알림</option>
              <option value="sms">SMS</option>
              <option value="custom">커스텀 포워더</option>
            </select>
          </div>
          <div className="form-row">
            <label className="muted small" htmlFor="body">
              알림 본문
            </label>
            <textarea
              id="body"
              name="body"
              rows={5}
              required
              defaultValue={params.body ?? SAMPLE}
              placeholder={SAMPLE}
            />
          </div>
          <button className="btn primary" type="submit">
            파싱 테스트
          </button>
        </form>
      </div>

      {preview ? (
        <div className="panel">
          <div className="page-head" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>파싱 결과</h2>
            <span className={`badge ${CONFIDENCE_CLASS[preview.parsed.confidence] ?? "stopped"}`}>
              신뢰도 {preview.parsed.confidence}
            </span>
          </div>

          <div className="grid cards" style={{ marginBottom: 16 }}>
            <div className="card">
              <div className="label">입금 여부</div>
              <div className="value" style={{ fontSize: 18 }}>
                {preview.parsed.isDeposit ? "입금으로 판단" : "입금 아님"}
              </div>
              <div className="sub">{preview.parsed.reason}</div>
            </div>
            <div className="card">
              <div className="label">금액</div>
              <div className="value" style={{ fontSize: 18 }}>
                {preview.parsed.amount !== null ? formatKrw(preview.parsed.amount) : "-"}
              </div>
              <div className="sub">{preview.parsed.isDeposit ? "자동 승인 비교 대상" : "-"}</div>
            </div>
            <div className="card">
              <div className="label">입금자명</div>
              <div className="value" style={{ fontSize: 18 }}>
                {preview.parsed.depositorName ?? "-"}
              </div>
              <div className="sub">{preview.parsed.depositorMasked ? "마스킹 포함" : "마스킹 없음"}</div>
            </div>
            <div className="card">
              <div className="label">은행 / 거래번호</div>
              <div className="value" style={{ fontSize: 16 }}>
                {preview.parsed.bankName ?? "-"}
              </div>
              <div className="sub mono">{preview.parsed.txnId ?? "-"}</div>
            </div>
          </div>

          <h2 style={{ fontSize: 15 }}>원본 텍스트</h2>
          <pre
            className="mono"
            style={{
              margin: 0,
              padding: 14,
              borderRadius: 10,
              background: "#0a0f1e",
              border: "1px solid var(--line)",
              fontSize: 12,
              whiteSpace: "pre-wrap",
            }}
          >
            {preview.parsed.rawText}
          </pre>
        </div>
      ) : null}

      <div className="panel">
        <h2>자동 승인 조건</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          금액과 입금자명이 정확히 일치하고, 해당 금액의 열린 신청이 1건이며, 중복 알림이 아니고 신뢰도가 low가
          아닐 때만 자동 승인됩니다. 하나라도 어긋나면 결제 관리의 수동 검토로 넘어갑니다.
        </p>
      </div>
    </>
  );
}
