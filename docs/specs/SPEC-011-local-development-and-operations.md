---
status: live
canonical: true
created: 2026-03-11
last_updated: 2026-06-11
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
    image: minio/minio
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
    image: minio/mc
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
on port 4000. It is appropriate for self-hosting and integration checks, but it
must not be followed by `bun run dev`, because `server:dev` also binds port 4000.

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

Collaboration uses three namespaced Redis keys per document:

- `mdcms:collaboration:yjs:{documentId}` stores the binary Yjs state.
- `mdcms:collaboration:yjs-meta:{documentId}` stores cache metadata for the PostgreSQL draft head used to build or last save the Yjs state.
- `mdcms:collaboration:active:{documentId}` stores the active-room heartbeat lease while collaborators are connected.

The active-room lock is distinct from the inactive Yjs cache. The active lock exists only while a document room has connected collaborators and blocks existing-document mutations. The Yjs state and metadata keys may remain after disconnect so a recently closed room can reopen quickly; after the last collaborator disconnects, both inactive cache keys receive a 30-minute TTL and the active-room lock is removed.

---
