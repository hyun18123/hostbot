# API 레퍼런스

Base URL 예: `https://api.example.com`. 모든 응답은 JSON입니다. 오류는 다음 형태입니다.

```json
{
  "error": {
    "code": "validation_error",
    "message": "입금자명을 입력해 주세요.",
    "details": []
  }
}
```

## 인증

| 범위 | 헤더 | 키 |
| --- | --- | --- |
| 관리 봇 API | `x-bot-api-key` | `BOT_API_KEY` |
| 관리자 API | `x-admin-api-key` | `ADMIN_API_KEY` |
| 알림 웹훅 | URL 경로 `:secret` | `NOTIFICATION_WEBHOOK_SECRET` |
| 헬스 체크 | 없음 | - |

관리 봇 API는 관리 봇만 호출해야 합니다. 고객이 직접 호출할 수 있는 공개 API가 아닙니다.

## 헬스

### `GET /health`

```json
{
  "ok": true,
  "service": "hostbot-api",
  "time": "2026-11-20T05:00:00.000Z",
  "dockerEnabled": true,
  "pushbullet": {
    "enabled": true,
    "connected": true,
    "lastEventAt": "2026-11-20T04:59:00.000Z",
    "lastError": null,
    "reconnects": 0,
    "startedAt": "2026-11-20T00:00:00.000Z"
  }
}
```

## 봇 관리 (관리 봇 API)

### `POST /internal/bots`

`multipart/form-data`:

| 필드 | 필수 | 설명 |
| --- | --- | --- |
| `file` | 예 | 봇 ZIP |
| `discordUserId` | 예 | 등록 고객 Discord ID |
| `discordUsername` | 예 | 표시 이름 |
| `guildId` | 예 | 명령어를 실행한 길드 ID |
| `name` | 예 | 관리용 봇 이름 |
| `token` | 예 | 디스코드 봇 토큰 |
| `depositorName` | 예 | 입금자명 |

응답:

```json
{
  "bot": { "id": "uuid", "name": "음악봇", "status": "awaiting_payment", "...": "..." },
  "paymentRequest": {
    "id": "uuid",
    "code": "HB-AB12CD",
    "amount": 3900,
    "months": 1,
    "status": "awaiting_deposit",
    "depositorName": "홍길동",
    "expiresAt": "2026-11-27T05:00:00.000Z"
  },
  "bank": {
    "bankName": "국민은행",
    "accountNumber": "000000-00-000000",
    "accountHolder": "예금주",
    "amount": 3900,
    "depositorName": "홍길동",
    "requestCode": "HB-AB12CD",
    "expiresAt": "2026-11-27T05:00:00.000Z"
  }
}
```

### `GET /internal/bots?discordUserId=...`

내 봇 목록.

### `GET /internal/bots/:id?discordUserId=...`

봇 상세. 소유자 검증 수행.

### `POST /internal/bots/:id/start`

본문: `{ "discordUserId": "..." }`

결제 기간이 남아 있어야 합니다. 의존성 설치/시작은 비동기로 진행됩니다.

### `POST /internal/bots/:id/stop`

본문: `{ "discordUserId": "..." }`

### `POST /internal/bots/:id/restart`

본문: `{ "discordUserId": "..." }`

### `GET /internal/bots/:id/logs?discordUserId=...&lines=100`

최근 로그. 토큰은 마스킹됩니다.

### `DELETE /internal/bots/:id?discordUserId=...`

소스/토큰/컨테이너 삭제. DB 행은 익명화된 `deleted` 상태로 남습니다.

### `POST /internal/bots/:id/payment-request`

본문:

```json
{
  "discordUserId": "123456789012345678",
  "depositorName": "홍길동",
  "months": 1
}
```

열린 신청이 있으면 그 신청을 반환하고 입금자명을 갱신합니다.

## 결제 (관리 봇 API)

### `GET /internal/payments?discordUserId=...`

```json
{
  "requests": [],
  "payments": []
}
```

### `GET /internal/plans`

요금제와 계좌 정보.

## 알림 outbox (관리 봇 API)

### `GET /internal/notifications?limit=20`

관리 봇이 DM/운영 알림을 가져갑니다.

```json
{
  "notifications": [
    {
      "id": 123,
      "channel": "dm",
      "discordId": "123456789012345678",
      "type": "payment_approved",
      "payload": { "botName": "음악봇", "amount": 3900 },
      "createdAt": "2026-11-20T05:00:00.000Z"
    }
  ]
}
```

### `POST /internal/notifications/ack`

```json
{
  "ids": [123, 124],
  "success": true,
  "error": null
}
```

## 관리자 API

### `GET /internal/admin/stats`

사용자 수, 봇 상태 분포, 매출, 대기 건수.

### `GET /internal/admin/bots?limit=100`

전체 봇 목록.

### `GET /internal/admin/bots/:id`

봇 원본 행. 운영 디버깅용.

### `GET /internal/admin/bots/:id/logs?lines=200`

컨테이너 로그. 토큰은 마스킹됩니다. `lines`는 10~500.

```json
{ "logs": "..." }
```

### `GET /internal/admin/bots/:id/events?limit=50`

`hosting_logs` 기반 운영 이벤트. `limit`은 1~200.

```json
{
  "events": [
    {
      "id": 123,
      "level": "info",
      "event": "bot.expiry_reminder",
      "message": "이용 만료 3일 전 안내를 발송했습니다.",
      "meta": { "stage": 3, "daysLeft": 3 },
      "createdAt": "2026-11-20T05:00:00.000Z"
    }
  ]
}
```

### `POST /internal/admin/bots/:id/restart`

컨테이너를 재시작하고 의존성을 다시 확인합니다. 본문은 없어도 됩니다.

### `POST /internal/admin/bots/:id/stop`

본문: `{ "admin": "operator-name" }`

### `DELETE /internal/admin/bots/:id`

본문: `{ "admin": "operator-name" }`

### `GET /internal/admin/payment-requests?status=awaiting_deposit,manual_review&limit=50`

`status`는 쉼표로 여러 개 지정할 수 있습니다.

### `GET /internal/admin/payments?limit=50`

승인된 결제 내역. `status`를 쉼표로 지정할 수 있습니다 (예: `approved,refunded`).

답변의 각 결제에는 `refundedAt`, `refundAmount`, `refundReason`이 포함됩니다.

### `POST /internal/admin/payments/:id/refund`

승인된 결제 1건을 전액 환불 처리하고, 해당 결제가 부여한 기간을 차감합니다.

```json
{ "admin": "operator-name", "reason": "중복 입금" }
```

```json
{
  "paymentId": "uuid",
  "botId": "uuid",
  "amount": 3900,
  "expiresAt": "2026-12-20T05:00:00.000Z",
  "botStatus": "expired"
}
```

기간이 남지 않으면 `botStatus`가 `expired`가 되고 컨테이너가 중지됩니다. 실제 계좌 이체는 수동입니다.

### `GET /internal/admin/payment-notifications?status=manual_review&limit=30`

원본 입금 알림과 파싱 결과.

### `POST /internal/admin/payment-requests/:id/approve`

`:id`는 UUID 또는 신청 코드(`HB-XXXXXX`)입니다.

```json
{ "admin": "operator-name" }
```

응답:

```json
{
  "paymentId": "uuid",
  "botId": "uuid",
  "periodStart": "2026-11-20T05:00:00.000Z",
  "periodEnd": "2026-12-20T05:00:00.000Z",
  "months": 1
}
```

### `POST /internal/admin/payment-requests/:id/reject`

```json
{ "admin": "operator-name", "reason": "입금자명 불일치" }
```

### `POST /internal/admin/broadcast`

```json
{ "title": "호스팅 공지", "message": "점검 안내" }
```

### `GET /internal/admin/settings`

### `PUT /internal/admin/settings/:key`

```json
{ "value": { "bankName": "국민은행" }, "admin": "operator-name" }
```

### `GET /internal/admin/pushbullet`

Pushbullet 연결 상태.

### `POST /internal/admin/payment-parser/preview`

부작용 없이 알림 파싱만 테스트합니다.

```json
{
  "title": "입금 알림",
  "body": "홍길동 3,900원 입금 잔액 50,000원",
  "appName": "국민은행",
  "source": "android"
}
```

## 웹훅

### `POST /v1/webhooks/notifications/:secret`

```json
{
  "source": "android",
  "appName": "국민은행",
  "title": "입금 알림",
  "body": "홍길동 3,900원 입금",
  "eventId": "optional-unique-id",
  "receivedAt": "2026-11-20T05:00:00.000Z"
}
```

- `body` 필수
- `source` 기본값 `android`
- `eventId`는 중복 제거에 사용
- 응답 `202 Accepted`

```json
{ "ok": true, "outcome": "matched" }
```

`outcome`: `ignored`, `duplicate`, `matched`, `manual_review`, `unmatched`

## 상태 코드

| 코드 | 의미 |
| --- | --- |
| 400 | 입력 오류 |
| 401 | API 키/웹훅 비밀값 오류 |
| 402 | 결제 필요 |
| 404 | 대상 없음 |
| 409 | 중복/상태 충돌 |
| 413 | 파일 크기 초과 |
| 422 | ZIP/봇/의존성 검증 실패 |
| 503 | Docker/외부 서비스 사용 불가 |
