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

- 조작: 마우스 방향 또는 WASD/방향키, **Space/클릭** 부스트 (모바일: 왼쪽 조이스틱 + 오른쪽 부스트)
- 오프라인 모드(서버 없이 코어만): `http://localhost:5173/?mode=offline`
- API 주소가 다르면: `?api=http://host:port`

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
- **영속화**: 저장소 인터페이스 + 인메모리 구현. PostgreSQL/Redis는 어댑터 교체 지점.

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
| `pnpm test:bots` | 봇 채움/제거, 펠릿 수집, 경계·몸통 회피 |
| `pnpm test:tick-budget` | 60 스네이크 부하 tick P95 < 10ms |
| `pnpm test:api` | 토큰 발급/갱신, 닉네임 정책, matchId 멱등, 리더보드 |
| `pnpm test:matchmaker` | 1회용 joinToken, 10초 재연결 회수, 결과 파이프 |
| `bash scripts/smoke.sh` | api+게임서버 통합: 티켓 입장→사망→전적 저장 |
| `pnpm test:e2e` | Playwright: 랜딩→로비→플레이→사망→결과→다시하기 |

## 환경 변수

| 변수 | 기본값 | 용도 |
|---|---|---|
| `API_PORT` / `PORT` | 8080 / 2567 | api / game-server 포트 |
| `SERPENT_TOKEN_SECRET` | dev 기본값 | 토큰 서명 (api·game-server 공유) |
| `SERPENT_INTERNAL_SECRET` | dev 기본값 | 결과 저장 내부 인증 |
| `SERPENT_REQUIRE_JOIN_TOKEN` | (off) | `1`이면 joinToken 없이 입장 불가 |
| `SERPENT_API_URL` | (off) | 설정 시 사망 결과를 api에 저장 |
| `SERPENT_GAME_ENDPOINT` | ws://localhost:2567 | 티켓이 가리키는 WS 주소 |
| `SERPENT_CORS_ORIGIN` | `*` | 운영 시 오리진 제한 |

## 범위 밖 (미구현)

실배포/클라우드/멀티리전/오토스케일, PostgreSQL/Redis 실연동, 실사용자 목표 동접 1.5배
부하 테스트, 계정 연결(소셜/이메일), 미션/시즌/이벤트(Phase 2+). 자세한 결정 기록은
`.forge/done/*/run.md` 참고.

## 고지

본 프로젝트는 기존 서비스의 소스·상표·자산을 사용하지 않고, 공개적으로 관찰 가능한
장르 메커니즘만을 바탕으로 한 독자 구현입니다. 빈 방에는 서버 봇이 포함될 수 있습니다.
