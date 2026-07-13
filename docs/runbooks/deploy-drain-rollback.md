# 배포·드레이닝·롤백 런북

이 문서는 PRD §13.3, §13.5, §17.3의 신규 Room 전용 배포와 드레이닝 리허설 절차다.
진행 중인 Room을 강제 종료하지 않으며, 관리자 세션 또는 `x-admin-secret` 권한이 필요하다.

## 배포 전 확인

1. `bash scripts/verify.sh`와 `pnpm smoke`를 성공시킨다.
2. `bash scripts/soak.sh 6`으로 결정적 6시간 시뮬레이션을 확인한다.
3. 새 게임 서버 풀을 기존 풀과 별도로 Ready 상태까지 기동한다. 새 인스턴스는 고유한
   `SERPENT_CONFIG_ROLLOUT_KEY`를 사용한다.
4. 운영 콘솔(`?admin=1`)에서 API 5xx, Room P1/P2 경보, snapshot P95를 확인한다.

## 단계 배포

1. 관리자 콘솔에서 새 GameConfig를 1%로 활성화한다.
2. 10% → 50% → 100% 순으로 승격한다. P1 경보, ops endpoint 오류, 비단조 승격은 API가 거부한다.
3. 각 단계에서 API RPS/오류율, RTT P95, tick P99, snapshot P95, 결과 outbox backlog를 관찰한다.
4. 오류가 없으면 새 인스턴스만 신규 Room을 받도록 match target을 전환한다.

## 기존 풀 drain

전체 drain은 다음 요청으로 수행한다. 진행 중 경기와 reconnect grace는 유지되고 신규 매칭만 막힌다.

```bash
curl -X POST "$GAME_OPS_URL/ops/drain" \
  -H "x-admin-secret: $SERPENT_ADMIN_SECRET"
```

특정 Room만 drain하려면 URL 인코딩한 Room ID를 사용한다.

```bash
curl -X POST "$GAME_OPS_URL/ops/rooms/$ROOM_ID/drain" \
  -H "x-admin-secret: $SERPENT_ADMIN_SECRET"
```

`GET /ops/metrics`에서 해당 Room의 `draining: true`와 기존 플레이어 감소를 확인한다.
Room이 비고 reconnect grace가 끝난 뒤에만 인스턴스를 제거한다.

## 롤백

1. P1 또는 지속 P2가 발생하면 더 이상의 롤아웃을 멈춘다.
2. 관리자 콘솔에서 이전 config version을 rollback한다. API는 rollback version을 100%로 즉시 활성화한다.
3. 신규 Room을 이전 게임 서버 풀로 되돌리고, 문제 풀은 위 절차로 drain한다.
4. `pnpm smoke`로 신규 입장, snapshot, drain 후 진행 중 경기 유지, 결과 저장을 재확인한다.
5. 감사 로그에 config rollback/drain 요청이 남았는지 확인하고 원인·시각·영향 Room을 기록한다.

## 로컬 리허설

```bash
bash scripts/run-local.sh
# 별도 터미널
pnpm smoke
bash scripts/soak.sh 6
```

Compose 상태 서비스만 필요하면 `docker compose -f infra/docker-compose/docker-compose.yml up -d --wait`를
사용한다. 컨테이너 문법은 `bash scripts/check-infra.sh`로 확인한다.
