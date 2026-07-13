#!/usr/bin/env bash
# PRD §17.3 릴리즈 게이트용 결정적 장기 soak.
# 실시간 대기가 아니라 20Hz 게임 시뮬레이션 시간을 빠르게 재생한다.
set -euo pipefail
cd "$(dirname "$0")/.."

hours="${1:-6}"
if ! [[ "$hours" =~ ^[0-9]+$ ]] || (( hours < 1 || hours > 24 )); then
  echo "usage: bash scripts/soak.sh [hours: 1..24]" >&2
  exit 2
fi

ticks=$((hours * 60 * 60 * 20))
echo "[soak] ${hours}h simulation = ${ticks} ticks"
SERPENT_SOAK_TICKS="$ticks" pnpm --filter @serpent/game-core test:soak
echo "[soak] PASS: ${hours}h deterministic simulation"
