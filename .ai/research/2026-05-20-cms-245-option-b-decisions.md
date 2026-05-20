# CMS-245 Option B Decision Log

This log records the product and engineering decisions made during design so
they can be reviewed later without replaying the conversation.

## Locked Decisions

1. Phase 1 implements the underlying MDX composition capability for AI/manual
   MDX editing. The dedicated visual UI for dragging/nesting built-ins into
   component children is designed around but not implemented in this phase.

2. MDX children are normal nested document content. Markdown and nested MDX
   components are valid inside component children. No separate composition
   contract is introduced in V1.

3. Built-ins are not represented by a behavioral `primitive` flag. They are
   normal catalog entries with provenance/discoverability metadata.

4. The metadata name is `builtIn: true`. It marks MDCMS-provided components and
   lets Studio hide them from current insertion menus. It does not change
   rendering or validation behavior.

5. Built-ins are auto-injected. Host apps do not manually register `Box`,
   `Text`, `Image`, or `Link`.

6. Built-in names are reserved. Host config preparation fails if
   `config.components` declares `Box`, `Text`, `Image`, or `Link`.

7. V1 built-ins are `Box`, `Text`, `Image`, and `Link`.

8. `Button` is deferred. Link semantics are handled by Markdown links or the
   `Link` built-in. No content-authored event/action button model exists in V1.

9. No `as` prop in V1. Built-ins render fixed semantic elements:
   `Box -> div`, `Text -> span`, `Image -> img`, `Link -> a`.

10. `style` is a first-class prop type, not an untyped JSON convention.

11. V1 `style` accepts only flat inline styles:
    `Record<string, string | number>`.

12. V1 does not support hover, focus, responsive breakpoints, selectors,
    generated CSS, custom CSS, user-authored `className`, or CSS strings.

13. Style keys are not allowlisted in V1. Validation checks shape and value
    kinds only.

14. Built-ins accept `style`. Host components only support style when their own
    extracted prop metadata exposes a `style` prop.

15. MDCMS does not introduce design-token props like `tone`, `size`, `variant`,
    or `muted` in this phase.

16. React implementations live in a private internal workspace package,
    `@mdcms/react-primitives`, under `packages/react-primitives`.

17. The internal primitives package is not published and must not leak as a
    runtime dependency from published package output.

18. Public application imports come from `@mdcms/sdk/react-primitives`.

19. Studio imports the internal primitive source/package for preview. Studio
    does not import the existing server-only `@mdcms/sdk/react` renderer.

20. The SDK renderer includes built-ins by default when rendering MDX content.

21. Current Studio slash menu and toolbar Insert Component menu hide built-ins.
    AI proposals and manual MDX editing may still create built-in nodes.

22. Builder.io inspiration was used only for product shape. Builder's richer
    `responsiveStyles`/generated-CSS model is intentionally deferred. MDCMS V1
    uses inline styles only.

## Offline Engineering Decisions To Validate During Implementation

1. Public SDK export path is `@mdcms/sdk/react-primitives`.

2. The internal package may be marked `private: true` and built as a normal
   workspace package, but published consumers must bundle the implementation or
   copy compiled files so npm users do not need the private package.

3. Auto-form mapping for `style` can reuse a JSON object editor in this phase.
   A dedicated visual style editor is deferred.

4. Host component style extraction should be conservative. The implementation
   should recognize React inline style shapes only when deterministic; otherwise
   the prop remains hidden unless a future explicit override is introduced.

5. If published build output cannot bundle a private workspace package cleanly
   with the current TypeScript/Nx setup, duplicate tiny generated wrapper files
   in `@mdcms/sdk` and `@mdcms/studio` as a fallback, while keeping the source of
   truth and tests in `packages/react-primitives`.
