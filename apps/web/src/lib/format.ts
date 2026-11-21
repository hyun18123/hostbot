export function formatKrw(amount: number): string {
  return `${new Intl.NumberFormat("ko-KR").format(amount)}원`;
}

export function formatDateTime(value: string | null): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatDate(value: string | null): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

export const STATUS_LABELS: Record<string, string> = {
  awaiting_payment: "입금 대기",
  installing: "설치 중",
  starting: "시작 중",
  running: "실행 중",
  stopped: "중지됨",
  expired: "이용 만료",
  error: "오류",
  deleting: "삭제 중",
  deleted: "삭제됨",
  awaiting_deposit: "입금 대기",
  manual_review: "관리자 확인 필요",
  approved: "승인",
  rejected: "거절",
  refunded: "환불",
};
