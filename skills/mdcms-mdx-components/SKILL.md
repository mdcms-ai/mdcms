---
name: mdcms-mdx-components
description: Use when the user wants to register, wire up, or author a React/MDX component for MDCMS — phrases like "add a new component", "register this component with MDCMS", "register a component with the CMS", "add a Callout component", "register custom MDX components", "make my React component available in Studio", "wire a component to MDCMS", "my MDX uses custom components", "my MDX renders plain text for <Alert>", "<Callout> shows as a raw tag in Studio", or "the Studio preview doesn't render my component". Triggers on a generic "add a component" intent inside an MDCMS-aware repo (with `mdcms.config.ts`).
---

# MDCMS MDX Components

Register custom React components so they work in all three places that read MDCMS content:

1. Document bodies (`<Callout title="…">…</Callout>` in the stored MDX),
2. The Studio editor (insert from the toolbar or `/` menu, live preview, props form),
3. The host app's server render through `@mdcms/sdk/react`.

The code in this skill is complete and matches the shipped `@mdcms/*` types; use it as written.

## When to use this skill

The user has, or wants, content that uses custom components (`<Callout>`, `<Cta>`, `<Chart>`, `<Video>`) and wants them to work end to end. Also use when a component renders in one place but not another (for example the site renders it but Studio shows a placeholder).

Not for schema changes (`mdcms-schema-refine`) or plain Markdown (no registration needed).

## Prerequisites

- `mdcms.config.ts` exists (run **`mdcms-brownfield-init`** or **`mdcms-greenfield-init`** first).
- Each component is a React component in the host app's source tree.
- For Studio: the `/admin` route from **`mdcms-studio-embed`**. For the site: the renderer from **`mdcms-sdk-integration`**.

## How components flow

A component is registered once, in `mdcms.config.ts`, with these fields (the full contract; there are no others):

| Field             | Required | Purpose                                                                                                       |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `name`            | yes      | JSX tag used in content (`<Callout>` needs `name: "Callout"`). Case-sensitive.                                |
| `importPath`      | yes      | Path to the component source, relative to the project root. Studio reads the file's TypeScript props from it. |
| `load`            | no       | `() => Promise<…>` that loads the component. Used by the SDK renderer and by Studio previews.                 |
| `description`     | no       | Shown next to the component in Studio's insert menu.                                                          |
| `propHints`       | no       | Per-prop form hints, for example `{ href: { format: "url" } }`, `{ color: { widget: "color-picker" } }`.      |
| `propsEditor`     | no       | Path to a custom props editor component (instead of the generated form).                                      |
| `loadPropsEditor` | no       | `() => Promise<…>` that loads the custom props editor in Studio.                                              |

There is no `component:` field and no `MDXProvider` step:

- `@mdcms/sdk/react` (`createMdcmsRenderer(config)`) calls each registration's `load` itself.
- Studio gets the component list from the `/admin` page, which runs `prepareStudioConfig` on the server and attaches the same `load` functions in the browser by component name.

`load` may return the component itself (`import("./x").then((m) => m.Callout)`) or its module (`() => import("./x")`); for a module, the default export is used, then the export named like the component.

The config's component list is local to the host app. It is not part of the schema, so registering or changing a component does not need `mdcms schema sync`; Studio sees the change the next time the `/admin` page prepares its config (a page reload with the embed skill's `force-dynamic` page, or a dev-server restart if the prepared config is cached).

## Steps

### 1. Write the component with self-contained styles

Studio previews render the component inside the `/admin` route, which does not load the site's layout CSS or page-level selectors. Style the component with inline styles or a CSS module that the component file imports, so it looks the same on the site and in Studio.

`components/mdx/callout.tsx`:

```tsx
import type { ReactNode } from "react";

export type CalloutProps = {
  title: string;
  tone?: "info" | "warning";
  children?: ReactNode;
};

const toneColors = {
  info: { border: "#2563eb", background: "#eff6ff" },
  warning: { border: "#d97706", background: "#fffbeb" },
};

// Inline styles travel with the component, so it looks the same on the site
// and in the Studio preview.
export function Callout({ title, tone = "info", children }: CalloutProps) {
  const colors = toneColors[tone];

  return (
    <aside
      style={{
        borderLeft: `4px solid ${colors.border}`,
        background: colors.background,
        borderRadius: 6,
        padding: "12px 16px",
        margin: "16px 0",
      }}
    >
      <strong style={{ display: "block", marginBottom: 4 }}>{title}</strong>
      {children}
    </aside>
  );
}
```

Studio builds the props form from the props type: `title` becomes a required text field, `tone` a select with `info` and `warning`, and `children` editable rich text inside the component. Use plain, serializable prop types (strings, numbers, booleans, string unions, arrays of strings or numbers, `ReactNode` children). Keep components free of hooks and browser APIs unless they are marked `"use client"`; the SDK renders them on the server.

### 2. Register it in a shared module

Put the registrations in their own file at the project root, so both `mdcms.config.ts` and the Studio client component can import them. Keep this file free of server-only imports.

`mdcms.components.ts`:

```ts
import type { MdcmsComponentRegistration } from "@mdcms/cli";

// Used by mdcms.config.ts and by the Studio client component. Keep this file
// free of server-only imports so the browser bundle can include it.
export const mdxComponents = [
  {
    name: "Callout",
    importPath: "./components/mdx/callout",
    description: "Highlighted note with a title and a tone",
    load: () => import("./components/mdx/callout").then((m) => m.Callout),
  },
] satisfies MdcmsComponentRegistration[];
```

Use relative paths for `importPath` (resolved from the project root). Framework aliases such as `@/components/...` are not resolved when Studio reads the props.

### 3. Add the list to `mdcms.config.ts`

Add the import and the `components` entry; leave the other settings as they are:

```ts
import { mdxComponents } from "./mdcms.components";

export default defineConfig({
  // ...project, environment, serverUrl, contentDirectories, environments, types
  components: mdxComponents,
});
```

### 4. Attach the loaders in Studio

If Studio is embedded with **`mdcms-studio-embed`**, its client component already builds its loader map from `mdxComponents`:

```tsx
const loaders: Record<string, StudioComponentLoaderEntry> = Object.fromEntries(
  mdxComponents.map((component) => [component.name, component.load]),
);
```

For a component with a custom props editor, use an entry object instead of the bare function: `{ load, loadPropsEditor }`.

### 5. Render it on the site

The SDK renderer loads components from the same config, so nothing else is needed:

```tsx
import { createMdcmsRenderer } from "@mdcms/sdk/react";

import config from "../mdcms.config";

const renderer = createMdcmsRenderer(config);
// In a server component: const body = await renderer.render(document);
```

See **`mdcms-sdk-integration`** for fetching documents.

### 6. Verify

1. Reload `/admin` in the host app, open a document, type `/` and insert **Callout**. Fill in `title` in the props form. The block previews with its real styling.
2. Wait for **Saved**. The stored body now contains `<Callout title="…">…</Callout>`. A document becomes MDX automatically when its body contains a component; there is no format to switch, and a document created from a `.md` file works the same way.
3. Open the page on the site. The component renders with the same output as in Studio.

If Studio lists the component but shows a placeholder, the loader map has no entry for that name or `load` does not return a component. If Studio does not list it at all, the `/admin` page is serving a stale prepared config: reload, or restart the dev server.

## Common gotchas

- **Name mismatch**: `name` must equal the JSX tag in content exactly (`<Callout>` and `name: "Callout"`).
- **Unstyled in Studio**: the component relies on CSS from the site layout (a global stylesheet imported by a layout that `/admin` does not use, or selectors like `.post-body aside`). Move the styles into the component (inline or a CSS module it imports).
- **Server/client boundary**: the SDK renders components in a server component. A component that uses state, effects or browser APIs needs `"use client"` at the top of its file.
- **`import`/`export` lines in content**: the SDK renderer rejects MDX `import` and `export` syntax. Content uses registered components by tag only.
- **Void components**: a component without children is written as `<Chart />`, not `<Chart></Chart>`.

## Related skills

- **`mdcms-studio-embed`**: the `/admin` route that prepares the config and attaches the loaders.
- **`mdcms-sdk-integration`**: fetching documents and rendering their bodies with `@mdcms/sdk/react`.
- **`mdcms-schema-refine`**: when a component needs new content fields (components themselves are not part of the schema).

## Assumptions and limitations

- Examples use Next.js App Router. In other React frameworks, keep the same split: `mdcms.components.ts` shared, `prepareStudioConfig` on the server, loaders attached in the browser.
- Props are read from the component's TypeScript source. Functions, refs and other non-serializable props are not editable in the generated form. For object props, add a `{ widget: "json" }` prop hint for a raw JSON field, or provide `propsEditor` with `loadPropsEditor`.
- Requires a current `@mdcms/studio` and `@mdcms/sdk`. If `load` returning a module fails with "did not load a React component" or "Element type is invalid", the installed packages are older: return the component with `.then((m) => m.Callout)` as shown above, or update the packages.
