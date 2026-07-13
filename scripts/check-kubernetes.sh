#!/usr/bin/env bash
# PRD §13.3/13.5: 클러스터 접근 없이 YAML을 파싱하고
# HPA·probe·PDB 같은 릴리스 필수 필드를 별도로 확인한다. OpenAPI schema 검증은
# 실제 staging cluster의 `kubectl apply --dry-run=server`에서 수행한다.
set -euo pipefail
cd "$(dirname "$0")/.."
ruby - <<'RUBY'
require 'yaml'
files = %w[infra/kubernetes/namespace.yaml infra/kubernetes/api.yaml infra/kubernetes/game-server.yaml]
files.each do |file|
  documents = YAML.load_stream(File.read(file))
  raise "#{file}: no documents" if documents.empty?
  documents.each_with_index do |document, index|
    unless document.is_a?(Hash) && document['apiVersion'].is_a?(String) && document['kind'].is_a?(String) && document['metadata'].is_a?(Hash)
      raise "#{file}: document #{index + 1} is not a Kubernetes resource"
    end
  end
end
RUBY
rg -q 'kind: HorizontalPodAutoscaler' infra/kubernetes/api.yaml
rg -q 'kind: PodDisruptionBudget' infra/kubernetes/api.yaml
rg -q 'readinessProbe:' infra/kubernetes/api.yaml
rg -q 'kind: HorizontalPodAutoscaler' infra/kubernetes/game-server.yaml
rg -q 'kind: PodDisruptionBudget' infra/kubernetes/game-server.yaml
rg -q 'path: /healthz' infra/kubernetes/game-server.yaml
rg -q 'serpent_game_active_rooms' infra/kubernetes/game-server.yaml
rg -q 'serpent_event_loop_lag_p99_milliseconds' infra/kubernetes/game-server.yaml
echo "[infra] kubernetes manifests valid"
