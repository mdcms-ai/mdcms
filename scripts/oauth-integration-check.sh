#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# A unique Compose project owns only this ephemeral database, never the dev stack.
OAUTH_COMPOSE_PROJECT="mdcms-oauth-test-$$-$RANDOM"
compose=(docker compose -f docker-compose.oauth-test.yml -p "$OAUTH_COMPOSE_PROJECT")
cleanup() { "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1; }

if [[ -z "${MDCMS_TEST_DATABASE_URL:-}" ]]; then
  trap cleanup EXIT
  "${compose[@]}" up -d --wait --wait-timeout 90
  OAUTH_DATABASE_PORT="$("${compose[@]}" port postgres 5432)"
  export MDCMS_TEST_DATABASE_URL="postgres://mdcms:mdcms@${OAUTH_DATABASE_PORT}/mdcms_oauth_test"
fi

export MDCMS_OAUTH_INTEGRATION=1
# Validate the opt-in target before migration. Unavailable databases fail closed.
bun --conditions @mdcms/source -e 'const url = process.env.MDCMS_TEST_DATABASE_URL; if (!url || !/^postgres(?:ql)?:$/.test(new URL(url).protocol) || !/(?:^|[_-])(test|verify)(?:[_-]|$)/i.test(new URL(url).pathname.slice(1))) throw new Error("Explicit test or verify database required");'
export DATABASE_URL="$MDCMS_TEST_DATABASE_URL"
bun run --cwd apps/server db:migrate
bun run --cwd apps/server test:integration:oauth
