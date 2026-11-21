# 운영 가이드

이 문서는 실제 서비스 운영에 필요한 점검, 입금 매칭 튜닝, 장애 대응 절차를 설명합니다.

## 1. 배포 체크리스트

- [ ] Supabase 마이그레이션 적용 (`0001_init.sql`, `0002_safety.sql`, `0003_automation.sql`)
- [ ] `TOKEN_ENCRYPTION_KEY` 백업 (분실 시 기존 봇 토큰 복호화 불가)
- [ ] `BOT_API_KEY`와 `ADMIN_API_KEY`가 서로 다름
- [ ] `DOCKER_ENABLED=true`, `hostbot/runtime-node:22` 이미지 빌드 완료
- [ ] `/srv/hostbot/data`가 API 컨테이너와 Docker 데몬에서 동일 경로
- [ ] `hostbot-bots` 네트워크 ICC 비활성화 확인
- [ ] 관리 봇 슬래시 명령어 등록 (`npm run register-commands`)
- [ ] `MANAGEMENT_GUILD_ID`가 운영 서버 ID와 일치
- [ ] `ADMIN_DISCORD_IDS`에 운영자만 포함
- [ ] `ADMIN_LOG_CHANNEL_ID`가 관리 봇이 볼 수 있는 채널
- [ ] 웹 대시보드 `DASHBOARD_PASSWORD`, `DASHBOARD_SESSION_SECRET` 설정
- [ ] 실제 은행 앱/SMS 알림으로 파서 검증
- [ ] `CLAMAV_REQUIRED=true` 권장
- [ ] 서버 시계 NTP 동기화 (`timedatectl`)

## 2. 일상 점검

### 상태 확인

```bash
curl -s http://127.0.0.1:3001/health | jq
```

확인 항목:

- `ok: true`
- `dockerEnabled: true`
- `pushbullet.connected: true` (Pushbullet 사용 시)
- `pushbullet.lastEventAt`가 최근 은행 알림 시각과 일치

### Docker

```bash
docker ps --filter label=hostbot.managed=true
docker network inspect hostbot-bots
docker logs --tail 200 hostbot-api-1
docker logs --tail 200 hostbot-bot-1
```

### Supabase

- `payment_requests`: `awaiting_deposit`, `manual_review` 적체 확인
- `payment_notifications`: `manual_review`, `unmatched` 확인
- `notifications`: `failed` 확인
- `hosting_logs`: `error` 이벤트 확인

## 3. 입금 알림 파서 튜닝

### 3.1 미리보기 API

실제 알림 문구를 그대로 넣어 파싱 결과를 확인합니다. DB에 저장하지 않습니다.

```bash
curl -s -X POST http://127.0.0.1:3001/internal/admin/payment-parser/preview \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "appName": "국민은행",
    "title": "입금 알림",
    "body": "12/20 14:03 123456-78-901234 홍길동 3,900원 입금 잔액 50,000원"
  }' | jq
```

기대 결과:

```json
{
  "parsed": {
    "isDeposit": true,
    "amount": 3900,
    "depositorName": "홍길동",
    "depositorMasked": false,
    "bankName": "국민",
    "txnId": null,
    "confidence": "high",
    "reason": "ok"
  }
}
```

### 3.2 커스텀 규칙

`admin_settings.bank_parsers`에 JSON 배열을 저장합니다. 대시보드 `/settings`에서 편집할 수 있습니다.

```json
[
  {
    "id": "kb-card",
    "bankName": "국민",
    "keywords": ["국민은행", "KB"],
    "requireKeyword": true,
    "amountPatterns": ["입금\\s*([0-9,]+)\\s*원"],
    "depositorPatterns": ["입금자\\s*[:：]?\\s*([가-힣A-Za-z0-9*]{2,20})"],
    "txnIdPatterns": ["거래번호\\s*[:：]?\\s*([A-Za-z0-9-]{6,40})"]
  }
]
```

규칙 작성 시 주의:

- `amountPatterns`의 **첫 번째 캡처 그룹**이 금액이어야 합니다.
- `depositorPatterns`의 첫 번째 캡처 그룹이 입금자명이어야 합니다.
- `requireKeyword: true`이면 `keywords` 중 하나가 제목/본문/앱 이름에 포함될 때만 규칙이 적용됩니다.
- 정규식은 ReDoS를 유발하지 않도록 단순하게 유지하세요.
- 규칙을 추가한 뒤 반드시 미리보기 API로 실제 표본 5개 이상을 검증하세요.

### 3.3 신뢰도 규칙

- `high`: 명시적 입금액/입금자 라벨, 또는 `이름 + 금액 + 입금`이 명확한 문장
- `medium`: 금액과 입금자는 찾았지만 문맥이 약함
- `low`: 금액/이름 누락, 다중 후보, 마스킹, 애매한 문장

자동 승인은 `low`가 아니면서 금액·이름이 정확히 일치하고 열린 신청이 1건일 때만 수행됩니다.

## 4. 수동 결제 처리

1. 관리 봇의 `#관리자-알림` 또는 대시보드 `/payments`에서 대기 건 확인
2. 실제 입금 내역(은행 앱)과 금액·입금자명 대조
3. 일치하면 `/관리자 결제승인 HB-XXXXXX` 또는 대시보드 승인
4. 불일치/악성 주문이면 `/관리자 결제거절 HB-XXXXXX 사유`
5. 승인 후 봇은 자동으로 설치·시작됩니다. 실패하면 `/호스팅 로그` 확인

### 중복 입금이 의심될 때

- `payment_notifications`에서 같은 금액/입금자명의 `matched` 이벤트가 10분 내에 2건 이상인지 확인
- 이미 승인된 결제는 다시 승인되지 않습니다 (`request_not_pending`)
- 고객에게 환불 또는 추가 기간 부여 여부를 안내

### 환불 처리

대시보드 `/payments`의 결제 내역에서 **환불**을 누르거나 관리자 API를 호출합니다.

```bash
curl -s -X POST http://127.0.0.1:3001/internal/admin/payments/<payment-id>/refund \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"admin":"operator","reason":"중복 입금"}'
```

- 승인된 결제만 환불할 수 있습니다 (부분 환불 없음).
- 해당 결제가 부여한 기간(개월 × 30일)을 `expires_at`에서 차감합니다.
- 차감 후 만료 시각이 지나면 봇을 즉시 만료 처리하고 컨테이너를 중지합니다.
- 감사 로그(`audit_logs`, `payment.refund`)와 고객 DM/운영 알림이 남습니다.
- 실제 계좌 이체는 수동으로 처리해야 합니다. 시스템은 상태와 이용 기간만 되돌립니다.

### 만료 임박 알림

스케줄러가 6시간마다 D-3, D-1, 당일 순으로 갱신 안내 DM을 한 번씩 보냅니다. 결제가 승인되면
`hosted_bots.expiry_notice_days`가 초기화되어 다음 주기에 다시 안내합니다. 알림이 오지 않으면
`notifications`의 `bot_expiry_soon` 행과 관리 봇 폴러 로그를 확인하세요.

## 5. 장애 대응

### 봇이 시작하지 않음

1. `/호스팅 정보` 또는 대시보드에서 `last_error` 확인
2. `docker logs hostbot-<bot-id> --tail 200`
3. `hostbot-install-<bot-id>` 컨테이너가 남아 있는지 확인 후 제거
4. `package.json`의 `start`가 `node <파일>` 형식인지 확인
5. 네이티브 모듈 의존성 여부 확인 (지원 불가)
6. 필요 시 `/호스팅 재시작`

### `runtime_image_missing`

```bash
docker build -f infra/runtime-node/Dockerfile -t hostbot/runtime-node:22 .
```

### `docker_network_error`

```bash
docker network inspect hostbot-bots
docker network create \
  --driver bridge \
  --opt com.docker.network.bridge.enable_icc=false \
  --opt com.docker.network.bridge.enable_ip_masquerade=true \
  hostbot-bots
```

### API가 Docker에 연결하지 못함

```bash
ls -l /var/run/docker.sock
docker info
```

API 컨테이너에 소켓이 마운트되었는지 확인합니다.

### Pushbullet이 끊김

- API 로그에서 `Pushbullet stream closed`와 재연결 로그 확인
- Pushbullet 앱에서 알림 접근 권한/미러링이 꺼지지 않았는지 확인
- 토큰 재발급 시 `.env` 갱신 후 API 재시작
- 장기간 불안정하면 커스텀 Android 포워더 + 웹훅으로 전환

### 알림은 오는데 매칭이 안 됨

1. 미리보기 API로 파싱 결과 확인
2. `payment_notifications`의 `note`, `parse_confidence`, `status` 확인
3. 입금자명이 마스킹되어 있으면 자동 승인되지 않음 (의도된 동작)
4. 동일 금액의 열린 신청이 여러 건이면 수동 검토
5. `bank_parsers` 규칙 추가 후 재테스트

## 6. 백업과 복구

- Supabase: 일일 백업/PITR 활성화
- `/srv/hostbot/data`: 봇 소스와 메타데이터. 주기적 백업 권장
- `.env`: 비밀값이므로 안전한 비밀 관리 도구에 보관
- `TOKEN_ENCRYPTION_KEY` 분실 시 기존 토큰은 복구 불가 → 고객에게 토큰 재등록 요청

복구 순서:

1. Supabase 복구
2. `/srv/hostbot/data` 복구
3. API 기동 (스케줄러가 만료/재시작 조정)
4. 관리 봇 기동
5. `/health`, Docker 컨테이너 상태 확인

## 7. 보관/삭제 정책

- 만료/오류 봇의 소스와 토큰: `DATA_RETENTION_DAYS`(기본 30일) 후 삭제
- 고객이 삭제 요청: `/관리자 호스팅삭제` 또는 대시보드에서 즉시 삭제
- 결제 기록은 회계 목적상 익명화하여 보존
- 삭제 후 `hosted_bots` 행은 `deleted` 상태로 남고 소스/토큰/컨테이너는 제거

## 8. 확장 시 주의

현재 구조는 단일 API 인스턴스를 전제로 합니다.

- 알림 outbox: 여러 관리 봇이 동시에 폴링하면 중복 DM 가능 → `FOR UPDATE SKIP LOCKED` 기반 클레임 필요
- 스케줄러: 여러 API 인스턴스에서 실행되면 중복 만료/재시작 → Postgres advisory lock 필요
- Docker: 단일 VPS의 Docker 데몬을 공유. 다중 VPS로 확장하려면 봇별 노드 매핑과 원격 Docker API가 필요

## 9. 키 회전

`bot_secrets`는 AES-256-GCM으로 암호화되고 `key_version`을 함께 저장합니다. 회전 스크립트는 기존 키로
복호화한 뒤 새 키로 다시 암호화하며, `--apply` 없이는 드라이런입니다.

1. 새 키 생성:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
2. 드라이런 (DB 변경 없음):
   ```bash
   cd apps/api
   TOKEN_ENCRYPTION_KEY=<기존 키> NEW_TOKEN_ENCRYPTION_KEY=<새 키> npm run rotate-token-key
   ```
3. 결과 확인 후 실제 적용:
   ```bash
   TOKEN_ENCRYPTION_KEY=<기존 키> NEW_TOKEN_ENCRYPTION_KEY=<새 키> npm run rotate-token-key -- --apply
   ```
4. `.env`의 `TOKEN_ENCRYPTION_KEY`를 새 키로 교체하고 API 재시작
5. 드라이런을 한 번 더 실행해 `already uses the new key`만 나오는지 확인

스크립트는 이미 새 키로 회전된 행을 건너뛰므로 재실행해도 안전합니다. 실패한 행이 있으면 종료 코드 1과
함께 `bot_id`가 출력되며, 해당 봇은 토큰 재등록이 필요할 수 있습니다. 회전 중에도 API는 기존 키로 계속
동작하므로, 트래픽이 적은 시간에 실행하세요.

자동화 전에는 키를 변경하지 마세요.
