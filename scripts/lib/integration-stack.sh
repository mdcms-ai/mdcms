#!/usr/bin/env bash
# All resource operations share this invocation's immutable Compose arguments.
INTEGRATION_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
integration_clean_env=(env -i "PATH=$PATH" "HOME=$HOME" "NX_DAEMON=false")
for integration_key in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH TMPDIR; do
  if [[ -n "${!integration_key:-}" ]]; then integration_clean_env+=("$integration_key=${!integration_key}"); fi
done
integration_docker() { "${integration_clean_env[@]}" docker "$@"; }
integration_compose() { integration_docker compose "${integration_args[@]}" "$@"; }
integration_validate() { node "$INTEGRATION_ROOT/scripts/lib/validate-integration-stack.mjs" "$@"; }
integration_resources() {
  integration_docker ps -aq --filter "label=com.docker.compose.project=$INTEGRATION_PROJECT" || return 1
  integration_docker volume ls -q --filter "label=com.docker.compose.project=$INTEGRATION_PROJECT" || return 1
  integration_docker network ls -q --filter "label=com.docker.compose.project=$INTEGRATION_PROJECT"
}
integration_ownership() {
  local kind ids id
  for kind in container volume network; do
    case "$kind" in
      container) ids="$(integration_docker ps -aq --filter "label=com.docker.compose.project=$INTEGRATION_PROJECT")" || return 1 ;;
      volume) ids="$(integration_docker volume ls -q --filter "label=com.docker.compose.project=$INTEGRATION_PROJECT")" || return 1 ;;
      network) ids="$(integration_docker network ls -q --filter "label=com.docker.compose.project=$INTEGRATION_PROJECT")" || return 1 ;;
    esac
    for id in $ids; do
      integration_docker "$kind" inspect "$id" > "$INTEGRATION_DIR/resource.json" || return 1
      integration_validate ownership "$INTEGRATION_DIR/resource.json" "$INTEGRATION_PROJECT" "$kind" || return 1
    done
  done
}
integration_down() {
  integration_ownership || return 1
  integration_compose down "$@"
}
integration_cleanup() {
  local status="$1" cleanup_status=0 remaining
  trap - EXIT INT TERM
  if [[ "${INTEGRATION_OWNED:-0}" == 1 ]]; then
    integration_down --volumes > "$INTEGRATION_DIR/cleanup.log" 2>&1 || cleanup_status=$?
    if (( cleanup_status == 0 )); then
      remaining="$(integration_resources)" || cleanup_status=1
      [[ -z "$remaining" ]] || cleanup_status=1
    fi
    if (( cleanup_status != 0 )); then
      echo "Integration cleanup failed; inspect owned project $INTEGRATION_PROJECT" >&2
      if (( status == 0 )); then status=$cleanup_status; fi
    fi
  fi
  if ! rm -rf -- "$INTEGRATION_DIR"; then
    echo "Integration private configuration cleanup failed" >&2
    if (( status == 0 )); then status=1; fi
  fi
  exit "$status"
}
integration_init() {
  umask 077
  INTEGRATION_PROJECT="mdcms-integration-$(node -e 'console.log(require("node:crypto").randomBytes(12).toString("hex"))')"
  INTEGRATION_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mdcms-integration.XXXXXXXX")"
  INTEGRATION_OWNED=0
  trap 'integration_cleanup $?' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  integration_docker compose version --short > "$INTEGRATION_DIR/version"
  integration_validate version "$INTEGRATION_DIR/version"
  local resources ports key index=0
  resources="$(integration_resources)"
  [[ -z "$resources" ]] || { echo 'Integration project collision' >&2; return 1; }
  node "$INTEGRATION_ROOT/scripts/lib/allocate-integration-ports.mjs" > "$INTEGRATION_DIR/ports"
  ports=($(cat "$INTEGRATION_DIR/ports"))
  [[ "${#ports[@]}" == 7 ]] || return 1
  for key in SERVER POSTGRES REDIS MINIO MINIO_CONSOLE SMTP MAILHOG; do
    printf 'INTEGRATION_%s_PORT=%s\n' "$key" "${ports[$index]}" >> "$INTEGRATION_DIR/env"
    index=$((index + 1))
  done
  INTEGRATION_SERVER_URL="http://127.0.0.1:${ports[0]}"
  INTEGRATION_DATABASE_URL="postgres://integration:integration-password@127.0.0.1:${ports[1]}/mdcms_integration_test"
  integration_args=(-p "$INTEGRATION_PROJECT" -f "$INTEGRATION_ROOT/docker-compose.yml" -f "$INTEGRATION_ROOT/docker-compose.integration.yml" --env-file "$INTEGRATION_DIR/env")
  integration_compose config --format json > "$INTEGRATION_DIR/config.json"
  integration_validate config "$INTEGRATION_DIR/config.json" "$INTEGRATION_PROJECT" "$INTEGRATION_DIR/ports"
  INTEGRATION_OWNED=1
}
integration_wait() {
  local service="$1" id attempt result
  id="$(integration_compose ps --all -q "$service")"
  [[ "$id" =~ ^[a-f0-9]+$ ]] || { echo "Missing or duplicate container: $service" >&2; return 1; }
  for ((attempt=0; attempt<90; attempt++)); do
    integration_docker container inspect "$id" > "$INTEGRATION_DIR/container.json"
    if integration_validate container "$INTEGRATION_DIR/container.json" "$INTEGRATION_PROJECT" "$service" "$INTEGRATION_DIR/config.json"; then return 0; else result=$?; fi
    [[ "$result" == 2 ]] || return "$result"
    sleep 2
  done
  echo "Integration health timeout: $service" >&2
  return 1
}
integration_start() {
  integration_compose up -d --build --wait --wait-timeout 180
  local service
  for service in postgres redis minio mailhog minio-init db-migrate server; do integration_wait "$service"; done
  verify_server_health
}
verify_server_health() {
  integration_wait server
  local response
  response="$("${integration_clean_env[@]}" curl --user-agent research-client/1.0 --noproxy '*' --max-time 10 --fail --silent --show-error "$INTEGRATION_SERVER_URL/healthz")"
  [[ "$response" == *'"status":"ok"'* ]]
}
fail() { echo "ERROR: $*" >&2; exit 1; }
