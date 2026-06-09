# @mdcms/server

Backend API server for MDCMS, built with [Elysia](https://elysiajs.com/) and PostgreSQL via [Drizzle ORM](https://orm.drizzle.team/).

## Getting Started (Development)

> **End users / self-hosted operators:** See the [self-hosting guide](https://docs.mdcms.ai/guide/self-hosting) for production setup instructions.

The steps below are for contributors working inside the monorepo.

### Start infrastructure

```bash
docker compose up -d postgres redis minio mailhog
docker compose run --rm --no-deps minio-init
export DATABASE_URL=postgresql://mdcms:mdcms@localhost:5432/mdcms
export S3_ENDPOINT=http://localhost:9000
export S3_ACCESS_KEY=minioadmin
export S3_SECRET_KEY=minioadmin
export S3_BUCKET=mdcms-media
export S3_PUBLIC_BASE_URL=http://localhost:9000/mdcms-media
bun run --cwd apps/server db:migrate
```

This starts PostgreSQL, Redis, initialized MinIO media storage, and Mailhog for a local server process, then points local server commands at the Compose PostgreSQL and MinIO instances.

### Start the server

```bash
bun --cwd apps/server run start
```

The server starts on `http://localhost:4000`. Verify with `GET /healthz`.

Do not run `docker compose up -d --build` before starting the server locally; the default Compose stack starts its own server container on port 4000.

## API Endpoints

| Group         | Path                       | Description                                          |
| ------------- | -------------------------- | ---------------------------------------------------- |
| Health        | `GET /healthz`             | Process health check                                 |
| Content       | `/api/v1/content`          | CRUD, publish/unpublish, version history, restore    |
| Schema        | `/api/v1/schema`           | Schema registry sync and read                        |
| Environments  | `/api/v1/environments`     | List, create, delete environments                    |
| Auth          | `/api/v1/auth`             | Session login/logout, OIDC, SAML, API key management |
| Studio        | `/api/v1/studio/bootstrap` | Studio runtime publication and asset delivery        |
| Actions       | `/api/v1/actions`          | Action catalog (typed endpoint metadata)             |
| Collaboration | `/api/v1/collaboration`    | Collaboration handshake authorization                |

## Environment Variables

| Variable                       | Required | Default | Description                                               |
| ------------------------------ | -------- | ------- | --------------------------------------------------------- |
| `DATABASE_URL`                 | Yes      |         | PostgreSQL connection string                              |
| `PORT`                         | No       | `4000`  | Server listen port                                        |
| `MDCMS_STUDIO_ALLOWED_ORIGINS` | No       |         | Comma-separated origins for cross-origin Studio embedding |
| `MDCMS_AUTH_OIDC_PROVIDERS`    | No       |         | JSON array of OIDC provider configurations                |
| `MDCMS_AUTH_SAML_PROVIDERS`    | No       |         | JSON array of SAML provider configurations                |
| `MDCMS_AUTH_ADMIN_USER_IDS`    | No       |         | Comma-separated admin user IDs                            |
| `MDCMS_AUTH_ADMIN_EMAILS`      | No       |         | Comma-separated admin emails                              |
| `MDCMS_AUTH_INSECURE_COOKIES`  | No       | `false` | Set `true` for local dev without HTTPS                    |
| `S3_ENDPOINT`                  | Yes      |         | S3-compatible endpoint URL                                |
| `S3_ACCESS_KEY`                | Yes      |         | S3 access key                                             |
| `S3_SECRET_KEY`                | Yes      |         | S3 secret key                                             |
| `S3_BUCKET`                    | Yes      |         | S3 bucket name                                            |
| `S3_PUBLIC_BASE_URL`           | No       |         | Optional public base URL for generated asset links        |

## Database Migrations

```bash
# Generate migrations from schema changes
bun run --cwd apps/server db:generate

# Apply pending migrations
bun run --cwd apps/server db:migrate
```

In the default Docker Compose stack, migrations run automatically before the containerized server starts.

## Documentation

Full API reference at [docs.mdcms.ai](https://docs.mdcms.ai/).
