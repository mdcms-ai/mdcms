# CMS-245 Option B Design

## Goal

Implement the first phase of Option B from
`2026-05-19-runtime-editing-existing-ui-components.md`: MDX composition through
MDCMS-owned built-in components plus registered host components, available to
AI proposals and manual MDX editing before the dedicated visual composition UI
exists.

## Scope

Phase 1 includes:

- Nested MDX component parsing, validation, serialization, preview, and SDK
  rendering for AI/manual MDX authoring.
- Built-in MDX components: `Box`, `Text`, `Image`, and `Link`.
- First-class inline `style` props with flat string/number values.
- Catalog injection so built-ins are present without host registration.
- Studio discoverability filtering so built-ins do not appear in the current
  slash menu or toolbar Insert Component menu.

Phase 1 excludes:

- Dedicated visual UI for nesting components into component children.
- Hover, focus, responsive styles, CSS rule generation, selectors, custom CSS,
  user-authored `className`, and event-handler props.
- `Button` and `as` polymorphism.

## Component Model

MDX children remain normal nested document content. Markdown block syntax and
nested MDX components are valid inside wrapper component children:

```mdx
<Box style={{"padding":"24px"}}>
  ## Heading

  <Text style={{"fontWeight":600}}>
    [Styled link](/pricing)
  </Text>
</Box>
```

`Text` renders a `span`; it is for local inline/text-level style overrides.
Plain headings, paragraphs, lists, and links should remain normal Markdown.

`Link` renders an anchor and exists for styled semantic links. It is not a
button replacement and does not accept action/event props.

## Style Contract

`style` is a first-class extracted prop type:

```ts
type MdcmsInlineStyle = Record<string, string | number>;

type MdxExtractedProp =
  | ...
  | { type: "style"; required: boolean };
```

V1 validation is intentionally shallow:

- `style` must be an object.
- Keys may be any inline React style property name.
- Values must be strings or numbers.
- Arrays, nested objects, functions, expressions that cannot normalize to JSON,
  CSS strings, selectors, pseudo states, and responsive maps are invalid.

MDCMS does not own a design-token system in this phase. There are no `tone`,
`size`, `variant`, or similar token props on built-ins.

## Catalog Contract

Built-ins are normal catalog entries with one display/provenance flag:

```ts
{
  name: "Box",
  importPath: "@mdcms/sdk/react-primitives",
  builtIn: true,
  extractedProps: {
    style: { type: "style", required: false },
    children: { type: "rich-text", required: false }
  }
}
```

`builtIn: true` does not change MDX parsing, serialization, AI validation, or
rendering semantics. It lets Studio hide built-ins from current insertion menus
while keeping them available to AI/manual MDX.

Built-in names are reserved: `Box`, `Text`, `Image`, and `Link`. Host config
preparation fails if a host component uses one of those names.

## Packaging

React implementations live in a private internal workspace package:

```text
packages/react-primitives
```

The package is not published and app authors do not install it directly.
Published packages must bundle or inline the relevant primitive code so their
dist output does not require `@mdcms/react-primitives` at runtime.

Public React imports for applications come from a browser-safe SDK subpath:

```ts
import { Box, Text, Image, Link } from "@mdcms/sdk/react-primitives";
```

Studio imports the internal package during monorepo development/build, not the
server-only `@mdcms/sdk/react` renderer.

## Render Resolution

Studio preview resolves built-ins before host components. Host components still
resolve through the host bridge.

The SDK renderer includes built-ins in the MDX component map by default, then
adds host-loaded components. Reserved names prevent override ambiguity.

## Validation And UI

Server AI validation uses the same `mdxCatalog.components[]` list for built-ins
and host components. Unknown component names, unknown props, missing required
props, and invalid style values produce validation errors before apply.

The current Studio slash menu and toolbar Insert Component menu filter out
`builtIn: true`. The props panel and node views can still render/select/edit
built-in nodes already present in the document.

## Testing

Implementation should cover:

- Shared contract acceptance/rejection for `style` props and `builtIn`.
- Built-in catalog injection and reserved-name failures.
- Style prop extraction or explicit built-in catalog shape.
- MDX parse/serialize round trip for nested built-ins and style objects.
- AI validator acceptance/rejection for built-ins and style objects.
- Studio UI filtering from current insertion surfaces.
- Studio preview and SDK rendering with built-ins.
- Published package/build output does not leak a runtime dependency on the
  private primitive package.
