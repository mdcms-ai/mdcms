# @mdcms/sdk

## 0.4.3

### Patch Changes

- Updated dependencies [a224137]
- Updated dependencies [7b8a4d1]
- Updated dependencies [ee95308]
  - @mdcms/shared@0.7.0

## 0.4.2

### Patch Changes

- b1a1405: Add @mdcms/studio/client-config with toSerializableStudioConfig and createStudioClientConfig for passing a prepared Studio config, including registered MDX components, from a server component to the browser, and re-export the document response types from @mdcms/sdk.
- d0f4b37: A document's md/mdx format now follows its body: it is mdx when it contains a component or an import/export line. The SDK renderer compiles with that format, the CLI names files after it and treats a .md/.mdx rename as the same document, and a component's load may return its module.
- Updated dependencies [d0f4b37]
  - @mdcms/shared@0.6.1

## 0.4.1

### Patch Changes

- 43f5dc6: Add q search support to SDK list reads.
- Updated dependencies [d862750]
  - @mdcms/shared@0.6.0

## 0.4.0

### Minor Changes

- eb598b2: Add schema file field types under fieldTypes, move references to fieldTypes.reference, and expand file fields to media assets on reads.

### Patch Changes

- Updated dependencies [e873553]
- Updated dependencies [e873553]
- Updated dependencies [15fdaee]
- Updated dependencies [e873553]
- Updated dependencies [e873553]
- Updated dependencies [eb598b2]
- Updated dependencies [8d8feb9]
  - @mdcms/shared@0.5.0

## 0.3.0

### Minor Changes

- a48b9d8: Add preview token verification helpers for draft previews

### Patch Changes

- Updated dependencies [a48b9d8]
  - @mdcms/shared@0.4.0

## 0.2.0

### Minor Changes

- a636044: Add server-side React rendering for SDK content bodies
- 50ae976: Add built-in MDX primitives and inline style props

### Patch Changes

- Updated dependencies [ec9e435]
- Updated dependencies [7bb04b7]
- Updated dependencies [50ae976]
- Updated dependencies [6409863]
  - @mdcms/shared@0.3.0

## 0.1.3

### Patch Changes

- Updated dependencies [a81169a]
- Updated dependencies [98779f0]
  - @mdcms/shared@0.2.0
