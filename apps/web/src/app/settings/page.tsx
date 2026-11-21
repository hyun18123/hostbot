import { requireAuth } from "@/lib/auth";
import { getSettings } from "@/lib/api";
import { saveSettingAction } from "../actions";

export const dynamic = "force-dynamic";

const DESCRIPTIONS: Record<string, string> = {
  bank_account: "입금 계좌 정보 (bankName, accountNumber, accountHolder)",
  payment_instructions: "결제 안내 문구",
  max_bots_per_user: "사용자당 최대 봇 개수",
  registration_enabled: "신규 봇 등록 허용 여부 (true/false)",
  maintenance_message: "점검 안내 문구",
  bank_parsers: "은행별 알림 파서 규칙 (키워드/정규식)",
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  await requireAuth();
  const params = await searchParams;
  let settings: Record<string, unknown> = {};
  let error: string | null = null;
  try {
    settings = await getSettings();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "API에 연결할 수 없습니다.";
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>서비스 설정</h1>
          <p className="muted small" style={{ margin: 0 }}>
            입금 계좌와 은행 알림 파서 규칙을 관리합니다. 값은 JSON으로 저장됩니다.
          </p>
        </div>
      </div>

      {params.ok ? <div className="alert ok">{params.ok}</div> : null}
      {params.error || error ? <div className="alert error">{params.error ?? error}</div> : null}

      {Object.keys(settings).length === 0 ? (
        <div className="panel empty">설정을 불러오지 못했습니다.</div>
      ) : (
        Object.entries(settings).map(([key, value]) => (
          <div className="panel" key={key}>
            <h2 className="mono" style={{ fontSize: 15, color: "var(--text)" }}>
              {key}
            </h2>
            <p className="muted small" style={{ marginTop: 0 }}>
              {DESCRIPTIONS[key] ?? "사용자 정의 설정"}
            </p>
            <form action={saveSettingAction}>
              <input type="hidden" name="key" value={key} />
              <div className="form-row">
                <textarea
                  name="value"
                  defaultValue={JSON.stringify(value, null, 2)}
                  spellCheck={false}
                  rows={key === "bank_parsers" ? 14 : 5}
                />
              </div>
              <button className="btn primary sm" type="submit">
                저장
              </button>
            </form>
          </div>
        ))
      )}

      <div className="panel">
        <h2>보안 참고</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          은행 알림 파서는 실제 수신되는 알림 형식과 반드시 대조해야 합니다. 금액·입금자명이 확실하지
          않거나 동일 금액 신청이 여러 건이면 자동 승인되지 않고 이 화면의 결제 관리로 넘어옵니다.
        </p>
      </div>
    </>
  );
}
