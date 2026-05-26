# Runtime Editing of Existing UI Components in CMS and AI Website Builders

Date: 2026-05-19

## Executive Answer

Yes, MDCMS can support AI-assisted visual editing of existing React/UI sections without becoming a Builder.io-style runtime renderer, but only if "editing" is constrained to code-owned component contracts and document-owned layout/content structures.

The realistic boundary is:

- AI may edit document content, MDX component instances, component props, and a small set of layout primitives represented in Markdown/MDX.
- AI may preview proposed changes visually in Studio through the existing host bridge.
- AI may produce source-code patches or PRs for changes that alter component internals, component hierarchy outside document-owned MDX, CSS modules, Tailwind classes, or application layout code.
- AI should not persist arbitrary DOM patches, selector overrides, inline JavaScript, or page-level JSON render trees as the normal production rendering path.

The main finding is that platforms that enable "visual editing without source changes" choose one of two tradeoffs:

1. They render from a persisted UI tree, usually JSON blocks, and ship a runtime renderer.
2. They mutate the already-rendered DOM with selectors, JavaScript, and injected CSS.

Both are fundamentally different from MDCMS's current developer-first architecture. The first moves UI ownership toward the database. The second is fragile in React/SPA apps and carries security, flicker, hydration, and debugging costs.

Recommended MVP: extend MDCMS's existing MDX component model into a "component instance editing" system. AI can propose edits to registered components and their serializable props, plus a bounded layout primitive set for document-owned sections. Existing React components remain code-owned. Anything beyond registered props and document-owned structure becomes a source-code change workflow, not a runtime override.

## Local MDCMS Context

Spec delta: none. This is research only; no owning spec was changed.

Relevant existing constraints:

- `docs/specs/SPEC-006-studio-runtime-and-ui.md` defines Studio as an embedded runtime with a host bridge. The host owns executable React component resolution and preview rendering.
- `docs/specs/SPEC-007-editor-mdx-and-collaboration.md` defines registered MDX components, serializable prop metadata, TipTap node views, host-rendered previews, and Markdown/MDX as the persisted document body.
- `docs/specs/SPEC-014-ai-assisted-studio-editing.md` defines AI proposals, validation, draft-only writes, MDX grounding against the active component catalog, and no publish authority for AI.

This means MDCMS already has the right foundation for bounded visual editing: code-owned components, metadata-owned editable props, document-owned MDX component instances, and server-mediated AI proposals.

## Research Summary

### Builder.io

Builder's visual CMS architecture is explicitly runtime-rendered from content JSON.

The Builder Visual Editor loads the customer's site in an iframe. The site must include a Builder SDK integration. In edit mode, the SDK waits for messages from the Builder web app, receives JSON content, receives patches as edits are made, and renders those updates. Custom components are registered by the app, and Builder keeps a name-to-component map plus metadata about component inputs.

The persisted data model uses nested "blocks." Builder's Write API documents `data.blocks` for Page and Section models. A block includes `tagName`, `responsiveStyles` for breakpoints, `component.name`, `component.options`, and `children`. Builder's Gen 2 React SDK renders a content JSON object through `<Content model apiKey content={...} />`; Gen 1 uses `<BuilderComponent model content={...} />`.

Custom components stay in code, but each use of a component in a Builder page is an entry in Builder's JSON tree. Builder wraps components in a `div` by default; `noWrap` opts out, but then the component must pass Builder-provided attributes so Builder can attach classes/metadata. Default styles, bindings, custom data, actions, and child blocks are part of the runtime content model.

Builder's built-in editing surface is effectively a primitive block system. The Insert tab exposes blocks such as Text, Image, Button, Columns, Box, and Section, alongside registered Custom Components, Templates, Symbols, Code, and media blocks. This is the closest Builder analogue to Approach B: editors compose page-owned UI from generic layout/content blocks, while developer-owned custom components are separately registered as insertable blocks.

Builder also supports reusable Builder-authored compositions, but they remain Builder content constructs, not generated source-code components. Templates are saved groups of blocks that can be reused as starting points; edits to a dropped Template instance do not affect the original Template or other instances. Symbols are reusable blocks controlled from one source; changing the source Symbol updates every content entry that uses it. Symbols can also expose Slot blocks so each usage can accept nested child blocks. This means Builder can create reusable block compositions from blocks, but those reusable compositions live in Builder's content model unless exported or rebuilt through a code-generation workflow.

How Builder supports visual changes:

- Layout changes are block-tree changes: insert, remove, move, nest, or reorder blocks.
- Style changes are represented as block style metadata, including responsive style buckets.
- Component prop changes are represented as `component.options`.
- Drag/drop edits persist as JSON changes, not source-code edits.
- Responsiveness is preserved by serializing responsive styles and by built-in responsive blocks such as columns.

Gen 1 vs Gen 2:

- Gen 1 React package: `@builder.io/react`, `BuilderComponent`.
- Gen 2 React package: `@builder.io/sdk-react`, `Content`.
- Builder's own SDK comparison shows both support custom components, SSR/SSG, child blocks, custom styles, A/B tests, dynamic bindings, global state, animations, and built-in blocks.
- Mitosis is adjacent infrastructure for generating SDKs/components across frameworks, not an escape from the runtime content-tree model.

Visual Copilot and Builder code generation are a different path. Builder can generate React, HTML, Svelte, Angular, Mitosis, and styling outputs such as Tailwind, CSS, Emotion, styled-components, and styled-jsx. AI custom instructions guide generated code. This is source/code generation, not runtime mutation of an existing component without code changes.

Implication for MDCMS: Builder's true visual editing works because the editable surface is a Builder-owned JSON block tree. Adopting the same power means accepting a runtime renderer and persisted UI trees. MDCMS can borrow "registered code components with typed props" without adopting "page is a database JSON tree."

### Visual A/B Testing and Personalization Tools

These tools generally do not understand React components. They target rendered DOM.

#### Optimizely Web Experimentation

Optimizely stores web experiments as sets of "changes" applied to the original page. Official change types include append, attribute, rearrange, redirect, and widget. Changes target CSS selectors; rearrange uses source and destination selectors and may poll until elements appear.

The Visual Editor stores structured visual changes separately from custom code. Custom JavaScript and CSS can also be added at variation or experiment level. JavaScript may run immediately, before DOM is ready. CSS is injected by appending a `<style>` tag to `<head>`. Optimizely provides synchronous and asynchronous timing options to reduce flicker for small above-the-fold changes while deferring heavier changes.

For dynamic websites and SPAs, Optimizely supports URL-change triggers using a History API runtime patch and DOM-change triggers using `MutationObserver`. Its docs call out that custom code may need utility APIs such as `waitForElement`, `observeSelector`, polling, or `waitUntil`.

Optimizely's dynamic selector docs are especially relevant to React/Next.js: if a visual editor chooses a generated dynamic ID, later reloads or redeploys can break the variation. Optimizely mitigates this with custom attribute selector targeting and parent-path fallback.

#### VWO

VWO's Visual Editor stores selector paths and changes. It lets users choose default unique CSS paths, class/custom-attribute selectors, tag names, or manually entered paths. Its code editor can show a generated Visual Editor block and lets users add JavaScript, CSS, and HTML code blocks.

VWO code blocks support triggers such as campaign execution, element loaded, DOM ready, run after another block, and campaign exit. It includes explicit hide/unhide controls to avoid flash of original content and a "revert changes" path for SPAs where mutations can otherwise remain after navigation. VWO also minifies campaign JavaScript/CSS and states that visual-editor-generated campaigns benefit from minification.

VWO Editor Copilot does not appear to solve the structural problem. It analyzes existing visual-editor changes and generates more variations for messaging, visuals, or layouts. The delivery model remains visual variations/DOM changes.

#### Adobe Target

Adobe Target's Visual Experience Composer persists each page modification as an action. The Modifications panel can add CSS selector modifications, mbox modifications, or custom code. Custom code can inject JavaScript, HTML, or CSS at the top of page load.

Adobe documents the fragility directly: if a later action modifies an element created by an earlier action and the first action is deleted, the later action has nothing to modify. It warns that structural page changes can make actions fail, that multiple activities on the same URL can inject conflicting JavaScript, and that `document.write` is unreliable because scripts execute asynchronously.

#### Convert

Convert's Visual Editor lets users click elements, inspect container hierarchy, make property changes, use code editors, and preview different window sizes. Its Browse Mode turns off changes so users can interact with dynamic elements in the original page, then return to editing. This matches the same selector/action pattern and demonstrates the edit-vs-interact tension in iframe or overlay-based editors.

#### Mutiny

Mutiny's personalization model is also client-script-driven. The Mutiny client is a JavaScript bundle loaded through script tags; it identifies the visitor, fetches personalization data, evaluates segments and experiences, and changes the page on the fly. For page-content personalizations, Mutiny copies the original element, hides the original with an inline `display: none !important`, and shows the personalized replacement.

Mutiny's docs are explicit about performance/flicker tradeoffs. Its client installs a "hider" CSS rule so personalized elements are invisible until the personalization is applied or a timeout expires. For cases where Mutiny cannot know which elements to hide, such as page-level custom JavaScript, it provides an anti-flicker snippet that hides the whole page until the client loads or a timeout is reached. Its CSP docs require allowlisting Mutiny domains for scripts, images, connections, and editor framing.

#### GrowthBook

GrowthBook rebuilt its Visual Editor around a browser extension rather than an iframe to avoid iframe bugs and security issues. It integrated visual experiments into its JavaScript and React SDKs rather than a separate script tag. Its docs still warn that the Visual Editor may not work optimally on client-side rendered apps and recommend feature flags instead for those cases.

GrowthBook's runtime supports visual experiments in the browser SDK payload. In SPAs, the app must notify GrowthBook on URL changes. GrowthBook also maintains `dom-mutator`, a tiny library for persistent DOM mutations that can reapply changes when React or another renderer updates the underlying element.

GrowthBook's edge-worker work is the most interesting mitigation: render visual experiment variants directly into HTML at the CDN edge. This avoids client flicker, page hiding, and ad-blocker issues. The tradeoff is that the mutation moves earlier into the response pipeline and requires edge worker infrastructure plus HTML rewriting/proxying.

#### LaunchDarkly and PostHog

LaunchDarkly experimentation is flag-driven. Experiments attach metrics to feature flag or AI Config variations. There is no general visual DOM editor in the core product model. This is the cleanest architecture for React apps: code chooses between variants and the platform handles targeting, assignment, and measurement.

PostHog is similar for the core experimentation path. Feature flags toggle features for users, groups, or percentages of traffic and are the foundation for A/B tests and remote config. React integrations use SDK hooks/providers, and experiments are implemented through flags rather than a general page-mutating visual editor.

Google Optimize historically followed the WYSIWYG experiment-editor pattern: users created visual variants and Google applied changes with JavaScript according to experiment rules. Its 2023 shutdown matters less than the architecture lesson: the old mainstream no-code experiment model was still selector/JS mutation, not source-aware React component editing.

Implication for MDCMS: A/B tools prove DOM mutation is feasible, but their own docs show the operational cost: selector drift, timing triggers, flicker prevention, SPA cleanup, custom code conflicts, and preview/live mismatch. This is appropriate for short-lived marketing experiments, not for durable content architecture.

### Runtime Editing in React Apps

React does not expose a stable public API for "edit arbitrary component output at runtime." The reliable integration points are props, state, context, children, portals, and code changes.

DOM-level edits work only outside React's ownership model. Once React re-renders, it may overwrite external DOM changes. Libraries such as GrowthBook's `dom-mutator` address this by observing and reapplying changes, which is useful but confirms the underlying conflict.

Hydration makes this worse. React expects server-rendered HTML to match the client render; the React docs say to treat hydration mismatches as bugs, and warn that mismatches can cause slowdowns or wrong event handler attachment. A runtime visual override that changes DOM before, during, or immediately after hydration risks a mismatch, flicker, or a second render pass.

Feasible React-safe mechanisms:

- Prop-level editing of registered components.
- Wrapper slots/children controlled by the document model.
- Portals or overlays for editor UI, not for persisted page changes.
- Feature flags selecting code-defined variants.
- Source-code patches or PRs for structural component changes.
- Server/edge-side HTML transformation only for intentionally isolated experiments.

Fragile mechanisms:

- Selector-based edits against generated CSS classes.
- Direct DOM moves inside React roots.
- React Fiber inspection or monkey patching.
- Custom renderers for arbitrary app components.
- CSS overrides that depend on local class names not designed as public selectors.

### AI Website Builders and AI Page Editors

AI website/app builders mostly avoid the "runtime edit existing component without code" problem by generating or modifying code.

Replit's Visual Editor is explicit: simple deterministic edits such as text, colors, spacing, and image changes update source code directly; complex changes route to Agent. Reused elements rendered in loops can update all instances, and selecting an element can jump to source. This is code-synchronized visual editing, not database-stored DOM mutation.

Lovable's GitHub integration treats the project code and the GitHub repository as synced sources. Changes made in Lovable sync to GitHub; changes pushed to the active GitHub branch sync back into Lovable. Lovable commits as a bot and supports branch switching. Again, this is code ownership plus sync, not a permanent runtime overlay.

v0 is primarily a code-generation workflow around React/shadcn/Next.js. The shadcn docs describe opening components in v0, customizing them in natural language, and pasting the resulting code into an app.

Webflow's newer Code Components are close to the MDCMS-safe model. React components are developed outside Webflow, declared with props/slots/variants, bundled through DevLink, and then configured visually on the Webflow canvas. Webflow says props are defined in the codebase, and updating code components requires codebase changes and re-sharing the component. AI code components can be generated inside Webflow, but the editable contract is still props and slots rather than arbitrary mutation of existing source components.

Wix Studio separates visual authoring from code paths. Developers can use a built-in Code panel, Wix's VS Code-based IDE, or GitHub/local IDE integration. Its docs describe page code, global code, CSS styling, properties/events, backend files, packages, Blocks, and an AI assistant for writing/fixing code. This is a platform-owned site model plus code extension layer, not a lightweight overlay for arbitrary external React apps.

Framer, Webflow, Wix, Durable, Typedream, and Gamma have more proprietary internal models. Public behavior strongly suggests their editable surfaces are platform-owned page models or generated code/design artifacts, not arbitrary mutation of a developer's existing React component tree. They are useful comparisons for UX, but they do not validate a lightweight runtime override architecture for MDCMS.

Implication for MDCMS: The AI-builder path that best aligns with developer-first architecture is code patching/PR generation for component internals and bounded document/prop editing for CMS-owned content.

## Can We Support These User Requests Without Source Code Changes?

| Request                          | Safe without source code?                                                     | Recommended MDCMS representation                                             |
| -------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| "Center this hero"               | Yes, if hero exposes an alignment prop or is in a CMS-owned layout primitive. | Update MDX component prop, e.g. `align="center"`, or layout primitive props. |
| "Remove right image"             | Yes, if image is a nullable prop or optional child slot.                      | Set prop to `null`, remove an MDX child block, or use a defined variant.     |
| "Change CTA layout"              | Sometimes. Safe only when CTA layout is a declared prop/variant.              | Update `ctaLayout="stacked"` or switch to a registered variant.              |
| "Move buttons below text"        | Sometimes. Safe when button group is a child slot or layout primitive.        | Reorder document-owned child nodes, not arbitrary DOM nodes.                 |
| "Restyle section colors/spacing" | Yes, if tokens/spacing props are exposed.                                     | Update tokenized props, not raw CSS.                                         |
| "Inject dynamic structures"      | Only within registered components/primitives.                                 | Insert registered MDX component or primitive tree.                           |
| "Fully override existing UI"     | No, not safely without changing source or rendering a database-owned tree.    | Create PR/source patch, or create an isolated draft iframe prototype.        |

The core rule: if the desired change can be expressed as a stable public component contract, it can be runtime-editable. If it requires changing markup, CSS selectors, hooks, event handlers, or component composition inside a code-owned component, it is source work.

## Isolation Tradeoffs

| Mechanism                      | Strengths                                    | Weaknesses                                                                         | Fit for MDCMS                                                                |
| ------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Inline styles                  | Easy to serialize and apply.                 | Hard to theme, weak responsive/design-system fit, high specificity drift.          | Avoid except inside isolated drafts.                                         |
| Scoped CSS/classes             | Familiar, cacheable, can use design tokens.  | Requires stable generated selectors or a CSS compiler/runtime.                     | Good for primitives if class generation is deterministic and server-side.    |
| CSS Modules/Tailwind classes   | Developer-friendly in source.                | Runtime authoring requires exposing class names as product API.                    | Good only through token/variant props.                                       |
| CSS-in-JS runtime overrides    | Dynamic and component-local.                 | Runtime cost and library lock-in; hard to inspect from CMS.                        | Avoid as persisted CMS output.                                               |
| Shadow DOM                     | Strong style isolation for embedded islands. | Theming and host CSS integration are harder; SSR/hydration integration is complex. | Good for Studio/editor chrome or sandboxed widgets, not main page rendering. |
| Iframes                        | Strongest isolation for untrusted HTML/JS.   | Expensive, separate document context, resizing/communication complexity.           | Good for raw HTML drafts/prototypes only.                                    |
| Host-rendered React components | Best UX fidelity, code-owned behavior.       | Requires component contracts and host bridge.                                      | Best fit.                                                                    |

## Security Assessment

AI-generated HTML is dangerous if persisted and rendered as trusted site content.

XSS risk is not theoretical. OWASP describes XSS as injection of malicious scripts into trusted sites; stored XSS is especially relevant because malicious content can be saved in a database and later served to many users. MDN's CSP guidance says CSP is a defense-in-depth mechanism, not a substitute for sanitization, and warns against `unsafe-inline` and `unsafe-eval`.

Security implications by approach:

- Raw HTML/CSS/JS drafts: high risk. Must run in sandboxed iframes on a separate origin, with no same-origin cookies, no top navigation, no unsandboxed scripts, and strict CSP. Treat as preview-only unless manually converted into code/components.
- Runtime DOM patches: medium to high risk. Injected JS/CSS runs in the host page context, can access application DOM, and can conflict with auth/session-bearing pages.
- Primitive/component composition: low to medium risk. Inputs are structured and validated; scripts are not accepted; rendering uses trusted code components.
- Source-code PRs: normal software supply-chain risk. Requires review, tests, and deploy controls.

For MDCMS, AI should not persist executable script content as a normal document operation. The existing SPEC-014 proposal validation, MDX component grounding, draft-only writes, and authorization checks are the right trust boundary.

## Performance and DX Assessment

### Components in Code

Pros:

- Small runtime: app ships its own components and normal framework bundle.
- SSR/SSG and caching remain predictable.
- Debugging maps to source files.
- Design system and accessibility stay in developer-owned code.
- Git history remains meaningful for structural changes.

Cons:

- Editors/AI can only manipulate exposed props/slots.
- New layout freedom requires component or primitive authoring.
- Fully visual page building needs additional contract design.

### Components in CMS / Runtime JSON

Pros:

- Strong visual editing and drag/drop autonomy.
- Editors can rearrange arbitrary trees without developer deploys.
- A/B/personalization can target block subtrees.

Cons:

- Requires a renderer for persisted UI trees.
- Adds client/server runtime complexity.
- Debugging moves from source to CMS data.
- More runtime payload and hydration concerns.
- Component/database schema evolution becomes a product problem.
- Long-term lock-in around the renderer data model.

## Architecture Option Analysis

Effort estimates assume a small experienced team, the current MDCMS Studio/MDX foundation, and a narrow internal/demo MVP rather than a hardened public launch.

### Approach A: Raw HTML Drafts

AI generates isolated HTML/CSS/JS snippets, previewed in sandboxed iframes.

MVP complexity: low to medium.
Production complexity: high if anything moves beyond preview.
Scalable complexity: very high.

Effort estimate:

- MVP: 3-5 days for a raw HTML/CSS draft component, isolated preview, save-as-draft, and no production JavaScript.
- Production-ready: 2-4 weeks if drafts need permissions, audit logs, CSP/sandbox hardening, sanitizer rules, rollback, and a clear conversion/export path.
- Scalable architecture: 1-2 months if the draft lane must support many sites, isolated origins, asset governance, approval workflows, and reliable conversion into primitives or code.

Use for: throwaway visual exploration, screenshot comparison, early ideation.

Avoid for: production rendering, durable document content, interactivity, authenticated pages.

Security/performance: highest XSS risk; iframe isolation adds cost; CSP/sandboxing is mandatory.

Verdict: acceptable as a draft/prototype layer only.

### Approach B: Generic Primitive Components

AI composes `Stack`, `Grid`, `Box`, `Text`, `Image`, `Button`, `Columns`, etc., plus registered code components.

Builder Publish uses this pattern for its own CMS-owned block layer: generic blocks such as Box, Section, Columns, Text, Image, and Button can be composed visually, then reused through Templates or Symbols. This should not be confused with Builder custom components. Custom components are developer-authored code components registered with Builder; Builder can instantiate and configure them, but it does not synthesize a new reusable source-code component from arbitrary blocks in the CMS runtime path.

MVP complexity: medium.
Production complexity: medium to high.
Scalable complexity: medium, if the primitive surface stays disciplined.

Effort estimate:

- MVP: about 2 weeks for a narrow primitive set, tokenized props, schema validation, MDX serialization, Studio insertion/edit UI, and basic AI proposal validation.
- Production-ready: 4-8 weeks for richer children/slot composition, responsive constraints, accessibility rules, token integration, undo, and component authoring docs.
- Scalable architecture: 2-4 months for component versioning, migrations, cross-site token governance, richer slot models, and enough primitive breadth to avoid users falling back to raw HTML.

Use for: document-owned layout sections, landing-page-like content, AI insertion, safe visual editing.

Security/performance: good if primitives compile to MDX/React with tokenized props and no raw script.

Verdict: best complement to current MDCMS architecture.

### Approach C: Runtime Visual Overrides

Persist selector/style/script patches or Builder-like runtime blocks.

MVP complexity: medium for a fragile demo; high for credible production.
Production complexity: very high.
Scalable complexity: very high.

Effort estimate:

- MVP: 2-4 weeks for stable edit IDs/selectors, text/style-only overrides, preview/apply/rollback, and basic SPA reapply behavior.
- Production-ready: 2-4 months for selector drift handling, MutationObserver cleanup, hydration/flicker mitigation, conflict resolution, permissions, audit trails, and browser/device QA.
- Scalable architecture: 6+ months for multi-framework support, edge/server-side mutation options, experiment lifecycle controls, observability, debugging tools, and safe coexistence with host app releases.

Use for: temporary experiments, not canonical CMS rendering.

Security/performance: selector drift, React re-render conflicts, hydration/flicker issues, injected JS/CSS, debugging opacity.

Verdict: explicitly avoid as core architecture.

### Approach D: Source Code Modification / PR Generation

AI edits actual source files and creates a branch/PR.

MVP complexity: medium to high.
Production complexity: high because repo access, code search, test running, CI, deploy, and review must be managed.
Scalable complexity: medium to high.

Effort estimate:

- MVP: 3-6 weeks for one Git provider, repo connection, component-location hints, branch creation, targeted file edits, diff preview, and human-approved PR creation.
- Production-ready: 2-4 months for multi-repo/package layouts, CI/test orchestration, preview deploy integration, permissions, secret handling, code ownership, and safe rollback.
- Scalable architecture: 6+ months for broad framework support, repo indexing, design-system awareness, component migration assistance, organization policies, and reliable multi-tenant operation.

Use for: component internals, new components, design-system changes, event handlers, complex layouts.

Security/performance: best runtime result after review, but automation must be permissioned and auditable.

Verdict: best answer for changes beyond component contracts.

## Recommendation Matrix

Scores: 1 = poor, 5 = strong.

| Approach                                      | Flexibility | Performance | Security | Maintainability |  DX | Implementation speed | Long-term scalability |
| --------------------------------------------- | ----------: | ----------: | -------: | --------------: | --: | -------------------: | --------------------: |
| A: Raw HTML drafts                            |           5 |           2 |        1 |               1 |   2 |                    4 |                     1 |
| B: Generic primitives + registered components |           4 |           4 |        4 |               4 |   4 |                    3 |                     4 |
| C: Runtime visual overrides                   |           4 |           2 |        2 |               1 |   2 |                    2 |                     1 |
| D: Source code PRs                            |           5 |           5 |        4 |               5 |   3 |                    2 |                     4 |

Best combined strategy:

1. B for CMS-owned runtime editing.
2. D for code-owned component evolution.
3. A only for isolated visual drafts.
4. Avoid C as canonical architecture.

## Complexity Estimate for MDCMS

### MVP

Scope:

- AI can select and edit existing MDX component instances in Studio.
- AI can update serializable props that already exist in `MdxComponentCatalog`.
- AI can insert registered components.
- AI can compose a small layout primitive set if added as registered MDX components.
- Studio supports basic component children composition beyond plain text children.
- Studio shows visual preview through existing host bridge.
- Server validates proposal against content schema and MDX catalog before apply.

Effort: about 2 weeks for a narrow MVP.

Complexity:

- Frontend: medium. Needs visual selection affordances, component-instance inspector, diff/proposal UI for prop/children changes, and preview QA.
- Backend: medium. Extends existing AI proposal validation for component prop patches and primitive insertion.
- Runtime: low to medium. Reuses MDX serialization and host-rendered previews.
- Developer tooling: medium. Needs good component metadata extraction and docs for "make this editable" patterns.

### Production-ready

Scope:

- Robust component catalog preparation and validation.
- Primitive library with responsive props, token integration, and accessibility constraints.
- Visual selection mapping between TipTap node views and rendered previews.
- Screenshot/regression checks for AI proposals.
- Good conflict handling, audit events, permissions, and undo.
- Documentation for component authors.

Effort: 4-8 weeks after the MVP.

Complexity:

- Frontend: high.
- Backend: medium to high.
- Runtime: medium.
- Developer tooling: high.

### Scalable architecture

Scope:

- Design-token registry.
- Component versioning and migration for changed prop contracts.
- Optional PR-generation workflow for source changes.
- Optional sandboxed raw HTML prototype lane.
- Cross-framework host bridge contracts if Studio expands beyond React consumers.

Effort: 2-4 months depending on PR automation, primitive breadth, and how far composition/children editing goes.

Complexity:

- Frontend: high.
- Backend/infra: medium to high.
- Runtime: medium if primitives remain MDX; very high if runtime UI trees are introduced.
- Developer tooling: high.

## Final Recommendation

MDCMS should not implement Builder.io-style runtime editing for existing arbitrary React components.

The architecture that aligns with MDCMS is:

1. Keep components in code.
2. Make component instances editable only through registered, typed, serializable public contracts.
3. Add a small, deliberate primitive layout library for document-owned composition.
4. Let AI propose structured document/MDX/prop operations through SPEC-014.
5. Use host-rendered previews through SPEC-006/SPEC-007 for visual feedback.
6. Route component-internal or app-layout changes to source-code patches/PRs.

What MVP should look like:

- "AI edit this section" works on an MDX component node or primitive subtree.
- The assistant can say "center this hero" only if the selected node exposes an alignment prop or layout primitive.
- The assistant can propose missing editable props instead of faking them with CSS selectors.
- The proposal diff is structural: prop changes, inserted MDX, removed child nodes, or document body changes.
- Apply is draft-only and schema/MDX validated.

What to explicitly avoid:

- Persisted DOM selector patches as document state.
- AI-generated JavaScript in production documents.
- Arbitrary inline CSS as the main styling model.
- React Fiber inspection or monkey patching.
- A generic JSON page renderer that duplicates the React app's component model.
- Making CSS class names part of the CMS public contract unless deliberately designed as stable tokens.

Likely technical debt:

- Starting with raw HTML snippets and later trying to make them maintainable.
- Letting AI write one-off style overrides for code-owned components.
- Adding "just one" DOM patch layer for visual changes.
- Treating responsive behavior as free-form CSS instead of component/primitive props.
- Exposing every component prop without a design-system policy.

Best answer to the core question:

AI-driven visual editing of existing React/UI components is realistic for MDCMS only when "existing component" means "an editable instance of a registered component inside document-owned MDX." It is not realistic, in a durable developer-first CMS, to let AI visually rewrite arbitrary rendered React output at runtime without either editing source code or adopting a runtime UI-tree renderer.

## Sources

- Builder.io, [How Builder Works: A Technical Overview](https://www.builder.io/c/docs/how-builder-works-technical/)
- Builder.io, [Using the Content Component](https://www.builder.io/c/docs/content-component)
- Builder.io, [Using BuilderComponent](https://site.builder.io/c/docs/buildercomponent)
- Builder.io, [Write API](https://www.builder.io/c/docs/write-api)
- Builder.io, [Registering Custom Components](https://www.builder.io/c/docs/custom-components-setup)
- Builder.io, [Insert tab](https://www.builder.io/c/docs/insert-tab)
- Builder.io, [Types of reusable blocks](https://www.builder.io/c/docs/reusing-blocks)
- Builder.io, [Templates](https://www.builder.io/c/docs/templates)
- Builder.io, [Make a Symbol](https://www.builder.io/c/docs/make-a-symbol)
- Builder.io, [Symbols with children](https://www.builder.io/c/docs/symbols-with-blocks)
- Builder.io, [Child blocks in custom components](https://www.builder.io/c/docs/custom-components-children)
- Builder.io, [SDK Comparison](https://site.builder.io/c/docs/sdk-comparison)
- Builder.io, [Generate Code](https://site.builder.io/c/docs/generate-code)
- Optimizely, [Original Visual Editor](https://support.optimizely.com/hc/en-us/articles/4410283584525-Original-Visual-Editor)
- Optimizely, [Custom code](https://support.optimizely.com/hc/en-us/articles/4410283401997-Custom-code)
- Optimizely, [Default change order](https://support.optimizely.com/hc/en-us/articles/39076339248781-Default-change-order)
- Optimizely, [Dynamic websites](https://docs.developers.optimizely.com/web-experimentation/docs/dynamic-websites)
- Optimizely, [Target dynamic selectors](https://support.optimizely.com/hc/en-us/articles/4410283960717)
- VWO, [Working with Element Selector Paths](https://help.vwo.com/hc/en-us/articles/900003793166-Working-with-Element-s-Selector-Paths-While-Making-Changes-Using-VWO-s-Visual-Editor)
- VWO, [Using Code Blocks to Create Variations](https://help.vwo.com/hc/en-us/articles/32240535491225-Using-Code-Blocks-to-Create-Variations-in-VWO)
- VWO, [Best Practices for Using Custom Code](https://help.vwo.com/hc/en-us/articles/900007152543-Best-Practices-for-Using-Custom-Code-in-VWO)
- VWO, [Create AI-Powered Variations](https://help.vwo.com/hc/en-us/articles/47838266151449-Create-AI-Powered-Variations-in-A-B-Tests-using-VWO-Editor-Copilot)
- Adobe Target, [Visual Experience Composer modifications](https://experienceleague.adobe.com/en/docs/target/using/experiences/vec/modifications/vec-code-editor)
- Convert, [The Visual Editor in Convert Experiences](https://support.convert.com/hc/en-us/articles/360001098232-The-Visual-Editor-in-Convert-Experiences)
- Mutiny, [How the client code works](https://help.mutinyhq.com/hc/en-us/articles/22091848557339-How-the-client-code-works)
- Mutiny, [Mutiny and Content Security Policies](https://help.mutinyhq.com/hc/en-us/articles/32837958565787-Mutiny-and-Content-Security-Policies)
- GrowthBook, [Visual Editor docs](https://docs.growthbook.io/app/visual)
- GrowthBook, [Visual Editor 2.0](https://www.growthbook.io/blog/visual-editor)
- GrowthBook, [Better visual editor experiments](https://www.growthbook.io/blog/better-visual-editor-experiments)
- GrowthBook, [dom-mutator](https://growthbook.github.io/dom-mutator/)
- LaunchDarkly, [Experimentation](https://launchdarkly.com/docs/home/experimentation)
- PostHog, [Feature flags](https://posthog.com/docs/feature-flags)
- PostHog, [Experiments](https://posthog.com/docs/experiments)
- PostHog, [React SDK](https://posthog.com/docs/libraries/react)
- Google, [Optimize product overview](https://services.google.com/fh/files/misc/optimize_product_overview.pdf)
- Replit, [Visual Editor](https://replit.mintlify.app/replitai/visual-editor)
- Replit, [Agent](https://docs.replit.com/core-concepts/agent)
- Lovable, [GitHub integration](https://docs.lovable.dev/integrations/github)
- shadcn/ui, [Open in v0](https://ui.shadcn.com/docs/v0)
- Webflow, [Code Components](https://developers.webflow.com/code-components/introduction)
- Webflow, [Props and slots](https://developers.webflow.com/devlink/docs/component-export/design-guidelines/props-slots)
- Wix, [About AI Assistants](https://dev.wix.com/docs/develop-websites-sdk/code-your-site/developer-environments/ai-assistants/about-ai-assistants)
- Wix, [About the Wix IDE](https://dev.wix.com/docs/develop-websites-sdk/code-your-site/developer-environments/ides/wix-ide/about-the-wix-ide)
- React, [hydrateRoot](https://react.dev/reference/react-dom/client/hydrateRoot)
- MDN, [`iframe` sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#sandbox)
- MDN, [Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP)
- OWASP, [Cross Site Scripting](https://owasp.org/www-community/attacks/xss/)
