# @mdcms/sdk

Read-focused client SDK for MDCMS content APIs.

## Install

```bash
npm install @mdcms/sdk
```

## Usage

```ts
import { createClient } from "@mdcms/sdk";

const cms = createClient({
  serverUrl: "http://localhost:4000",
  apiKey: process.env.MDCMS_API_KEY!,
  project: "marketing-site",
  environment: "production",
});

// Fetch a single document by slug
const post = await cms.get("BlogPost", {
  slug: "hello-world",
  locale: "en",
  resolve: ["author"],
});

// List documents with filtering and pagination
const posts = await cms.list("BlogPost", {
  locale: "en",
  published: true,
  limit: 10,
  sort: "createdAt",
  order: "desc",
});
```

## API

### `createClient(options)`

Creates an SDK client instance.

| Option        | Required | Description                |
| ------------- | -------- | -------------------------- |
| `serverUrl`   | Yes      | MDCMS server URL           |
| `apiKey`      | Yes      | API key for authentication |
| `project`     | Yes      | Default project name       |
| `environment` | Yes      | Default environment name   |

### `client.get(type, options)`

Fetch a single document. Accepts either `{ id }` or `{ slug }` to identify the document, plus optional `locale`, `resolve`, `draft`, `project`, and `environment`.

- `{ id }` fetches that document. The `type` argument is not checked against it.
- `{ slug }` matches documents of `type` whose `frontmatter.slug` equals the value (not the document path). No match throws `MdcmsClientError` with code `NOT_FOUND`; several matches throw code `AMBIGUOUS_RESULT`.
- `locale` filters on the stored locale. Documents of non-localized types are stored under `__mdcms_default__`, so omit `locale` for them; pass it for localized types. `get` by `id` ignores it.

### `client.list(type, options)`

List documents with filtering, pagination, and sorting. Supports `locale`, `resolve`, `draft`, `published`, `limit`, `offset`, `sort`, and `order`.

Per-call `project` and `environment` override the client defaults for that request.

Schema file fields are expanded to `MediaAsset` objects by default. Pass `fileFields: "raw"` to SDK read calls when an authoring workflow needs persisted raw media asset ids.

### Types

The package root exports the document types used by the client, so an app does not need `@mdcms/shared` to type its data:

```ts
import type { ContentDocumentResponse } from "@mdcms/sdk";

function readTitle(document: ContentDocumentResponse): string | undefined {
  const title = document.frontmatter.title;
  return typeof title === "string" ? title : undefined;
}
```

A document has `documentId`, `type`, `path`, `locale`, `format`, `body` and the schema fields under `frontmatter` (typed `Record<string, unknown>`). Also exported: `ApiDataEnvelope`, `ApiPaginatedEnvelope`, `PaginationMetadata`, `ResolveErrorsMap`, `ContentResolveError`, `ContentReferenceResolveError`, `ContentMediaResolveError`, `MdcmsPreviewTokenClaims`, `MdcmsPreviewTokenExpectedClaims` and `MdcmsPreviewVerificationResult`.

### React rendering

`@mdcms/sdk/react` renders fetched document bodies to React nodes on the server.
It loads custom MDX components from `mdcms.config.ts`. A component's `load` may return the component or its module (default export, then the export named like the component). Each body is compiled as MDX when it contains a component or an `import`/`export` line, and as Markdown otherwise, whatever format the document was created with.

```tsx
import { createClient } from "@mdcms/sdk";
import { createMdcmsRenderer } from "@mdcms/sdk/react";
import config from "../mdcms.config";

const cms = createClient({
  serverUrl: process.env.MDCMS_SERVER_URL!,
  apiKey: process.env.MDCMS_API_KEY!,
  project: process.env.MDCMS_PROJECT!,
  environment: process.env.MDCMS_ENVIRONMENT!,
});
const renderer = createMdcmsRenderer(config);

export default async function Page() {
  const document = await cms.get("page", { slug: "about", locale: "en" });
  const body = await renderer.render(document);

  return <article>{body}</article>;
}
```

The React subpath is server-only. MDX `import` and `export` syntax is rejected;
register components in `mdcms.config.ts` instead. Renderer failures throw
`MdcmsRendererError`.

Built-in MDX components `Box`, `Text`, `Image`, and `Link` are available during
rendering without host registration. App-side React code can import the same
built-ins from the browser-safe primitives subpath:

```tsx
import { Box, Text, Image, Link } from "@mdcms/sdk/react-primitives";
```

### Error Handling

- `MdcmsApiError` — thrown for API error envelopes (4xx/5xx responses)
- `MdcmsClientError` — thrown for transport failures, malformed responses, and SDK-derived lookup failures
- `MdcmsRendererError` — thrown by `@mdcms/sdk/react` for server-only, component loading, unsupported MDX ESM, and render failures

## Documentation

Full SDK reference at [docs.mdcms.ai](https://docs.mdcms.ai/).
