#!/usr/bin/env bash
# 스모크 테스트: game-server 기동 → 클라이언트 접속 검증
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/smoke.mjs
