#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

readonly INFRA_SERVICES=(postgres redis minio mailhog)
readonly SERVICES=("${INFRA_SERVICES[@]}" server)

cleanup() {
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

wait_for_service() {
  local service="$1"
  local timeout_seconds="${2:-180}"
  local elapsed=0
  local container_id
  local status

  container_id="$(docker compose ps -q "$service")"
  [[ -n "$container_id" ]] || fail "service '$service' has no running container id"

  while ((elapsed < timeout_seconds)); do
    status="$(
      docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id"
    )"

    if [[ "$status" == "healthy" || "$status" == "running" ]]; then
      return 0
    fi

    if [[ "$status" == "unhealthy" || "$status" == "exited" || "$status" == "dead" ]]; then
      docker compose logs "$service" || true
      fail "service '$service' reached terminal status '$status'"
    fi

    sleep 2
    elapsed=$((elapsed + 2))
  done

  docker compose ps || true
  docker compose logs "$service" || true
  fail "service '$service' did not become healthy within ${timeout_seconds}s"
}

check_port_mapping() {
  local service="$1"
  local container_port="$2"
  local expected_host_port="$3"
  local mapping
  local actual_host_port

  mapping="$(docker compose port "$service" "$container_port" | head -n 1 || true)"
  [[ -n "$mapping" ]] || fail "no host mapping for $service:$container_port"

  actual_host_port="$(awk -F: '{print $NF}' <<<"$mapping")"
  [[ "$actual_host_port" == "$expected_host_port" ]] ||
    fail "unexpected host mapping for $service:$container_port -> $mapping (expected :$expected_host_port)"
}

verify_health_endpoint() {
  local response
  response="$(curl --fail --silent --show-error http://127.0.0.1:4000/healthz)"
  [[ "$response" == *'"status":"ok"'* ]] ||
    fail "server /healthz response missing status=ok: $response"
}

assert_services_healthy() {
  local service
  for service in "${SERVICES[@]}"; do
    wait_for_service "$service"
  done
}

assert_infra_services_healthy() {
  local service
  for service in "${INFRA_SERVICES[@]}"; do
    wait_for_service "$service"
  done
}

start_stack() {
  docker compose up -d --build "${INFRA_SERVICES[@]}"
  assert_infra_services_healthy
  docker compose run --rm --no-deps minio-init
  docker compose run --rm --no-deps --build db-migrate
  docker compose up -d --build --no-deps server
  wait_for_service server
}

trap cleanup EXIT

echo "Resetting any existing compose stack"
cleanup

echo "Bringing stack up"
start_stack

echo "Checking health endpoint and port mappings"
verify_health_endpoint
check_port_mapping server 4000 4000
check_port_mapping postgres 5432 5432
check_port_mapping redis 6379 6379
check_port_mapping minio 9000 9000
check_port_mapping minio 9001 9001
check_port_mapping mailhog 1025 1025
check_port_mapping mailhog 8025 8025

echo "Writing persistence sentinels"
SENTINEL_VALUE="cms3-$(date +%s)-$RANDOM"

docker compose exec -T postgres psql -U mdcms -d mdcms -v ON_ERROR_STOP=1 \
  -c "CREATE TABLE IF NOT EXISTS cms3_persistence_sentinel (k text PRIMARY KEY, v text NOT NULL);" >/dev/null
docker compose exec -T postgres psql -U mdcms -d mdcms -v ON_ERROR_STOP=1 \
  -c "INSERT INTO cms3_persistence_sentinel (k, v) VALUES ('compose', '$SENTINEL_VALUE') ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;" >/dev/null
docker compose exec -T minio sh -lc "printf '%s' '$SENTINEL_VALUE' > /data/cms3_persistence_sentinel.txt"

echo "Restarting stack without deleting volumes"
docker compose down
start_stack

echo "Validating persistence sentinels after restart"
postgres_value="$(
  docker compose exec -T postgres psql -U mdcms -d mdcms -tA \
    -c "SELECT v FROM cms3_persistence_sentinel WHERE k = 'compose';" | tr -d '\r'
)"
[[ "$postgres_value" == "$SENTINEL_VALUE" ]] ||
  fail "postgres sentinel mismatch: expected '$SENTINEL_VALUE', got '$postgres_value'"

minio_value="$(docker compose exec -T minio sh -lc "cat /data/cms3_persistence_sentinel.txt" | tr -d '\r')"
[[ "$minio_value" == "$SENTINEL_VALUE" ]] ||
  fail "minio sentinel mismatch: expected '$SENTINEL_VALUE', got '$minio_value'"

echo "Compose stack health and persistence checks passed"
