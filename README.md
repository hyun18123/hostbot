# HostBot — 디스코드 봇 호스팅 플랫폼

디스코드 봇을 ZIP으로 업로드하고, 입금 확인 후 Docker 컨테이너로 30일간 실행해 주는 유료 호스팅 서비스입니다. 관리 봇은 운영자 서버에서만 동작하며, 고객 봇은 고객이 초대한 모든 서버에서 사용할 수 있습니다.

```
고객 Discord ──/호스팅 등록──▶ 관리 봇 ──multipart──▶ API ──▶ Supabase
                                   │                    │
                                   │                    ├─ ZIP 검사/압축 해제
                                   │                    ├─ Discord 토큰 검증
                                   │                    └─ Docker 컨테이너 실행
                                   │
은행 앱/SMS ──Pushbullet/watcher──▶ webhook ──▶ 입금 매칭 ──▶ 자동 승인
                                   │
관리 봇 ◀──알림 outbox── API ◀──────┘
운영자 웹 대시보드(Next.js/Vercel) ──▶ 관리자 API
```

## 구성

| 경로 | 설명 |
| --- | --- |
| `apps/api` | Fastify API. ZIP 검증, Supabase, Docker, 입금 매칭, 스케줄러 |
| `apps/bot` | discord.js 관리 봇. 한국어 슬래시 명령어, DM/운영 알림 |
| `apps/web` | Next.js 운영자 대시보드 (Vercel 배포 가능) |
| `packages/shared` | 가격, 상태, 스키마, 날짜/이름 유틸리티 |
| `supabase/migrations` | PostgreSQL 스키마, RLS 잠금, 결제 승인/거절 RPC |
| `infra` | 봇 런타임 이미지, API/봇 이미지, Docker Compose |
| `docs` | 운영/배포 문서 |

## 가격과 결제 정책

- 봇 1개 / 30일 = **3,900원**
- 무료 체험 없음, 계좌이체만 지원
- 봇마다 독립적으로 결제·만료
- 결제 기한: 신청 후 7일
- 만료 시 해당 봇만 중지되고, 재결제하면 자동 재시작
- 만료/중지 후 소스와 토큰은 기본 30일 보관 뒤 삭제

### 자동 승인 조건

아래 조건을 **모두** 만족할 때만 자동 승인합니다.

1. 파싱된 금액이 결제 신청 금액과 정확히 일치
2. 입금자명이 신청 시 등록한 이름과 정확히 일치 (마스킹 불가)
3. 해당 금액의 열린 결제 신청이 정확히 1건
4. 같은 알림이 중복 수신되지 않음
5. 파싱 신뢰도가 `low`가 아님

하나라도 어긋나면 자동 승인하지 않고 관리자 알림으로 보냅니다. 은행 앱 알림과 SMS가 동시에 오는 경우를 대비해 거래번호/이벤트 ID/금액+입금자명+시간 버킷 기반 중복 제거를 수행합니다.

> **중요:** 은행마다 알림 문구가 다릅니다. 운영 전에 실제 수신 알림으로 `bank_parsers`를 반드시 검증하세요. 자세한 내용은 [docs/operations.md](docs/operations.md).

## 빠른 시작 (로컬 개발)

### 1. 요구 사항

- Node.js 22 이상
- Supabase 프로젝트
- (선택) Docker Desktop 또는 Linux VPS의 Docker

### 2. Supabase 준비

Supabase SQL Editor에서 `supabase/migrations`의 SQL 파일을 순서대로 실행합니다. 또는 Supabase CLI를 사용합니다.

```bash
supabase link --project-ref <project-ref>
supabase db push
```

### 3. 환경 변수

```bash
cp .env.example .env
```

필수 값:

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `BOT_API_KEY`, `ADMIN_API_KEY` (서로 다른 32바이트 이상 비밀값)
- `TOKEN_ENCRYPTION_KEY` (base64 32바이트)
- `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `MANAGEMENT_GUILD_ID`
- `ADMIN_DISCORD_IDS`
- `BANK_*` 또는 대시보드의 `bank_account` 설정

키 생성:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

로컬에서 Docker 없이 실행하려면 `DOCKER_ENABLED=false`로 둡니다. 이 모드에서는 컨테이너 작업이 시뮬레이션됩니다.

### 4. 설치와 실행

```bash
npm install
npm run typecheck
npm test

npm run dev:api        # http://localhost:3001
npm run dev:bot
npm run dev:web        # http://localhost:3000
```

슬래시 명령어 등록:

```bash
npm run register-commands
```

`DISCORD_DEV_GUILD_ID`가 있으면 해당 길드에만 즉시 등록되고, 없으면 전역 등록되어 전파에 최대 1시간이 걸릴 수 있습니다.

## 프로덕션 배포 (Linux VPS)

### 1. 봇 런타임 이미지 빌드

```bash
docker build -f infra/runtime-node/Dockerfile -t hostbot/runtime-node:22 .
```

### 2. 데이터 디렉터리

API와 Docker 데몬이 **같은 절대 경로**를 봐야 합니다.

```bash
sudo mkdir -p /srv/hostbot/data
sudo chown -R 1000:1000 /srv/hostbot/data   # API 컨테이너 실행 계정에 맞게 조정
```

### 3. `.env` 설정

```env
NODE_ENV=production
DOCKER_ENABLED=true
DATA_DIR=/srv/hostbot/data
BOT_DOCKER_NETWORK=hostbot-bots
BOT_RUNTIME_IMAGE=hostbot/runtime-node:22
```

`DATABASE`가 아니라 Supabase service role key를 사용합니다. 이 키는 절대 브라우저에 노출하지 마세요.

### 4. 기동

```bash
docker compose -f infra/docker-compose.yml up -d --build
curl http://127.0.0.1:3001/health
```

API는 `/var/run/docker.sock`을 마운트하므로 사실상 호스트 root 권한과 동급입니다. 운영 서버를 호스팅 전용으로 분리하고, SSH 접근을 제한하세요.

### 5. 웹 대시보드 (Vercel)

Vercel 프로젝트 루트를 `apps/web`으로 지정하고 환경 변수를 설정합니다.

```env
API_BASE_URL=https://api.example.com
ADMIN_API_KEY=<API와 동일>
DASHBOARD_PASSWORD=<강한 비밀번호>
DASHBOARD_SESSION_SECRET=<32바이트 이상 랜덤>
```

Next.js `output: "standalone"`이 설정되어 있습니다. API는 HTTPS로 공개되어야 하며, 방화벽에서 대시보드/관리자 접근을 추가 제한하는 것을 권장합니다.

## 명령어

### 사용자

| 명령어 | 설명 |
| --- | --- |
| `/호스팅 등록` | ZIP 첨부 후 모달에서 봇 이름·토큰·입금자명 입력 |
| `/호스팅 목록` | 내 봇 목록 |
| `/호스팅 정보` | 상태, 만료일, 최근 오류 |
| `/호스팅 시작` | 봇 시작 (결제 필요) |
| `/호스팅 종료` | 봇 중지 |
| `/호스팅 재시작` | 재시작 |
| `/호스팅 로그` | 최근 실행 로그 (토큰 자동 마스킹) |
| `/결제 신청` | 봇 선택 후 입금자명 입력, 계좌 안내 |
| `/결제 상태` | 신청/승인 내역 |
| `/요금제` | 가격과 계좌 안내 |

### 운영자

`/관리자` 명령어는 목록에는 보일 수 있지만, 실행 시 `ADMIN_DISCORD_IDS`에 등록된 사용자만 통과합니다. Discord 서버 설정의 명령어 권한으로도 추가 제한할 수 있습니다.

| 명령어 | 설명 |
| --- | --- |
| `/관리자 통계` | 사용자/봇/매출/대기 건수 |
| `/관리자 결제내역 [status]` | 결제 신청/승인 조회 |
| `/관리자 결제승인 code` | 수동 승인 (승인 후 자동 시작) |
| `/관리자 결제거절 code reason` | 수동 거절 |
| `/관리자 호스팅정지 bot` | 강제 정지 |
| `/관리자 호스팅삭제 bot confirm` | 소스/토큰/컨테이너 삭제, 결제 기록은 익명 보관 |
| `/관리자 공지 message` | 전체 사용자 DM |
| `/관리자 설정 [key] [value]` | 설정 조회/변경 (JSON) |

## 은행 알림 연동

Pushbullet은 Android 알림 미러링을 위한 **공식 webhook을 제공하지 않습니다.** 공식 경로는 스트리밍 WebSocket(`wss://stream.pushbullet.com/streaming/<token>`)이며, 다음이 필요합니다.

1. Pushbullet Android 앱 설치 및 로그인
2. 알림 접근 권한 허용
3. 알림 미러링 활성화
4. SMS 미러링을 쓰려면 SMS 권한 허용
5. `PUSHBULLET_ACCESS_TOKEN` 설정

API는 `mirror` push와 `sms_changed` push를 모두 처리합니다. 알림 문구는 은행/앱/OS마다 다르므로 고정 형식을 가정하지 않습니다.

Pushbullet 대신 커스텀 Android 포워더를 쓸 경우:

```bash
curl -X POST "https://api.example.com/v1/webhooks/notifications/$NOTIFICATION_WEBHOOK_SECRET" \
  -H "content-type: application/json" \
  -d '{
    "source": "android",
    "appName": "국민은행",
    "title": "입금 알림",
    "body": "홍길동 3,900원 입금 잔액 50,000원",
    "eventId": "vendor-unique-id",
    "receivedAt": "2026-11-20T05:00:00.000Z"
  }'
```

웹훅 비밀값은 URL 경로에 포함됩니다. HTTPS를 강제하고 리버스 프록시 로그에서 경로를 마스킹하거나, 별도 사설망/VPN으로 제한하세요.

## 보안 설계

- 봇 토큰은 AES-256-GCM으로 암호화해 `bot_secrets`에만 저장하며, 목록/조회 응답에는 절대 포함하지 않습니다.
- 토큰 지문(SHA-256)으로 동일 토큰 중복 등록을 차단합니다.
- Supabase RLS를 켜고 `anon`/`authenticated` 권한을 회수합니다. API만 service role을 사용합니다.
- ZIP 검사: 경로 탈출, 절대 경로, 심볼릭 링크, ZIP 폭탄(압축률/총량/단일 파일), 금지 확장자, `.env`/`.npmrc` 차단.
- 의존성 설치는 `npm install --omit=dev --ignore-scripts`로 수행합니다. 네이티브 모듈은 지원하지 않습니다.
- 컨테이너: 비루트 UID 10001, `CapDrop: ALL`, `no-new-privileges`, CPU/메모리/PID/스토리지 제한, 전용 브리지 네트워크(ICC 차단).
- 로그에서 토큰 패턴을 마스킹합니다.
- 관리자 API 키와 관리 봇 API 키를 분리합니다.
- ClamAV(clamd) 연동은 선택이지만 운영 환경에서는 `CLAMAV_REQUIRED=true`를 권장합니다.

자세한 내용은 [docs/security.md](docs/security.md).

## 운영 자동화

- **만료 임박 알림**: 스케줄러가 6시간마다 D-3, D-1, 당일 갱신 안내 DM을 한 번씩 발송합니다. 결제 승인 시 `expiry_notice_days`가 초기화됩니다.
- **환불**: 대시보드 `/payments` 또는 `POST /internal/admin/payments/:id/refund`. 결제 1건 전액 환불만 지원하며, 해당 기간만큼 이용 만료일을 차감하고 필요 시 봇을 중지합니다. 실제 계좌 이체는 수동입니다.
- **토큰 키 회전**: `npm run rotate-token-key -w @hostbot/api` (기본 드라이런, `-- --apply`로 적용). 절차는 [docs/operations.md](docs/operations.md).
- **파서 프리뷰**: 대시보드 `/parser`에서 실제 알림 문구를 저장 없이 파싱해 볼 수 있습니다.
- **봇 상세/로그**: 대시보드 `/bots/:id`에서 상태, 컨테이너 로그, 호스팅 이벤트, 재시작/정지/삭제를 처리합니다.

## 테스트

```bash
npm test
npm run typecheck
```

현재 테스트는 공유 유틸리티와 은행 알림 파서에 집중되어 있습니다. 실제 은행 알림 표본으로 파서 테스트를 추가하는 것이 좋습니다.

## 알려진 제한

- 관리 봇/API/스케줄러는 **단일 인스턴스** 전제입니다. 수평 확장 시 알림 outbox 클레임과 스케줄러 advisory lock을 추가해야 합니다.
- 네이티브 addon, Python, Java, 빌드 도구가 필요한 봇은 실행할 수 없습니다.
- 은행 API 연동이 아니라 **알림 기반** 입금 감지입니다. 알림이 누락되면 자동 승인되지 않습니다.
- 환불은 결제 1건 전액만 지원하며, 실제 계좌 이체는 수동입니다. 부분 환불 자동화는 없습니다.
- 토큰 키 회전은 `rotate-token-key` 스크립트로 수행합니다. 회전 중 신규 등록은 잠시 피하는 것을 권장합니다.
- 웹 대시보드는 단일 운영자 비밀번호 방식입니다. 다중 운영자/감사 로그 UI는 포함되어 있지 않습니다.

## 문서

- [운영 가이드](docs/operations.md)
- [보안 모델](docs/security.md)
- [API 레퍼런스](docs/api.md)
#   h o s t - b o t  
 