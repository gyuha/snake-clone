#!/usr/bin/env bash
# Compose 문법/확장 변수를 검증한다. 이미지 pull이나 컨테이너 생성은 하지 않는다.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose -f infra/docker-compose/docker-compose.yml config --quiet
echo "[infra] compose configuration valid"
