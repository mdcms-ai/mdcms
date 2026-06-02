# Studio Example App

Example Next.js host app demonstrating how to embed `@mdcms/studio` at a catch-all route.

## Purpose

- Show the recommended host-app integration pattern for Studio
- Provide a working reference for `<Studio />` embedding, SDK-rendered content pages, and MDX component registration
- Serve as the local development host app for the monorepo

## Routes

| Route                           | Description                                                            |
| ------------------------------- | ---------------------------------------------------------------------- |
| `/`                             | CMS-backed landing page rendered from `content/pages/home`             |
| `/pages`                        | Unified rendered index for pages, posts, and configured document types |
| `/admin/*`                      | Embedded Studio UI (catch-all)                                         |
| `/demo/content`                 | Direct content API diagnostic view with rendered previews              |
| `/demo/content/:documentId`     | Direct content API detail with rendered body                           |
| `/demo/sdk-content`             | SDK-backed rendered content library (`@mdcms/sdk`)                     |
| `/demo/sdk-content/:documentId` | SDK-backed content detail with `@mdcms/sdk/react` output               |
| `/preview/post/:slug`           | Rendered draft preview for `post`                                      |
| `/preview/page/:path`           | Rendered draft preview for `page`                                      |

## Local Run

From workspace root:

```bash
bun run dev
```

This starts the Studio build watcher, backend server, and this Next.js app together.

For a fully containerized dev loop (infra + migrations + watchers):

```bash
bun run compose:dev
```

Default demo credentials (seeded automatically in `compose:dev`):

- Email: `demo@mdcms.local`
- Password: `Demo12345!`

## Environment Variables

| Variable                     | Default                                         | Description                                                |
| ---------------------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| `MDCMS_STUDIO_EXAMPLE_HOST`  | `127.0.0.1`                                     | Host address                                               |
| `MDCMS_STUDIO_EXAMPLE_PORT`  | `4173`                                          | Port                                                       |
| `DATABASE_URL`               | `postgresql://mdcms:mdcms@localhost:5432/mdcms` | For `server:dev`                                           |
| `MDCMS_DEMO_API_KEY`         | Seeded in compose                               | API key for demo content pages and server-side draft reads |
| `MDCMS_PREVIEW_TOKEN_SECRET` | Seeded in compose                               | Shared secret used to verify Studio preview tokens         |

The preview routes use `MDCMS_DEMO_API_KEY` for server-side SDK reads and
`MDCMS_PREVIEW_TOKEN_SECRET` to verify the short-lived
`mdcms_preview_token` that Studio appends before loading an iframe.
`mdcms.config.ts` wires the `post` and `page` content types to those routes with
`resolvePreviewUrl`; content types without that resolver show the Studio "Live
preview not available" guidance. Preview pages send the
`mdcms:live-preview-ready` postMessage after client render so Studio can fail
closed if an iframe never becomes ready. Preview routes force dynamic rendering
and the SDK fetches use `cache: "no-store"` so draft previews do not reuse
published page cache output.

For local CLI workflows in this demo, put developer-specific values in `apps/studio-example/.env.local` next to `mdcms.config.ts`. The `mdcms` CLI loads `.env*` files from that config directory before importing the config, with shell exports taking precedence over file values.

CLI env-file order, highest precedence first:

1. `.env.{NODE_ENV}.local`
2. `.env.local` (skipped when `NODE_ENV=test`)
3. `.env.{NODE_ENV}`
4. `.env`

`NODE_ENV` is only the dotenv file selector here. It controls names such as `.env.production`; it does not select the MDCMS content environment. Use `MDCMS_ENVIRONMENT` or the config `environment` field for that.

Use `--no-env-file` or `MDCMS_DOTENV=0` when CI should rely only on explicitly exported environment variables.

## Documentation

See [docs.mdcms.ai](https://docs.mdcms.ai/) for the full Studio embedding guide.
