# @mdcms/studio

Embeddable Studio UI component for MDCMS. Drop it into any React app at a catch-all route to get a full content management interface.

## Install

```bash
npm install @mdcms/studio
```

## Embedding in a Next.js App

Create a catch-all route for Studio with a server component and a client component:

```tsx
// app/admin/[[...path]]/page.tsx
import { toSerializableStudioConfig } from "@mdcms/studio/client-config";
import { prepareStudioConfig } from "@mdcms/studio/runtime";

import config from "../../../mdcms.config";
import { AdminStudioClient } from "./admin-studio-client";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  // Runs on the server, where the full config is available: computes the
  // schema hash that lets Studio write, and reads component props.
  const prepared = await prepareStudioConfig(config, { cwd: process.cwd() });

  return <AdminStudioClient config={toSerializableStudioConfig(prepared)} />;
}
```

```tsx
// app/admin/[[...path]]/admin-studio-client.tsx
"use client";

import { useMemo } from "react";
import { Studio } from "@mdcms/studio";
import {
  createStudioClientConfig,
  type SerializableStudioConfig,
} from "@mdcms/studio/client-config";

const loaders = {
  Callout: () => import("../../../components/callout"),
};

export function AdminStudioClient(props: { config: SerializableStudioConfig }) {
  const configKey = JSON.stringify(props.config);
  const config = useMemo(
    () =>
      createStudioClientConfig(
        JSON.parse(configKey) as SerializableStudioConfig,
        { loaders },
      ),
    [configKey],
  );

  return <Studio config={config} basePath="/admin" />;
}
```

`prepareStudioConfig` runs on the server, where the full `mdcms.config.ts` is available. It computes the schema hash Studio needs before it allows edits and extracts the props of registered MDX components. The full config holds Zod schemas and functions that cannot cross the server/client boundary, so `toSerializableStudioConfig(prepared)` keeps only plain values: project, environment, server URL, content directories, locales, type names, the registered components (with their extracted props) and the schema hash. Built-in components are left out; Studio always adds them.

`createStudioClientConfig(serializable, options)` builds the config for `<Studio />` in the browser:

| Option                | Description                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loaders`             | Map from component name to its `load` function, or to `{ load, loadPropsEditor }`. Components without a loader are listed in Studio and show a placeholder instead of a preview. Unknown names are ignored. |
| `previewUrlResolvers` | Map from content type name to a live preview URL resolver, the same function as the type's `resolvePreviewUrl`.                                                                                             |

It returns a new object on every call. Build it once per distinct value (as above, or at module scope): a new `config` object can make Studio reload its runtime.

Do not use `createStudioEmbedConfig` for an editing Studio: it carries no schema hash, so every document opens read-only.

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
creation and editing use addressable `/admin/settings/webhooks/new` and
`/admin/settings/webhooks/:id` routes so refresh and back navigation preserve
the operator's location. The table also includes a direct active/inactive toggle
for quick enablement changes. Webhook secrets are write-only; Studio never shows
a saved secret, and leaving the edit secret field empty preserves the existing
secret.

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

`load` may return the component or its module: Studio and `@mdcms/sdk/react` use the module's default export, then the export named like the component. Pass the same loaders to `createStudioClientConfig` (see above), since functions in `mdcms.config.ts` do not reach the browser through the prepared config. Studio previews render inside the Studio route, so give components self-contained styles (inline styles or a CSS module the component imports) rather than relying on the site's layout CSS.

Registered components can be inserted from the toolbar or via `/` slash commands in the editor. A document becomes MDX as soon as its body contains a component; there is no format to switch. Studio auto-generates a props editing panel from extracted component props, or you can provide a custom props editor.

## Exports

| Import Path                            | Description                                                       |
| -------------------------------------- | ----------------------------------------------------------------- |
| `@mdcms/studio`                        | `Studio` component, `PropsEditorComponent` type                   |
| `@mdcms/studio/runtime`                | `prepareStudioConfig`, `createStudioEmbedConfig`, runtime helpers |
| `@mdcms/studio/client-config`          | `toSerializableStudioConfig`, `createStudioClientConfig`          |
| `@mdcms/studio/markdown-pipeline`      | `parseMarkdownToDocument`, `serializeDocumentToMarkdown`          |
| `@mdcms/studio/document-shell`         | `loadStudioDocumentShell` for host-app shell rendering            |
| `@mdcms/studio/action-catalog-adapter` | Typed action catalog client                                       |

## Documentation

Full Studio reference at [docs.mdcms.ai](https://docs.mdcms.ai/).
