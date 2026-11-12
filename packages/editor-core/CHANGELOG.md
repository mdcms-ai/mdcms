# @mdcms/editor-core

## 0.1.3

### Patch Changes

- Updated dependencies [a224137]
- Updated dependencies [7b8a4d1]
- Updated dependencies [ee95308]
  - @mdcms/shared@0.7.0

## 0.1.2

### Patch Changes

- d0f4b37: A document's md/mdx format now follows its body: it is mdx when it contains a component or an import/export line. The SDK renderer compiles with that format, the CLI names files after it and treats a .md/.mdx rename as the same document, and a component's load may return its module.
- Updated dependencies [d0f4b37]
  - @mdcms/shared@0.6.1

## 0.1.1

### Patch Changes

- 215a295: Extract reusable editor schema and Markdown/MDX conversion primitives into @mdcms/editor-core while keeping Studio compatibility exports.
- 36beee1: Fix editor no-op draft saves
- Updated dependencies [d862750]
  - @mdcms/shared@0.6.0
