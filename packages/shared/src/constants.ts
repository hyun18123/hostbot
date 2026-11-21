/** Price for one bot, one month (30 days), in KRW. */
export const PRICE_PER_BOT_KRW = 3_900;

/** Billing period granted by one successful payment. */
export const BILLING_PERIOD_DAYS = 30;

/** A payment request is kept open for this many days. */
export const PAYMENT_REQUEST_DAYS = 7;

/** How long a stopped/expired bot's source files are retained. */
export const SOURCE_RETENTION_DAYS = 30;

export const BOT_STATUSES = [
  "awaiting_payment",
  "installing",
  "starting",
  "running",
  "stopped",
  "expired",
  "error",
  "deleting",
  "deleted",
] as const;

export type BotStatus = (typeof BOT_STATUSES)[number];

export const PAYMENT_REQUEST_STATUSES = [
  "awaiting_deposit",
  "manual_review",
  "approved",
  "rejected",
  "expired",
  "cancelled",
] as const;

export type PaymentRequestStatus = (typeof PAYMENT_REQUEST_STATUSES)[number];

export const PAYMENT_STATUSES = ["approved", "rejected", "refunded"] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const NOTIFICATION_STATUSES = ["pending", "sent", "failed"] as const;

export const BOT_STATUS_LABELS: Record<BotStatus, string> = {
  awaiting_payment: "입금 대기",
  installing: "설치 중",
  starting: "시작 중",
  running: "실행 중",
  stopped: "중지됨",
  expired: "이용 만료",
  error: "오류",
  deleting: "삭제 중",
  deleted: "삭제됨",
};

export const PAYMENT_REQUEST_STATUS_LABELS: Record<PaymentRequestStatus, string> = {
  awaiting_deposit: "입금 대기",
  manual_review: "관리자 확인 필요",
  approved: "승인",
  rejected: "거절",
  expired: "만료",
  cancelled: "취소",
};

export const PLAN_MONTHLY = "monthly";

/** Discord custom ID namespaces. Keep in sync with apps/bot. */
export const CUSTOM_IDS = {
  registerModal: "hostbot:register-modal",
  paymentModal: "hostbot:payment-modal",
  deleteConfirm: "hostbot:delete-confirm",
} as const;

/** Maximum number of bots a normal user can register. */
export const MAX_BOTS_PER_USER = 5;

export const LIMITS = {
  zipBytes: 20 * 1024 * 1024,
  zipEntries: 1_500,
  zipTotalUncompressedBytes: 150 * 1024 * 1024,
  zipSingleFileUncompressedBytes: 25 * 1024 * 1024,
  zipCompressionRatio: 200,
  packageJsonBytes: 512 * 1024,
  botNameLength: 40,
  depositorNameLength: 30,
  tokenLength: 200,
} as const;
