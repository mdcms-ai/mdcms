# Structured Intrinsic MDX Elements Design

## Decision

Studio will treat parseable lowercase intrinsic MDX/HTML elements as structured
visual blocks instead of raw JSX preview islands. Tags such as `div`, `section`,
`form`, `label`, `input`, and `button` remain valid MDX, but the editor surface
represents them as block nodes with a tag name, props, void status, and editable
children.

Raw JSX preservation remains only for syntax Studio cannot safely represent as
structured data. The fallback must be explicit unsupported content, not a
sanitized partial HTML preview that hides the wrapper tag while showing escaped
children.

## Rationale

The current raw JSX island behavior preserves valid MDX but creates a confusing
editing model. A lowercase wrapper like `<div>` can swallow nested registered
components, causing the wrapper to render as invisible HTML while nested
PascalCase components appear as escaped text. Editors should see all document
structure as blocks when it is parseable, including native HTML elements.

## Editor Contract

- Uppercase MDX elements continue to parse as `mdxComponent` nodes.
- Parseable lowercase MDX/HTML elements parse as `mdxIntrinsicElement` nodes.
- Intrinsic nodes store `tagName`, `props`, and `isVoid`.
- Intrinsic nodes can contain parsed Markdown, registered components, built-ins,
  and other intrinsic nodes when the source element is not void.
- Intrinsic nodes serialize back to lowercase MDX/HTML tags.
- Intrinsic nodes are not inserted from the default component palette in this
  pass.
- Intrinsic nodes do not use catalog validation because their contract is native
  HTML syntax, not host component metadata.
- Unparseable JSX remains preserved as unsupported raw content.

## Implementation Shape

The parser should use the MDX AST that already exposes lowercase elements and
their children. Instead of returning `mdxRawJsx` for every non-uppercase element,
it should parse attributes and return `mdxIntrinsicElement` for lowercase tag
names when attributes are representable. The existing raw JSX extension stays as
the fallback for cases that cannot be represented.

The new node extension should mirror the block affordances of `mdxComponent`
where practical: block group, selectable, isolating, optional content for
non-void elements, Markdown parse/render hooks, and an editor node view that
shows the tag label and nested content. The side panel can initially reuse the
existing prop editing path by exposing the selected node's props and tag name.

## Validation

Targeted tests should prove that:

- `<div><Hero /></div>` parses into an intrinsic `div` node containing an
  `mdxComponent` `Hero` child.
- Nested intrinsic elements round-trip through Markdown without becoming raw
  preview text.
- Native form syntax still round-trips, including void controls such as
  `<input />`.
- Existing raw fallback tests continue to pass for unsupported/unparseable
  syntax.
