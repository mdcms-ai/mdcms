---
status: live
canonical: true
created: 2026-03-11
last_updated: 2026-11-12
---

# SPEC-011 Local Development and Operations

This is the live canonical document under `docs/`.

## Docker Compose & Local Development

### Stack

```yaml
# docker-compose.yml
services:
  server:
    build: ./apps/server
    restart: unless-stopped
    ports:
      - "4000:4000"
    environment:
      DATABASE_URL: ${DATABASE_URL:-postgresql://mdcms:mdcms@postgres:5432/mdcms}
      REDIS_URL: redis://redis:6379
      S3_ENDPOINT: http://minio:9000
      S3_ACCESS_KEY: ${S3_ACCESS_KEY}
      S3_SECRET_KEY: ${S3_SECRET_KEY}
      S3_BUCKET: mdcms-media
      S3_PUBLIC_BASE_URL: http://localhost:9000/mdcms-media
      SMTP_HOST: mailhog
      SMTP_PORT: 1025
    env_file:
      - .env
    healthcheck:
      test:
        ["CMD", "sh", "-c", "curl -f http://127.0.0.1:4000/healthz || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 10
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      minio:
        condition: service_healthy
      minio-init:
        condition: service_completed_successfully

  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: mdcms
      POSTGRES_PASSWORD: mdcms
      POSTGRES_DB: mdcms
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mdcms"]
      interval: 10s
      timeout: 5s
      retries: 8
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    ports:
      - "6379:6379"
    command: ["redis-server", "--save", "60", "1", "--appendonly", "yes"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

  minio:
    image: pgsty/minio
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    volumes:
      - miniodata:/data
    ports:
      - "9000:9000"
      - "9001:9001" # MinIO console
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 10s
      timeout: 5s
      retries: 5

  minio-init:
    image: pgsty/mc
    restart: "no"
    environment:
      S3_ENDPOINT: http://minio:9000
      S3_ACCESS_KEY: minioadmin
      S3_SECRET_KEY: minioadmin
      S3_BUCKET: mdcms-media
    entrypoint:
      - /bin/sh
      - -ec
      - |
        mc alias set local "$${S3_ENDPOINT}" "$${S3_ACCESS_KEY}" "$${S3_SECRET_KEY}"
        mc mb --ignore-existing "local/$${S3_BUCKET}"
        mc anonymous set download "local/$${S3_BUCKET}"
    depends_on:
      minio:
        condition: service_healthy

  mailhog:
    image: mailhog/mailhog
    restart: unless-stopped
    ports:
      - "1025:1025" # SMTP
      - "8025:8025" # Web UI

volumes:
  pgdata:
  miniodata:
```

### Getting Started (Developer Experience)

MDCMS supports two local contributor loops. They must not be combined:

- Host-process development starts only infrastructure services with Docker
  Compose, then runs the server, Studio watcher, and Studio example app from
  the local checkout with Bun.
- Containerized development uses `docker-compose.dev.yml` to run
  infrastructure, migrations, demo seeding, the server, the Studio watcher, and
  the Studio example app inside Compose.

The default `docker-compose.yml` starts the production-shaped server container
on port 4000. It is appropriate for self-hosting; automated integration checks
use the isolated override defined below. It must not be followed by `bun run dev`, because `server:dev` also binds port 4000.

#### Host-process development

```bash
git clone <repo>
cd mdcms
bun install
docker compose up -d postgres redis minio mailhog
docker compose run --rm --no-deps minio-init
export DATABASE_URL=postgresql://mdcms:mdcms@localhost:5432/mdcms
export S3_ENDPOINT=http://localhost:9000
export S3_ACCESS_KEY=minioadmin
export S3_SECRET_KEY=minioadmin
export S3_BUCKET=mdcms-media
export S3_PUBLIC_BASE_URL=http://localhost:9000/mdcms-media
bun run --cwd apps/server db:migrate
MDCMS_DEMO_ENVIRONMENT=staging bun run --cwd apps/server demo:seed
MDCMS_DEMO_ENVIRONMENT=production bun run --cwd apps/server demo:seed
bun run dev
```

The Studio example app is available at `http://127.0.0.1:4173/admin`.

#### Containerized development

```bash
git clone <repo>
cd mdcms
bun run compose:dev
```

The Studio example app is available at `http://127.0.0.1:4173/admin`.

Repository-local Git hooks are installed during `bun install` when the repo is
available as a Git worktree. The tracked `pre-push` hook must run the required
local CI gate (`bun run ci:required`) from the workspace root and block pushes
until formatting, typechecking, unit coverage, and integration coverage all
pass.

For the local demo compose profile (`docker-compose.dev.yml`), startup includes an idempotent demo seed step that ensures a fixed API key for raw demo-page reads:

- `MDCMS_DEMO_API_KEY` (default `mdcms_key_demo_local_compose_seed_2026_read`)
- scoped to `MDCMS_DEMO_PROJECT` / `MDCMS_DEMO_ENVIRONMENT` (defaults: `marketing-site` / `staging`)
- demo browser-login user defaults:
  - `MDCMS_DEMO_SEED_USER_EMAIL=demo@mdcms.local`
  - `MDCMS_DEMO_SEED_USER_PASSWORD=Demo12345!`

`docker-compose.dev.yml` is the long-running containerized development loop. In
addition to infrastructure services and demo seeding, it keeps the server,
embedded Studio host app, and Studio runtime artifact in watch mode. Changes
under `packages/studio/src/**` must rebuild the backend-served Studio runtime
bundle automatically and make the new bundle available without restarting the
compose stack or the long-running `dev` service.

This seed key is intended for local demo UX only and does not replace normal CLI login/logout flows.

### Collaboration Redis Operations

The collaboration runtime requires `REDIS_URL`. If Redis is not configured or cannot initialize, the server can still boot for non-collaboration HTTP traffic, but collaboration upgrade requests fail with `COLLABORATION_UNAVAILABLE`.

Collaboration uses namespaced Redis keys for document state and target-scoped
presence:

- `mdcms:collaboration:yjs:{documentId}` stores the binary Yjs state.
- `mdcms:collaboration:yjs-meta:{documentId}` stores cache metadata for the PostgreSQL draft head used to build or last save the Yjs state.
- `mdcms:collaboration:active:{documentId}` stores the active-room heartbeat lease while collaborators are connected.
- `mdcms:collaboration:presence:{project}:{environment}:{sessionId}` stores one
  Studio session's ephemeral presence heartbeat.

The active-room lock is distinct from the inactive Yjs cache. The active lock exists only while a document room has connected collaborators and blocks existing-document mutations. The Yjs state and metadata keys may remain after disconnect so a recently closed room can reopen quickly; after the last collaborator disconnects, both inactive cache keys receive a 30-minute TTL and the active-room lock is removed.

Redis is not the durable collaboration source of truth. If Redis is flushed,
restarted, or restored from an older snapshot, the durable recovery point is the
last successfully saved PostgreSQL draft head. Operators should expect connected
collaboration rooms and presence streams to reconnect or fail closed while Redis
is unavailable; no published versions are created by recovery.

Redis-loss recovery drill:

1. Open a document in Studio collaboration mode and make a body or frontmatter
   change.
2. Wait for the active collaboration autosave indicator to return to `Saved`.
3. Flush or restart Redis in the local environment.
4. Reopen the same document room.
5. Verify the editor loads the last PostgreSQL draft head, not a stale Redis Yjs
   cache, and that `document_versions` did not receive a new row.
6. Verify content list/editor presence repopulates after reconnect and stale
   presence indicators disappear within 30 seconds.

---

## OAuth Origin and Local Configuration

SPEC-005 owns `MDCMS_SERVER_URL` validation and the bounded OAuth rate-limit
settings. Set the public canonical origin explicitly for deployed servers; in
production it must be HTTPS or startup fails. A reverse proxy does not change the
configured public origin. Local development may use http://localhost:4000.
Docker Compose forwards MDCMS*SERVER_URL and the four `MDCMS_OAUTH*\*\_RATE_LIMIT`
settings into the server service; setting them in a host .env file alone is not
sufficient without that environment mapping. Missing production origin is a boot
error, not a fallback to localhost. The example environment documents defaults,
accepted ranges and the difference between local HTTP and production HTTPS.

OAuth registration has a persistent capacity of 10,000 clients with no automatic
client eviction. At capacity, registration returns a retryable 503. There is no
client-management endpoint. Monitor capacity before admitting more clients.
Expired codes and access tokens are cleaned in indexed bounded batches during
OAuth requests. Refresh replay hashes remain through the family's absolute
expiry; expired consent handles remain as tombstones for 24 hours. Connection
records remain available for idempotent revocation.

### OAuth Integration Verification

`bun run integration:oauth` creates a uniquely named, ephemeral PostgreSQL Compose
project with a random loopback port and in-memory storage, applies migrations,
and runs the database-backed OAuth and MCP suites. It removes only that project
on exit. The ordinary integration CI phase includes this command.

To use an already provisioned isolated database, set `MDCMS_TEST_DATABASE_URL` to
a PostgreSQL URL whose database name contains a `test` or `verify` marker. The
command applies migrations to that explicit database and leaves it running.
Never point the command at a development or production database. Tests clean
only their fixtures. OAuth database cases skip during ordinary unit discovery
without this variable. Explicit integration mode requires the variable and fails
on missing configuration, unavailable storage, or assertion failures.

### Studio Embed Smoke Port

`scripts/studio-embed-smoke-check.sh` uses loopback port 4173 by default.
Set `MDCMS_STUDIO_EMBED_SMOKE_PORT` to a decimal integer from 1 through 65535
to run the sample-app smoke check on another port. Invalid or empty explicit
values fail before building, starting the app, or installing cleanup handlers.
Choose a free port to avoid interfering with an existing local presentation.

For optional OAuth browser verification, set `MDCMS_OAUTH_BROWSER_EXECUTABLE`
to an installed Chromium executable and run the OAuth route suite with the
explicit isolated test database and a 30-second test timeout. It verifies
approval and denial callbacks, cross-origin referrer suppression, and credential
submission with JavaScript disabled. Ordinary unit discovery does not launch a
browser.

## Isolated Whole-Stack Integration Verification

The compose health, migration startup and content API integration commands must
not use or reset the default developer Compose project. Each invocation owns a
fresh complete stack: PostgreSQL, Redis, MinIO, MailHog, migration and bucket-init
jobs, and the server. Concurrent invocations have distinct projects and resources.
This is a test/operator workflow; it changes no product endpoint or ordinary
`docker-compose.yml` development default.

### Configuration and resource ownership

Use a dedicated `docker-compose.integration.yml` override and shared shell helper.
Every Compose command uses the explicit base and integration files, a generated
project name, and a private generated environment file. Do not infer project name
from the current directory or inherit COMPOSE_PROJECT_NAME, COMPOSE_FILE, profiles,
service URLs or credentials from the shell or repository .env. The project name
contains only a fixed test prefix and a random invocation identifier, never a
username or checkout path. Fail if any resources already exist for that name;
never reset them. No startup cleanup of a default or pre-existing project is allowed.

The override fully replaces every service port list with `!override` so default
host bindings cannot remain alongside test bindings. This requires Docker Compose
2.24.4 or later, including compatible later major versions. Validate the version
and merged configuration before creating resources; older or unsupported parsers
fail with a setup instruction. See the
[Compose merge contract](https://docs.docker.com/reference/compose-file/merge/#replace-value).

Allocate distinct host ports dynamically on 127.0.0.1 for server 4000, PostgreSQL
5432, Redis 6379, MinIO 9000/9001 and MailHog 1025/8025. The container ports stay
fixed. Select host ports through OS ephemeral-port allocation, record all mappings
once in the invocation configuration, and use those same mappings for subsequent
container recreation and restart checks. Port selection is not proof of ownership:
a bind race or occupied port at startup fails the invocation. Never silently change
ports mid-run or fall back to an existing listener. Do not stop unrelated processes
to acquire a port. Host publication must never bind 0.0.0.0 or ::.

Use controlled synthetic test credentials, database and bucket names. The database
name includes a test marker. Container DATABASE_URL points to this stack's
postgres:5432; REDIS_URL uses redis:6379; S3_ENDPOINT uses minio:9000 and matching
MinIO credentials; SMTP_HOST/SMTP_PORT use mailhog:1025. The migration job,
PostgreSQL healthcheck and SQL verification commands use those same test database
credentials. Bucket initialization uses the same synthetic bucket and MinIO keys
as the server. No production/developer endpoints, AI keys, email credentials or
identity-derived data may be inherited. Disable external AI providers for this
workflow. Sanitize the subprocess environment and override whole service
environment maps where needed; an --env-file alone does not defeat exported
shell-variable precedence.

Use NODE_ENV=test and fixed internal server PORT=4000. Set MDCMS_SERVER_URL to
http://127.0.0.1:<allocated-server-port> and S3_PUBLIC_BASE_URL to
http://127.0.0.1:<allocated-minio-port>/<test-bucket>. Set browser/Socket Origin
allowlists to the synthetic origins needed by tests. Local HTTP here exercises
explicit test configuration and does not weaken production HTTPS validation.
Render and inspect the merged configuration before startup: only expected
services, loopback publications, generated URLs, private project volumes and
network are permitted. No external volumes, external networks, fixed container
names or bind mounts of unrelated data are permitted.

### Startup, health and restart proof

A successful health request alone does not identify the tested stack. Obtain each
container ID from the explicit project, verify its Compose project/service labels,
then inspect its actual loopback mappings and compare with the saved invocation
configuration. Verify the server's configured canonical origin and media endpoint
match those mappings before sending host requests. A missing, duplicate or
mismatched container/mapping is a failure, even if another server answers healthz.
Every curl and test client uses the recorded test endpoint, never a fixed host port.

All required healthchecks must report healthy. A merely running container is not
sufficient when a healthcheck exists. Init/migration jobs must terminate with exit
code zero. Bind, configuration, build, initialization, migration, health timeout,
unhealthy or prematurely exited service errors fail immediately or at the bounded
startup timeout. Logs and diagnostics come only from invocation-owned containers
and redact credentials. No failure path may continue against an old server.

Persistence and migration-idempotency checks may recreate their own containers
without removing their volumes. Keep the same project, synthetic configuration,
port mappings and volume identities for the entire invocation, and re-verify
ownership/mappings after recreation. Sentinels live only in those test volumes.
Recreation bind failures fail the run; do not allocate a replacement mapping.

### Explicit database execution and cleanup

Content tests receive MDCMS_TEST_DATABASE_URL explicitly, using the verified
PostgreSQL host mapping and synthetic test database. Validate its scheme, loopback
host, test database name and equality to the invocation-owned target before any
migration or test cleanup. Explicit integration mode fails on missing URL,
connection failure or skipped database cases. Ordinary unit discovery without
explicit integration opt-in must not connect to a default local database.
An ambient DATABASE_URL or MDCMS_TEST_DATABASE_URL never selects a database for
these whole-stack commands; they generate their own target. The separately
specified OAuth-only command's explicit-database workflow remains separate.

Install cleanup traps after recording the fresh project and private configuration,
before starting resources. Handle success, failure and interrupt. Cleanup removes
only containers, network and named volumes created by that invocation, using the
same explicit Compose arguments and verified project ownership. Never use bare
`docker compose down`, global prune, default-project cleanup or deletion of shared
images/build caches. Uncertain ownership must fail closed and report leftover
resources, not broaden deletion. Preserve the original test failure status; a
cleanup failure after successful tests makes the overall command fail. Keep only
sanitized evidence; remove the invocation's private generated configuration.

The full `bun run ci:required` gate must execute these isolated integration phases,
not replace them with source checks or a previously completed suite. Report
actual completion or the failed/unavailable stage. Source review must first prove
that every destructive command and every test endpoint is invocation-scoped.
Other full-gate smoke processes also need owned loopback ports, including the
configured Studio embed smoke port; they must not attach to an existing app.
