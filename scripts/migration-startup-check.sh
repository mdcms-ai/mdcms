#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/integration-stack.sh"
verify_drizzle_migration_table() {
  local table_name
  table_name="$(
    integration_compose exec -T postgres psql -U integration -d mdcms_integration_test -tA -v ON_ERROR_STOP=1 \
      -c "SELECT to_regclass('drizzle.__drizzle_migrations');" | tr -d '\r'
  )"
  [[ "$table_name" == "drizzle.__drizzle_migrations" ]] ||
    fail "expected drizzle.__drizzle_migrations table to exist, got '$table_name'"
}

query_postgres() {
  local sql="$1"
  integration_compose exec -T postgres psql -U integration -d mdcms_integration_test -tA -v ON_ERROR_STOP=1 \
    -c "$sql" | tr -d '\r'
}

exec_postgres() {
  local sql="$1"
  integration_compose exec -T postgres psql -U integration -d mdcms_integration_test -v ON_ERROR_STOP=1 \
    -c "$sql" >/dev/null
}

assert_query_result() {
  local sql="$1"
  local expected="$2"
  local error_message="$3"
  local result
  result="$(query_postgres "$sql")"
  [[ "$result" == "$expected" ]] || fail "$error_message (expected '$expected', got '$result')"
}

expect_psql_failure() {
  local sql="$1"
  local error_message="$2"
  local status

  set +e
  integration_compose exec -T postgres psql -U integration -d mdcms_integration_test -v ON_ERROR_STOP=1 \
    -c "$sql" >/dev/null 2>&1
  status=$?
  set -e

  [[ "$status" -ne 0 ]] || fail "$error_message"
}

new_uuid() {
  query_postgres "SELECT gen_random_uuid();"
}

verify_core_schema_shape() {
  local table_name
  for table_name in projects environments documents document_versions media migrations; do
    assert_query_result \
      "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '${table_name}';" \
      "1" \
      "expected core table '${table_name}' to exist"
  done

  local constraint_name
  for constraint_name in \
    unique_environment_id_project \
    unique_environment_per_project \
    fk_documents_env_project \
    fk_document_versions_env_project \
    fk_documents_published_version \
    unique_document_version; do
    assert_query_result \
      "SELECT COUNT(*) FROM pg_constraint WHERE conname = '${constraint_name}';" \
      "1" \
      "expected constraint '${constraint_name}' to exist"
  done

  local index_name
  for index_name in \
    idx_versions_document \
    idx_versions_scope \
    idx_documents_active_scope_type_locale_path \
    idx_documents_active_scope_updated_at \
    idx_documents_active_scope_unpublished_updated_at \
    idx_documents_scope_translation_group \
    uniq_documents_active_path \
    uniq_documents_active_translation_locale; do
    assert_query_result \
      "SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = '${index_name}';" \
      "1" \
      "expected index '${index_name}' to exist"
  done
}

verify_core_schema_integrity_behaviors() {
  local run_id actor_id project_id environment_id alt_project_id alt_environment_id
  local doc_path_a doc_path_b path_value
  local translation_group_shared translation_doc_1
  local path_doc_active path_doc_reused
  local version_document_id version_group_id version_row_id

  run_id="cms11-$(date +%s)-$RANDOM"
  actor_id="$(new_uuid)"
  project_id="$(new_uuid)"
  environment_id="$(new_uuid)"
  alt_project_id="$(new_uuid)"
  alt_environment_id="$(new_uuid)"

  exec_postgres "INSERT INTO projects (id, name, slug, created_by) VALUES ('${project_id}', 'CMS11 project ${run_id}', 'cms11-${run_id}', '${actor_id}');"
  exec_postgres "INSERT INTO projects (id, name, slug, created_by) VALUES ('${alt_project_id}', 'CMS11 alt project ${run_id}', 'cms11-alt-${run_id}', '${actor_id}');"
  exec_postgres "INSERT INTO environments (id, project_id, name, created_by) VALUES ('${environment_id}', '${project_id}', 'production', '${actor_id}');"
  exec_postgres "INSERT INTO environments (id, project_id, name, created_by) VALUES ('${alt_environment_id}', '${alt_project_id}', 'production', '${actor_id}');"

  expect_psql_failure \
    "INSERT INTO documents (document_id, translation_group_id, project_id, environment_id, path, schema_type, locale, content_format, body, frontmatter, created_by, updated_by) VALUES ('$(new_uuid)', '$(new_uuid)', '${project_id}', '${alt_environment_id}', 'scope-mismatch-${run_id}', 'BlogPost', 'en-US', 'md', '# title', '{}'::jsonb, '${actor_id}', '${actor_id}');" \
    "expected documents scope FK to reject mismatched (environment_id, project_id)"

  path_value="docs/path-${run_id}"
  path_doc_active="$(new_uuid)"
  exec_postgres "INSERT INTO documents (document_id, translation_group_id, project_id, environment_id, path, schema_type, locale, content_format, body, frontmatter, created_by, updated_by) VALUES ('${path_doc_active}', '$(new_uuid)', '${project_id}', '${environment_id}', '${path_value}', 'BlogPost', 'en-US', 'md', '# active', '{}'::jsonb, '${actor_id}', '${actor_id}');"

  expect_psql_failure \
    "INSERT INTO documents (document_id, translation_group_id, project_id, environment_id, path, schema_type, locale, content_format, body, frontmatter, created_by, updated_by) VALUES ('$(new_uuid)', '$(new_uuid)', '${project_id}', '${environment_id}', '${path_value}', 'BlogPost', 'en-US', 'md', '# duplicate-path', '{}'::jsonb, '${actor_id}', '${actor_id}');" \
    "expected active path uniqueness to reject duplicate (project, environment, locale, path)"

  exec_postgres "UPDATE documents SET is_deleted = true WHERE document_id = '${path_doc_active}';"
  path_doc_reused="$(new_uuid)"
  exec_postgres "INSERT INTO documents (document_id, translation_group_id, project_id, environment_id, path, schema_type, locale, content_format, body, frontmatter, created_by, updated_by) VALUES ('${path_doc_reused}', '$(new_uuid)', '${project_id}', '${environment_id}', '${path_value}', 'BlogPost', 'en-US', 'md', '# reused-path', '{}'::jsonb, '${actor_id}', '${actor_id}');"

  translation_group_shared="$(new_uuid)"
  doc_path_a="docs/translation-a-${run_id}"
  doc_path_b="docs/translation-b-${run_id}"
  translation_doc_1="$(new_uuid)"
  exec_postgres "INSERT INTO documents (document_id, translation_group_id, project_id, environment_id, path, schema_type, locale, content_format, body, frontmatter, created_by, updated_by) VALUES ('${translation_doc_1}', '${translation_group_shared}', '${project_id}', '${environment_id}', '${doc_path_a}', 'BlogPost', 'fr', 'md', '# translation-a', '{}'::jsonb, '${actor_id}', '${actor_id}');"

  expect_psql_failure \
    "INSERT INTO documents (document_id, translation_group_id, project_id, environment_id, path, schema_type, locale, content_format, body, frontmatter, created_by, updated_by) VALUES ('$(new_uuid)', '${translation_group_shared}', '${project_id}', '${environment_id}', '${doc_path_b}', 'BlogPost', 'fr', 'md', '# translation-b', '{}'::jsonb, '${actor_id}', '${actor_id}');" \
    "expected translation+locale uniqueness to reject duplicate active (project, environment, translation_group_id, locale)"

  version_document_id="$(new_uuid)"
  version_group_id="$(new_uuid)"
  exec_postgres "INSERT INTO documents (document_id, translation_group_id, project_id, environment_id, path, schema_type, locale, content_format, body, frontmatter, created_by, updated_by) VALUES ('${version_document_id}', '${version_group_id}', '${project_id}', '${environment_id}', 'docs/version-${run_id}', 'BlogPost', 'de', 'mdx', '# version-head', '{}'::jsonb, '${actor_id}', '${actor_id}');"

  exec_postgres "INSERT INTO document_versions (id, document_id, translation_group_id, project_id, environment_id, schema_type, locale, content_format, path, body, frontmatter, version, published_by) VALUES ('$(new_uuid)', '${version_document_id}', '${version_group_id}', '${project_id}', '${environment_id}', 'BlogPost', 'de', 'mdx', 'docs/version-${run_id}', '# version-1', '{}'::jsonb, 1, '${actor_id}');"

  expect_psql_failure \
    "INSERT INTO document_versions (id, document_id, translation_group_id, project_id, environment_id, schema_type, locale, content_format, path, body, frontmatter, version, published_by) VALUES ('$(new_uuid)', '${version_document_id}', '${version_group_id}', '${project_id}', '${environment_id}', 'BlogPost', 'de', 'mdx', 'docs/version-${run_id}', '# version-duplicate', '{}'::jsonb, 1, '${actor_id}');" \
    "expected unique_document_version to reject duplicate (document_id, version)"

  expect_psql_failure \
    "INSERT INTO document_versions (id, document_id, translation_group_id, project_id, environment_id, schema_type, locale, content_format, path, body, frontmatter, version, published_by) VALUES ('$(new_uuid)', '${version_document_id}', '${version_group_id}', '${project_id}', '${alt_environment_id}', 'BlogPost', 'de', 'mdx', 'docs/version-${run_id}', '# scope-mismatch-version', '{}'::jsonb, 2, '${actor_id}');" \
    "expected document_versions scope FK to reject mismatched (environment_id, project_id)"

  expect_psql_failure \
    "UPDATE documents SET published_version = 2 WHERE document_id = '${version_document_id}';" \
    "expected published version FK to reject pointer to missing version"

  exec_postgres "UPDATE documents SET published_version = 1 WHERE document_id = '${version_document_id}';"
  version_row_id="$(query_postgres "SELECT id FROM document_versions WHERE document_id = '${version_document_id}' AND version = 1;")"
  expect_psql_failure \
    "DELETE FROM document_versions WHERE id = '${version_row_id}';" \
    "expected fk_documents_published_version ON DELETE RESTRICT behavior"
}

run_startup_cycle() {
  local label="$1"

  echo "Starting compose stack (${label})"
  integration_start
  verify_drizzle_migration_table
  verify_core_schema_shape
  verify_core_schema_integrity_behaviors
}

integration_init

run_startup_cycle "initial"

echo "Restarting without dropping volumes to verify idempotent migration startup"
integration_down
run_startup_cycle "restart"

echo "Migration startup verification passed"
