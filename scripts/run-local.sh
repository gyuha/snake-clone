#!/usr/bin/env bash
# api + game-server + web와 로컬 Postgres/Redis를 함께 기동한다 (PRD §13.1, 부록 G).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

COMPOSE=(docker compose -f infra/docker-compose/docker-compose.yml)
"${COMPOSE[@]}" up -d --wait postgres redis

cleanup() {
  kill "${API_PID:-}" "${GAME_PID:-}" "${WEB_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

API_PORT="${API_PORT:-8080}" \
SERPENT_GAME_ENDPOINT="${SERPENT_GAME_ENDPOINT:-ws://127.0.0.1:2567}" \
pnpm --filter @serpent/api dev & API_PID=$!

PORT="${PORT:-2567}" \
SERPENT_API_URL="${SERPENT_API_URL:-http://127.0.0.1:${API_PORT:-8080}}" \
SERPENT_CONFIG_URL="${SERPENT_CONFIG_URL:-http://127.0.0.1:${API_PORT:-8080}/v1/config/client}" \
pnpm --filter @serpent/game-server dev & GAME_PID=$!

pnpm --filter @serpent/web dev & WEB_PID=$!

echo "[local] web http://127.0.0.1:5173 · api http://127.0.0.1:${API_PORT:-8080} · game ws://127.0.0.1:${PORT:-2567}"
wait
