#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/integration-stack.sh"
integration_init
integration_start
echo "Writing persistence sentinels"
SENTINEL_VALUE="cms3-$(date +%s)-$RANDOM"

integration_compose exec -T postgres psql -U integration -d mdcms_integration_test -v ON_ERROR_STOP=1 \
  -c "CREATE TABLE IF NOT EXISTS cms3_persistence_sentinel (k text PRIMARY KEY, v text NOT NULL);" >/dev/null
integration_compose exec -T postgres psql -U integration -d mdcms_integration_test -v ON_ERROR_STOP=1 \
  -c "INSERT INTO cms3_persistence_sentinel (k, v) VALUES ('compose', '$SENTINEL_VALUE') ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;" >/dev/null
integration_compose exec -T minio sh -lc "printf '%s' '$SENTINEL_VALUE' > /data/cms3_persistence_sentinel.txt"

echo "Restarting stack without deleting volumes"
integration_down
integration_start

echo "Validating persistence sentinels after restart"
postgres_value="$(
  integration_compose exec -T postgres psql -U integration -d mdcms_integration_test -tA \
    -c "SELECT v FROM cms3_persistence_sentinel WHERE k = 'compose';" | tr -d '\r'
)"
[[ "$postgres_value" == "$SENTINEL_VALUE" ]] ||
  fail "postgres sentinel mismatch: expected '$SENTINEL_VALUE', got '$postgres_value'"

minio_value="$(integration_compose exec -T minio sh -lc "cat /data/cms3_persistence_sentinel.txt" | tr -d '\r')"
[[ "$minio_value" == "$SENTINEL_VALUE" ]] ||
  fail "minio sentinel mismatch: expected '$SENTINEL_VALUE', got '$minio_value'"

echo "Compose stack health and persistence checks passed"
