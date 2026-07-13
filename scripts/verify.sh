#!/usr/bin/env bash
# 전체 검증 파이프라인 (PRD 부록 G)
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm lint
pnpm typecheck
pnpm -r test
pnpm build
pnpm check:web-budget
pnpm check:assets
pnpm check:dependencies
pnpm infra:check:kubernetes
pnpm test:e2e
echo "[verify] all checks passed"
