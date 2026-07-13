# Serpent Arena

브라우저에서 설치 없이 접속해, 짧은 시간 동안 다른 플레이어와 성장·회피·유도 충돌을 겨루는
**서버 권위형 실시간 멀티플레이 2D 스네이크 아레나**입니다.
[PRD](./snake_arena_PRD_v1.2_loop_engineering.md) 기준 M0~M6 로컬 검증 범위가 구현되어 있습니다.

- 서버가 이동·충돌·점수를 최종 판정 (클라이언트 좌표/점수 위조 불가)
- 20Hz 고정 틱 시뮬레이션 · 10Hz AOI/델타 스냅샷 · 클라이언트 예측/보간
- 게스트 인증 → 매치 티켓(1회용 joinToken) → 입장 → 사망 결과 영속 저장
- 봇 채움, 10초 재연결, 방 내 리더보드, 스킨 8종, 모바일 가상 조이스틱

## 빠른 시작

요구 사항: Node 22+, pnpm 10+

```bash
pnpm install

# 터미널 3개로 각각 실행
pnpm --filter @serpent/api dev          # REST API + 매치메이커  :8080
pnpm --filter @serpent/game-server dev  # Colyseus 게임 서버     :2567
pnpm --filter @serpent/web dev          # 웹 클라이언트          :5173
```

브라우저에서 `http://localhost:5173` → **PLAY** → 닉네임/스킨 선택 → 입장.

PostgreSQL·Redis까지 포함한 로컬 개발 환경은 아래처럼 실행합니다. `.env.example`을
`.env`로 복사한 뒤 로컬 전용 비밀값을 바꾸고 `pnpm local`을 실행하세요.

```bash
cp .env.example .env
pnpm local
```

상태 서비스만 시작하거나 Compose 구성을 확인하려면 다음을 사용합니다.

```bash
docker compose -f infra/docker-compose/docker-compose.yml up -d --wait
pnpm infra:check
DATABASE_URL=postgres://serpent:serpent_dev_only@127.0.0.1:5432/serpent pnpm smoke:postgres
REDIS_URL=redis://127.0.0.1:6379 pnpm smoke:redis
```

- 조작: 마우스 방향 또는 WASD/방향키, **Space/클릭** 부스트 (모바일: 왼쪽 조이스틱 + 오른쪽 부스트)
- 오프라인 모드(서버 없이 코어만): `http://localhost:5173/?mode=offline`
- API 주소가 다르면: `?api=http://host:port`
- 프로덕션 빌드는 설치형 PWA 메타데이터와 앱 셸 오프라인 캐시를 제공합니다. 인증·API·실시간 WebSocket 요청은 캐시하지 않습니다.

## 모노레포 구조

```
apps/
├─ web/          # React 셸(랜딩/로비/HUD/결과) + Phaser 렌더 + 예측/보간
├─ game-server/  # Colyseus 권위형 Room: 틱/AOI/봇/joinToken/재연결/리더보드
└─ api/          # Fastify: 게스트 인증, 프로필, 매치 티켓, 전적/리더보드
packages/
├─ game-core/    # 결정적 시뮬레이션 (이동/충돌/펠릿) + Spatial Hash — 서버·클라 공유
├─ protocol/     # 메시지 스키마 + 입력 런타임 검증 — 단일 정의 공유
└─ config/       # GameConfig (버전 관리되는 밸런스 설정, PRD 부록 B)
scripts/         # verify / smoke / e2e 하네스
```

핵심 설계 (PRD §8~9):

- **서버 권위**: 클라이언트는 `seq·방향·부스트`만 전송. 좌표/점수/길이는 수신 자체가 없고,
  NaN·seq 역행·초당 빈도 초과 입력은 폐기된다 (§14.2).
- **결정성**: `game-core`는 시드 PRNG + 고정 dt — 동일 seed·입력이면 동일 상태.
  이동 적분(`stepSnakeMovement`)을 서버와 클라이언트 예측기가 공유해
  reconciliation 재적용 오차가 0이다.
- **지연 감추기**: 내 뱀은 즉시 로컬 예측 + 서버 tickId 정렬 replay,
  다른 뱀은 100ms 보간 버퍼(최대 200ms 외삽). ping/pong으로 RTT/offset 추정.
- **AOI**: interest 1,500 / despawn 1,800 hysteresis — 관심 영역 밖 엔터티는
  전송하지 않는다. 몸통은 경로 키포인트 델타, 펠릿은 청크 배치 동기화 (§9.8).
- **영속화/제한**: `DATABASE_URL`이 설정되면 PostgreSQL 저장소(사용자·전적·랭킹·로드아웃·제재·설정·분석)를 사용합니다. `REDIS_URL`이 설정되면 게스트·토큰 갱신·매칭 티켓·신고·분석 이벤트의 계정/IP 제한을 모든 API 인스턴스에서 공유하는 원자 카운터로 적용합니다. 두 변수 모두 미설정인 개발/단위 테스트에서는 인메모리 구현으로 폴백합니다.

## 검증 게이트

CI/로컬 공용 명령. 전부 통과가 머지 기준이다 (PRD §21 Loop Engineering).

| 명령 | 검증 내용 |
|---|---|
| `bash scripts/verify.sh` | lint + typecheck + 전체 테스트 + build |
| `pnpm test:determinism` | 동일 seed+입력 1,000틱 상태 동일성 |
| `pnpm test:authority` | 좌표/점수 위조 무영향, 비정상 입력 폐기 |
| `pnpm test:aoi` | AOI 밖 미전송, enter/leave 정확 1회, hysteresis |
| `pnpm test:netem` | RTT 100ms·지터 30ms·손실 5%에서 보정 P95 ≤ 반경×0.5 |
| `pnpm test:soak` | 12,000틱(10분 시뮬) 자동 플레이 무예외 + 불변식 |
| `pnpm test:soak:6h` | 릴리즈 전 6시간 시뮬 soak: 경로/펠릿/충돌 인덱스 불변식 |
| `pnpm test:soak:24h` | 야간 24시간 시뮬 soak (동일한 결정적 입력) |
| `pnpm test:bots` | 봇 채움/제거, 펠릿 수집, 경계·몸통 회피 |
| `pnpm test:tick-budget` | 60 스네이크 부하 tick P95 < 10ms |
| `pnpm test:api` | 토큰 발급/갱신, 닉네임 정책, matchId 멱등, 리더보드 |
| `pnpm test:matchmaker` | 1회용 joinToken, 10초 재연결 회수, 결과 파이프 |
| `bash scripts/smoke.sh` | api+게임서버 통합: 티켓 입장→drain 리허설→사망→전적 저장 |
| `pnpm test:e2e` | Playwright: 랜딩→로비→플레이→사망→결과→다시하기 |
| `pnpm check:web-budget` | 빌드 산출물의 초기 정적 JS gzip 500KB 예산 검사 |
| `pnpm check:assets` | PWA 정적 자산 manifest의 version/hash/size 무결성 검사 |
| `pnpm check:dependencies` | 설치된 의존성의 라이선스 허용 정책 검사 |
| `pnpm sbom` | 배포 artifact용 CycloneDX 1.5 SBOM 생성 (`artifacts/sbom.cdx.json`) |
| `pnpm infra:check:kubernetes` | API·게임 서버 Deployment/HPA/PDB 및 probe manifest 스키마 검사 |

## 환경 변수

| 변수 | 기본값 | 용도 |
|---|---|---|
| `API_PORT` / `PORT` | 8080 / 2567 | api / game-server 포트 |
| `SERPENT_TOKEN_SECRET` | dev 기본값 | 토큰 서명 (api·game-server 공유) |
| `SERPENT_INTERNAL_SECRET` | dev 기본값 | 결과 저장 내부 인증 |
| `SERPENT_ADMIN_SECRET` | (없음: 관리자 API 비활성) | 제재·설정 롤아웃 관리자 인증 |
| `SERPENT_ADMIN_ROLE_SECRETS` | (없음) | 선택적 `{ "viewer": "…", "operator": "…", "owner": "…" }` 역할별 관리자 비밀 |
| `SERPENT_ADMIN_TOTP_SECRET` | (없음) | base32 TOTP MFA 비밀. production에서는 관리자 변경 API에 필수 |
| `SERPENT_GAME_OPS_ENDPOINT` | (없음) | API가 관리자 세션으로 프록시할 게임 서버 운영 endpoint |
| `SERPENT_GAME_OPS_SECRET` | admin secret | API→게임 서버 메트릭 프록시 전용 비밀 |
| `SERPENT_REQUIRE_JOIN_TOKEN` | (off) | `1`이면 joinToken 없이 입장 불가 |
| `SERPENT_API_URL` | (off) | 설정 시 사망 결과를 api에 저장 |
| `SERPENT_CONFIG_URL` | (off) | 게임 서버가 부팅 시 읽을 버전 설정 API |
| `SERPENT_CONFIG_ROLLOUT_KEY` | (off) | 단계 배포 대상 선택에 쓰는 고정 게임 서버 인스턴스 키 |
| `SERPENT_RESULT_OUTBOX_PATH` | (off) | 설정 시 미전송 경기 결과를 JSON write-ahead outbox로 디스크에 보존 |
| `SERPENT_GAME_ENDPOINT` | ws://localhost:2567 | API의 단일 서버 폴백 및 게임 서버 registry가 가리키는 WS 주소 |
| `SERPENT_PUBLIC_GAME_ENDPOINT` | (없음) | Redis registry에 게시할 외부 접근 가능한 게임 서버 WS 주소 (`REDIS_URL` 사용 시 권장) |
| `SERPENT_INSTANCE_ID` | `game-<pid>` | Redis Room registry heartbeat 식별자 |
| `SERPENT_REGION` | `local` | 단일 서버 폴백 매치 타깃의 리전 |
| `SERPENT_MATCH_TARGETS` | (없음) | JSON 타깃 목록: region/endpoint/roomName/players/capacity/RTT/modes/draining |
| `SERPENT_TICK_DRAIN_P99_MS` | `80` | 이 값을 지속 초과한 Room의 자동 drain P99 tick 임계값(ms) |
| `SERPENT_TICK_DRAIN_SUSTAIN_MS` | `300000` | 자동 drain을 시작하기 전 초과가 지속되어야 하는 시간(ms) |
| `SERPENT_TICK_ALERT_P99_MS` | `45` | P1 tick P99 경보 임계값(ms) |
| `SERPENT_TICK_ALERT_SUSTAIN_MS` | `300000` | P1 tick 경보를 내기 전 초과 지속 시간(ms) |
| `SERPENT_RESULT_BACKLOG_ALERT` | `100` | P2 결과 outbox backlog 경보 임계값 |
| `SERPENT_ROOM_MAX_AGE_MS` | `1800000` | Room이 신규 매치를 받기 전 자동 drain하는 최대 수명(ms, 최소 1분) |
| `SERPENT_CORS_ORIGIN` | `http://localhost:5173` | 인증 API를 허용할 단일 웹 오리진 |
| `SERPENT_REFRESH_COOKIE` | `0` | `1`이면 refresh token을 HttpOnly Secure 쿠키로만 발급 (HTTPS 운영용) |
| `SERPENT_REQUEST_LOG` | `0` | `1`이면 reqId가 포함된 구조화 API 요청 로그 활성화 |
| `SERPENT_BANNED_WORDS` | (없음) | 쉼표/줄바꿈 기반 추가 금칙어. 기본 보호 목록에 추가 적용 |
| `DATABASE_URL` | (없음) | PostgreSQL 영속 저장소 URL |
| `REDIS_URL` | (없음) | Redis 분산 속도 제한 및 Room registry URL. 설정 시 API는 TTL heartbeat가 있는 게임 서버만 매칭하고, joinToken TTL 동안 원자적 슬롯 예약을 적용하며 Redis 장애 시 신규 매칭을 중단 |

운영 설정은 `PUT /v1/admin/config/activate`로 유효성 검증 뒤 새 `configVersion`을
활성화하고, `POST /v1/admin/config/rollback`으로 기록된 버전으로 되돌릴 수 있습니다.

개인정보 보존 작업은 owner 권한의 `POST /v1/admin/retention/run`으로 실행합니다. 원시
텔레메트리는 90일, 활동 없는 게스트 계정은 180일 뒤 기존 익명화 절차로 정리되며 결과는
관리자 감사 로그에 기록됩니다.
`SERPENT_CONFIG_URL=http://api:8080/v1/config/client`로 시작한 게임 서버는 활성 설정을
부팅 시 읽어 새 Room에 고정합니다. 방은 생성 시점의 설정을 유지하므로 버전 전환은
drain/restart와 결합합니다.

활성화 본문에 `rolloutPercent`(1~100)를 지정하면 새 버전은 해당 비율의 고정 인스턴스에만
배정됩니다. 각 게임 서버는 서로 다른 안정적인 `SERPENT_CONFIG_ROLLOUT_KEY`를 설정해야 하며,
키가 없는 서버는 직전 100% 안정 버전을 계속 사용합니다. 롤백은 항상 100%로 즉시 적용됩니다.
`POST /v1/admin/config/rollout`의 더 큰 `rolloutPercent`로 1→10→50→100%를 승격할 수 있으며,
연결된 게임 서버에 P1 경보가 있거나 메트릭 조회가 실패하면 API는 승격을 거부합니다.

`SERPENT_ADMIN_SECRET`가 설정된 게임 서버는 같은 비밀 헤더로 `GET /ops/metrics`를
보호합니다. 응답에는 활성 Room 수, 인간/봇 인원, Room별 tick P95/P99, 클라이언트가
측정해 보고한 평균 RTT, 오류 수와 Room별 오류율이 포함됩니다.
또한 `alerts`에는 5분 지속 tick P99 초과(P1), event-loop P99 지속 초과에 따른 인스턴스 드레이닝(P1), RTT P95 급증(P2), 오류율 증가(P3), 결과 outbox
backlog 초과(P2), snapshot payload P95 4KB 초과(P2)가 현재 활성 상태로 포함됩니다.
`SERPENT_SNAPSHOT_ALERT_P95_BYTES`로 마지막 임계값을 조정할 수 있습니다. 경보 상태는 Room drain과 별개이므로 운영자가
원인 확인 후 콘솔에서 단계 배포 중단·drain 등의 조치를 선택할 수 있습니다.
동일 응답의 `process`에는 RSS/heap/external 메모리와 event-loop lag P99도 포함됩니다.
같은 관리자 비밀로 보호되는 `GET /ops/prometheus`는 active rooms/players, Room별 tick·RTT·snapshot·egress와
프로세스 메모리/event-loop P99를 Prometheus text exposition 형식으로 제공합니다.
`POST /ops/drain`은 모든 활성 Room을 drain하고, `POST /ops/rooms/{roomId}/drain`은 한
Room만 drain합니다. drain된 Room은 신규 매칭을 받지 않지만 진행 중 게임과 재연결 grace는 유지합니다.

`infra/docker/`에는 API·게임 서버의 plain-Node production Dockerfile이 있고,
`infra/kubernetes/`에는 최소 2 replica API/게임 서버 Deployment, readiness/liveness probe,
PDB와 HPA가 있습니다. 게임 서버 `/healthz`는 자동/수동 drain 상태에서 503을 반환하므로
새 WSS 배정이 중단됩니다. Kubernetes가 설정하는 `SERPENT_GRACEFUL_SHUTDOWN=1`에서는 `SIGTERM`도 즉시 readiness를 내리고 Room drain을 시작하며,
새 연결 수신을 닫고
`SERPENT_SHUTDOWN_DRAIN_TIMEOUT_MS`(기본 110초) 뒤 프로세스를 종료합니다. HPA의 Room/event-loop 사용자 정의 Pod metric은 Prometheus Adapter
등의 metrics adapter에서 `/ops/metrics`를 변환하도록 배포 환경에 연결해야 합니다.

`?admin=1`로 웹을 열면 운영 콘솔이 표시됩니다. 콘솔은 관리자 비밀과 (운영 환경에서는)
TOTP를 입력받아 15분짜리 HttpOnly·SameSite=Strict 세션을 발급하고, 비밀을 브라우저 저장소에
보관하지 않습니다. API의 `SERPENT_GAME_OPS_ENDPOINT`를 설정하면 Room/인원/RTT/Tick P99/오류율을
서버 간 비밀로 프록시해 표시하며, 설정 버전·신고 큐·감사 로그도 함께 확인할 수 있습니다.
같은 콘솔의 `GET /v1/admin/api/metrics`는 개인정보나 요청 본문을 저장하지 않고 최근 60초 API의
RPS, 지연 P50/P95, 5xx 수와 오류율을 집계해 표시합니다. PostgreSQL 사용 시에는 pool 활성/대기 수와
포화도도 함께 표시하며, 메모리 저장소에서는 `null`로 명시합니다.
`GET /v1/admin/product/metrics?windowHours=24`는 퍼널 이벤트별 건수·익명화된 고유 사용자 수와
완료 경기·평균 생존 시간을 집계해 라이브 운영 지표를 제공합니다. 원시 사용자 ID와 이벤트 속성은
응답에 포함하지 않습니다. UTC 일자 기준 전일 가입 코호트의 D1과 7일 전 가입 코호트의 D7도
당일 telemetry 활동으로 집계합니다.
`GET`/`PUT /v1/admin/features`는 계정 연결, 미션, 이벤트 HUD, 신규 프로토콜의 공개 feature flag를
원자적으로 관리합니다. 플래그는 `/v1/config/client`에 포함되며 이벤트 HUD는 클라이언트에서 즉시 반영됩니다.
비활성화된 계정 연결·미션/시즌 API는 `feature_disabled`로 차단되고, 이벤트 조회는 빈 이벤트를 반환해
진행 중인 대전 경로에 영향을 주지 않습니다.
Room 표에는 AOI 엔터티 P95, snapshot payload P95와 최근 초당 전송량도 표시해 네트워크 예산을
게임 판정과 분리하여 점검할 수 있습니다.
`SERPENT_ADMIN_ROLE_SECRETS`를 설정하면 viewer는 운영 조회, operator는 공지·이벤트·시즌·drain,
owner는 feature/config 변경을 포함한 모든 관리자 작업을 수행합니다. 기존 `SERPENT_ADMIN_SECRET`은
owner 역할로 계속 호환됩니다.
테마 이벤트는 관리자 콘솔에서 시작/종료 시각과 선택적 대상 지역 목록으로 예약합니다. 대상 지역을
비우면 전 지역에 노출되고, 지정하면 매칭 티켓으로 확정된 해당 지역의 게임 HUD에만 표시됩니다.

배포 전 검증, 단계 롤아웃, Room drain, rollback 및 로컬 리허설의 실제 명령은
[배포·드레이닝·롤백 런북](docs/runbooks/deploy-drain-rollback.md)에 정리되어 있습니다.
전체 또는 개별 Room drain은 확인 대화상자 뒤에만 요청되고, 진행 중 경기는 유지하며 모든 요청은
감사 로그에 남습니다.
콘솔은 최대 280자 공지를 즉시 게시·해제할 수 있고, 신고 대상 계정에 사유가 포함된 24시간
제재를 요청할 수 있습니다. 두 동작 모두 관리자 MFA 세션과 API 검증·감사 로그를 통과합니다.

모든 API 응답은 `x-request-id`를 반환합니다. `SERPENT_REQUEST_LOG=1`에서는 같은 ID가
구조화 요청 로그에 남아 장애 보고를 API 요청 단위로 추적할 수 있습니다.
API는 `nosniff`, frame deny, no-referrer, same-site resource 정책을 기본 응답 헤더로 적용합니다.

인증된 사용자는 `DELETE /v1/me`로 삭제를 요청할 수 있습니다. 프로필·로드아웃·연결 ID·분석
이벤트는 제거되고, 운영 보존이 필요한 경기·신고 기록은 새 익명 식별자로 치환됩니다.

운영자는 `GET /v1/admin/reports?limit=50`으로 최근 신고 검토 큐를 확인할 수 있습니다.
이 응답은 신고 사유·세부 내용과 익명 사용자 식별자만 제공하며 IP 주소는 노출하지 않습니다.
조회 자체도 감사 로그에 기록됩니다.

## 외부 운영 전제

Redis Room registry, Kubernetes HPA/드레이닝 매니페스트, 관리자 콘솔, 단계적 설정 롤아웃과
자동 부하 시나리오는 저장소에 구현되어 있습니다. 실제 클라우드 계정·도메인·TLS 인증서·관리형
PostgreSQL/Redis 및 OAuth·이메일 검증 provider의 발급/연결은 배포 환경의 비밀값과 외부 계약이
필요하므로 운영자가 주입합니다. 이 경로가 없을 때 계정 연결 API는 안전하게 비활성화됩니다.

## 고지

본 프로젝트는 기존 서비스의 소스·상표·자산을 사용하지 않고, 공개적으로 관찰 가능한
장르 메커니즘만을 바탕으로 한 독자 구현입니다. 빈 방에는 서버 봇이 포함될 수 있습니다.
