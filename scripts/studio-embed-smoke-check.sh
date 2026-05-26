#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/apps/studio-example"
HOST="127.0.0.1"
PORT="4173"
BASE_URL="http://${HOST}:${PORT}"
STARTUP_TIMEOUT_SECONDS=180
NEXT_LOG_FILE="${TMPDIR:-/tmp}/mdcms-studio-embed-smoke.log"

NEXT_PID=""

print_logs() {
  if [[ -f "$NEXT_LOG_FILE" ]]; then
    echo "--- Next.js sample app logs ---" >&2
    tail -n 200 "$NEXT_LOG_FILE" >&2 || true
    echo "--- end logs ---" >&2
  fi
}

fail() {
  echo "ERROR: $*" >&2
  print_logs
  exit 1
}

cleanup() {
  if [[ -n "$NEXT_PID" ]] && kill -0 "$NEXT_PID" >/dev/null 2>&1; then
    kill "$NEXT_PID" >/dev/null 2>&1 || true
    wait "$NEXT_PID" >/dev/null 2>&1 || true
  fi

  rm -rf "$APP_DIR/.next" >/dev/null 2>&1 || true
}

wait_for_ready() {
  local elapsed=0
  local status

  while ((elapsed < STARTUP_TIMEOUT_SECONDS)); do
    if ! kill -0 "$NEXT_PID" >/dev/null 2>&1; then
      fail "next dev process exited before app became ready"
    fi

    status="$(
      curl --silent --output /dev/null --write-out "%{http_code}" "${BASE_URL}/" || true
    )"

    if [[ "$status" == "200" ]]; then
      return 0
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done

  fail "sample app did not become ready within ${STARTUP_TIMEOUT_SECONDS}s"
}

http_get_status() {
  local path="$1"
  curl --silent --output /dev/null --write-out "%{http_code}" "${BASE_URL}${path}"
}

http_get_body() {
  local path="$1"
  curl --silent --show-error --location "${BASE_URL}${path}"
}

assert_contains() {
  local body="$1"
  local expected="$2"
  local message="$3"

  if ! grep -Fq "$expected" <<<"$body"; then
    fail "$message"
  fi
}

assert_not_contains() {
  local body="$1"
  local expected="$2"
  local message="$3"

  if grep -Fq "$expected" <<<"$body"; then
    fail "$message"
  fi
}

trap cleanup EXIT

[[ -d "$APP_DIR" ]] || fail "sample app directory not found: $APP_DIR"

cd "$ROOT_DIR"
echo "Building @mdcms/studio and @mdcms/cli packages"
bun nx run-many -t build --projects cli,studio

echo "Starting Next.js embed sample app on ${BASE_URL}"
: >"$NEXT_LOG_FILE"
(
  cd "$APP_DIR"
  NEXT_TELEMETRY_DISABLED=1 bun x next dev --hostname "$HOST" --port "$PORT"
) >"$NEXT_LOG_FILE" 2>&1 &
NEXT_PID=$!

wait_for_ready

echo "Verifying /admin route boot"
admin_status="$(http_get_status "/admin")"
[[ "$admin_status" == "200" ]] || fail "expected /admin status 200, got $admin_status"
admin_body="$(http_get_body "/admin")"
assert_contains \
  "$admin_body" \
  "data-testid=\"mdcms-studio-root\"" \
  "/admin response did not contain Studio root marker"

echo "Verifying /admin/* catch-all route boot"
admin_nested_status="$(http_get_status "/admin/content/posts")"
[[ "$admin_nested_status" == "200" ]] ||
  fail "expected /admin/content/posts status 200, got $admin_nested_status"
admin_nested_body="$(http_get_body "/admin/content/posts")"
assert_contains \
  "$admin_nested_body" \
  "data-testid=\"mdcms-studio-root\"" \
  "/admin/content/posts response did not contain Studio root marker"

echo "Verifying non-admin route isolation"
root_status="$(http_get_status "/")"
[[ "$root_status" == "200" ]] || fail "expected / status 200, got $root_status"
root_body="$(http_get_body "/")"
assert_not_contains \
  "$root_body" \
  "data-testid=\"mdcms-studio-root\"" \
  "home route unexpectedly contained Studio root marker"

echo "Verifying demo content route boot"
demo_status="$(http_get_status "/demo/content")"
[[ "$demo_status" == "200" ]] ||
  fail "expected /demo/content status 200, got $demo_status"
demo_body="$(http_get_body "/demo/content")"
assert_contains \
  "$demo_body" \
  "Rendered documents from the content API." \
  "/demo/content response did not contain demo heading"
assert_not_contains \
  "$demo_body" \
  "data-testid=\"mdcms-studio-root\"" \
  "demo route unexpectedly contained Studio root marker"

echo "Studio embed smoke check passed"
