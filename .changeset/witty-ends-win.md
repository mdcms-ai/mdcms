---
"@mdcms/editor-core": patch
"@mdcms/shared": patch
"@mdcms/studio": patch
"@mdcms/sdk": patch
"@mdcms/cli": patch
---

A document's md/mdx format now follows its body: it is mdx when it contains a component or an import/export line. The SDK renderer compiles with that format, the CLI names files after it and treats a .md/.mdx rename as the same document, and a component's load may return its module.
