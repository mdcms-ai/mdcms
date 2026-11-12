#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/integration-stack.sh"
integration_init
integration_start
cd "$INTEGRATION_ROOT"
for suite in test:integration:content test:integration:mcp; do
  "${integration_clean_env[@]}" MDCMS_REQUIRE_TEST_DATABASE=1 MDCMS_TEST_DATABASE_URL="$INTEGRATION_DATABASE_URL" MDCMS_TEST_SERVER_URL="$INTEGRATION_SERVER_URL" bun --no-env-file run --cwd apps/server "$suite" --no-env-file
done
