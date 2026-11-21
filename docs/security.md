# 보안 모델

이 문서는 HostBot의 위협 모델과 구현된 방어 조치, 운영자가 추가로 해야 할 일을 정리합니다.

## 1. 신뢰 경계

| 구성 요소 | 신뢰 수준 | 비고 |
| --- | --- | --- |
| Discord 고객 | 낮음 | 임의 ZIP/토큰 업로드 |
| 관리 봇 | 중간 | `BOT_API_KEY` 보유, 운영자 서버에만 존재 |
| API 서버 | 높음 | Supabase service role, Docker socket |
| Supabase | 높음 | RLS로 외부 접근 차단 |
| 관리자 대시보드 | 중간 | 비밀번호 + 서명 쿠키 |
| 은행 알림 | 낮음 | 위조/중복/누락 가능 |
| 고객 봇 컨테이너 | 낮음 | 임의 코드 실행 |

## 2. 고객 코드 격리

- 봇은 `hostbot/runtime-node:22` 이미지에서 UID/GID `10001`로 실행
- `CapDrop: ["ALL"]`, `no-new-privileges`
- CPU, 메모리(+스왑), PID, `/tmp` 크기 제한
- 전용 브리지 네트워크 `hostbot-bots`, ICC 비활성화로 봇 간 통신 차단
- 컨테이너 재시작 정책 `no` (API 스케줄러가 제어)
- Docker 로그 로테이션 (`max-size=5m`, `max-file=2`)
- 호스트 디렉터리는 봇별 `data/bots/<uuid>/app`만 바인드
- `Docker socket`은 API에만 마운트. 고객 봇에는 절대 마운트하지 않음

### 남는 위험

- 고객 봇은 인터넷에 접근할 수 있습니다. 악성 봇이 외부 공격/스팸에 사용될 수 있으므로 약관, 신고 채널, 신속한 정지 절차가 필요합니다.
- API 컨테이너는 Docker socket을 통해 호스트 root와 동급입니다. API 침해 시 호스트 전체가 위험합니다. 호스팅 전용 VPS로 분리하세요.
- 커널 공유 컨테이너 격리는 VM 수준이 아닙니다. 고위험 고객을 받는다면 gVisor/Kata/Firecracker 같은 강화 격리를 검토하세요.

## 3. 업로드 검증

`apps/api/src/services/zip.ts`에서 다음을 검사합니다.

- ZIP 크기 20MB, 파일 수 1,500, 총 해제 150MB, 단일 파일 25MB
- 압축률 200배 초과 시 ZIP 폭탄 의심
- 절대 경로, `..`, 역슬래시, NUL, 정규화되지 않은 경로 차단
- 심볼릭 링크 차단
- 금지 확장자: 실행 파일, 스크립트, 네이티브 바이너리, `.sh`, `.py`, `.php` 등
- 금지 파일: `.env`, `.npmrc`, `.yarnrc`, `.gitconfig`, `.bashrc`, `.profile`
- `package.json`의 `dependencies`에서 `git:`, `http:`, `file:`, `link:`, `workspace:` 차단
- 진입점은 `.js`/`.mjs`/`.cjs`만 허용
- `npm install --omit=dev --ignore-scripts`로 lifecycle script 실행 차단

ClamAV(clamd)를 설정하면 ZIP과 압축 해제 결과를 검사합니다. 운영에서는 `CLAMAV_REQUIRED=true`를 권장합니다.

## 4. 토큰 보호

- AES-256-GCM, 12바이트 랜덤 IV, 16바이트 auth tag
- AAD에 `hostbot:bot-token:<bot_id>`를 바인딩해 행 교체 공격 방지
- 암호문만 `bot_secrets.token_encrypted`에 저장
- SHA-256 지문으로 중복 등록 차단
- 목록/상세/알림 payload에 토큰 미포함
- 로그 출력 시 토큰 문자열과 Discord 토큰 패턴 마스킹
- 컨테이너에는 환경변수로 주입되므로 `docker inspect` 권한자는 볼 수 있음 → Docker 접근 권한을 최소화

## 5. API 인증

- 관리 봇 → API: `x-bot-api-key` (`BOT_API_KEY`)
- 대시보드/운영 도구 → 관리자 API: `x-admin-api-key` (`ADMIN_API_KEY`)
- 두 키는 반드시 달라야 하며 설정 로드 시 검증
- 웹훅: URL 경로의 `NOTIFICATION_WEBHOOK_SECRET` 상수 시간 비교
- CORS는 `CORS_ORIGIN`이 설정된 경우에만 활성화

### 개선 권장

- API를 사설 네트워크/VPN에 두고 관리 봇과 웹만 접근
- 리버스 프록시에서 rate limit, IP allowlist, WAF 적용
- 웹훅 비밀값을 헤더 방식으로도 지원하도록 확장
- 관리자 API에 요청 서명/HMAC 추가

## 6. 데이터베이스

- 모든 public 테이블 RLS 활성화
- `anon`, `authenticated` 권한 회수
- API만 service role 사용
- 결제 승인/거절은 `security definer` RPC로 원자 처리
- `approve_payment_request`는 행 잠금(`for update`)으로 중복 승인 방지
- 감사 로그(`audit_logs`)에 승인/거절/삭제 기록

### 주의

- Supabase service role 키가 유출되면 전체 DB가 노출됩니다. Vercel/VPS 환경변수 접근을 최소화하세요.
- Supabase 대시보드 계정에 MFA를 설정하세요.

## 7. 대시보드

- 단일 비밀번호 + HMAC 서명 세션 쿠키
- 쿠키: `HttpOnly`, `SameSite=Lax`, 운영에서 `Secure`
- 세션 8시간
- 서버 액션에서 API 키를 사용하며 브라우저에 노출하지 않음

### 개선 권장

- Discord OAuth + 운영자 ID 검증으로 전환
- 로그인 rate limit 및 감사 로그
- Vercel Deployment Protection 또는 사설망 제한

## 8. 입금 사기 대응

자동 승인은 다음을 모두 요구합니다.

- 정확한 금액
- 정확한 입금자명 (마스킹 불가)
- 열린 신청 정확히 1건
- 중복 알림 아님
- `low` 신뢰도 아님

추가 방어:

- 동일 금액 다건 → 수동 검토
- 입금자명 불일치 → 수동 검토
- 알림 파싱 실패 → 수동 검토
- 승인 RPC가 상태를 재확인하므로 이중 승인 불가

### 남는 위험

- 공격자가 피해자의 입금자명과 금액을 알고 먼저 입금해 신청을 가로챌 수 있습니다. 고객별 고유 금액(예: 3,901원)이나 신청 코드를 입금자명에 포함하는 방식으로 개선할 수 있습니다.
- 은행 알림이 지연/누락되면 자동 승인되지 않습니다. 운영자가 수동 확인해야 합니다.
- 앱 알림과 SMS가 동시에 오는 경우 중복 제거가 완벽하지 않을 수 있습니다. 승인 RPC의 상태 검사가 최후 방어선입니다.

## 9. 사고 대응

1. API와 관리 봇 중지
2. Docker 네트워크/컨테이너 전체 중지 (`docker ps -q --filter label=hostbot.managed=true | xargs -r docker stop`)
3. Supabase 키, `BOT_API_KEY`, `ADMIN_API_KEY`, `TOKEN_ENCRYPTION_KEY`, Discord 토큰 회전
4. 감사 로그와 API 로그 보존
5. 고객 봇 토큰은 고객에게 재발급 요청 (서버 측에서 복호화 후 재암호화 가능)
6. 필요 시 호스트 재설치

## 10. 체크리스트

- [ ] 호스팅 전용 VPS
- [ ] SSH 키 인증, root 로그인 금지, 방화벽
- [ ] Docker socket 접근 권한 최소화
- [ ] HTTPS 강제
- [ ] Supabase MFA + 백업
- [ ] `CLAMAV_REQUIRED=true`
- [ ] 로그에 토큰/개인정보 없음
- [ ] 정기적인 의존성 업데이트 (`npm audit`)
- [ ] 실제 은행 알림 표본으로 파서 회귀 테스트
