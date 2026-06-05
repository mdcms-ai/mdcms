# @mdcms/studio

Embeddable Studio UI component for MDCMS. Drop it into any React app at a catch-all route to get a full content management interface.

## Install

```bash
npm install @mdcms/studio
```

## Embedding in a Next.js App

Create a catch-all route for Studio:

```tsx
// app/admin/[[...path]]/page.tsx
import { createStudioEmbedConfig } from "@mdcms/studio/runtime";
import config from "../../../mdcms.config";
import { AdminStudioClient } from "./admin-studio-client";

export default async function AdminPage() {
  return <AdminStudioClient config={createStudioEmbedConfig(config)} />;
}
```

```tsx
// app/admin/[[...path]]/admin-studio-client.tsx
"use client";

import { Studio, type MdcmsConfig } from "@mdcms/studio";

export function AdminStudioClient({ config }: { config: MdcmsConfig }) {
  return <Studio config={config} basePath="/admin" />;
}
```

`basePath` tells Studio where it's mounted so deep links resolve correctly.

## How It Works

Studio runs as a remote runtime loaded from your MDCMS server:

1. The `<Studio />` shell fetches the runtime manifest from `GET /api/v1/studio/bootstrap`
2. It validates compatibility and integrity, then loads the remote Studio module
3. After mounting, the remote runtime owns all UI routing and rendering

The shell handles startup errors (network failures, incompatible versions, disabled runtime). After a successful mount, the remote runtime takes over.

## Studio Routes

Once mounted, Studio provides these routes under your `basePath`:

| Route                              | Description                                                   |
| ---------------------------------- | ------------------------------------------------------------- |
| `/admin`                           | Dashboard                                                     |
| `/admin/content`                   | Content list with type filtering                              |
| `/admin/content/:type/:documentId` | Document editor with draft save, publish, and version history |
| `/admin/environments`              | Environment management                                        |
| `/admin/schema`                    | Read-only schema browser                                      |
| `/admin/users`                     | User management (admin/owner only)                            |
| `/admin/settings`                  | Settings (admin/owner only)                                   |
| `/admin/trash`                     | Deleted content                                               |

`/admin/settings` includes the Webhooks tab for admins and owners. It manages
webhook configurations for the mounted project/environment with create, edit,
and delete actions, including URL, event multi-select, generated signing secret,
optional signing secret rotation, and active toggle controls. The same tab shows
delivery history with filters for webhook id, event, and outcome. Webhook
creation uses the addressable `/admin/settings/webhooks/new` route so refresh
and back navigation preserve the operator's location. Webhook secrets are
write-only; Studio never shows a saved secret, and leaving the edit secret field
empty preserves the existing secret.

## MDX Components

Register local MDX components in your `mdcms.config.ts` to make them available in the Studio editor:

```ts
defineConfig({
  // ...
  components: [
    {
      name: "Callout",
      importPath: "./components/Callout",
      description: "A styled callout box",
      load: () => import("./components/Callout"),
    },
  ],
});
```

Registered components can be inserted from the toolbar or via `/` slash commands in the editor. Studio auto-generates a props editing panel from extracted component props, or you can provide a custom props editor.

## Exports

| Import Path                            | Description                                                       |
| -------------------------------------- | ----------------------------------------------------------------- |
| `@mdcms/studio`                        | `Studio` component, `PropsEditorComponent` type                   |
| `@mdcms/studio/runtime`                | `prepareStudioConfig`, `createStudioEmbedConfig`, runtime helpers |
| `@mdcms/studio/markdown-pipeline`      | `parseMarkdownToDocument`, `serializeDocumentToMarkdown`          |
| `@mdcms/studio/document-shell`         | `loadStudioDocumentShell` for host-app shell rendering            |
| `@mdcms/studio/action-catalog-adapter` | Typed action catalog client                                       |

## Documentation

Full Studio reference at [docs.mdcms.ai](https://docs.mdcms.ai/).
