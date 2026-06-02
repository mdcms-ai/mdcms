# CMS-250 Live Preview Token Design

Date: 2026-06-02

## Goal

Extend the Studio real-app preview work so host applications can preview draft
documents through an easy, production-appropriate integration. The integration
must support private draft previews without requiring the host application to
implement MDCMS user authentication, while still allowing projects to make draft
routes public when their content model or risk tolerance permits it.

## Context

The current live preview implementation lets each content type expose a
`resolvePreviewUrl(document)` function in `mdcms.config.ts`. Studio calls that
resolver with the latest persisted draft snapshot and embeds the returned host
route in an iframe.

That solves route mapping, but not the full host integration contract:

- the host route must know when to fetch `draft: true`;
- private draft previews need authorization beyond `?preview=true`;
- preview responses must not reuse published-page static or ISR cache output;
- users need documentation and public skills guidance for wiring the route.

Comparable CMSs generally split these responsibilities. Next.js Draft Mode uses
a CMS-known secret to switch from static published rendering to dynamic draft
rendering. Sanity validates a generated preview secret server-side, sets secure
draft-mode cookies, uses server-only draft read tokens, and disables CDN
caching for preview. Contentful separates published reads from a preview API
using a preview access token. DatoCMS separates a preview-link endpoint from a
draft-mode route. Prismic full-site preview uses a temporary ref stored in a
preview cookie.

## Scope

This design includes:

- a first-class MDCMS preview-token endpoint for Studio;
- a signed short-lived JWT token rather than an opaque token that requires a
  host-to-MDCMS validation call;
- SDK helpers that verify preview requests without exposing JWT details to
  application code;
- guidance for private preview routes and for intentionally public draft
  routes;
- docs and public skill updates that explain draft fetching, cache behavior,
  and route resolution.

This design excludes:

- full host-application user authentication;
- server-side opaque token storage or token introspection;
- shareable no-expiry preview links;
- click-to-edit overlays or real-time postMessage draft injection;
- CDN-specific cache invalidation features beyond no-store/dynamic preview
  guidance.

## Preview Token Contract

Studio resolves the base preview URL with `resolvePreviewUrl(document)`. When
the resolver returns a URL, Studio requests a preview token from MDCMS before
loading the iframe.

Endpoint:

```text
POST /api/v1/content/:documentId/preview-token
```

Authentication:

- `session_or_api_key`
- required scope: `content:read:draft`
- required target routing: `project` and `environment`

Request body:

```ts
type ContentPreviewTokenRequest = {
  previewUrl?: string;
};
```

`previewUrl` is the resolved host URL Studio intends to load. It is optional so
non-URL-bound integrations can still work, but Studio should send it when it
has one.

Success response:

```ts
type ContentPreviewTokenResponse = {
  data: {
    token: string;
    expiresAt: string;
  };
};
```

The token is a signed JWT. The server signs it with a configured preview token
secret and does not persist it. The first implementation should use a short TTL,
for example five minutes.

Token claims:

```ts
type MdcmsPreviewTokenClaims = {
  iss: "mdcms";
  aud: "mdcms-preview";
  sub: string; // documentId
  project: string;
  environment: string;
  documentId: string;
  type: string;
  path: string;
  locale: string;
  draftRevision: number;
  previewUrl?: string;
  iat: number;
  exp: number;
};
```

The claims bind the token to one draft document snapshot and, when available,
one host preview URL. They are intentionally not an API key replacement.

## Studio Flow

1. Studio loads a persisted draft document snapshot.
2. Studio calls `resolvePreviewUrl(document)`.
3. If no resolver exists or no URL is returned, Studio shows the existing
   unavailable guidance.
4. If a URL is returned, Studio calls the preview-token endpoint.
5. Studio appends the token to the preview URL as `mdcms_preview_token` and may
   also add `preview=true` as a human-readable mode flag.
6. Studio loads the resulting URL in the preview iframe.
7. Manual preview refresh first persists unsaved draft changes, then repeats
   token minting and iframe reload against the latest persisted snapshot.

`preview=true` must be treated as a mode indicator only. It is not proof that
the request is authorized to read private draft content.

## SDK Surface

The SDK should expose one-line verification helpers so host applications do not
write their own JWT logic.

Low-level helper:

```ts
const preview = await verifyMdcmsPreviewRequest(request, {
  secret: process.env.MDCMS_PREVIEW_TOKEN_SECRET!,
});
```

It extracts `mdcms_preview_token` from the request URL, verifies signature,
issuer, audience, expiry, and optional expected values, and returns a typed
result.

Suggested result shape:

```ts
type MdcmsPreviewVerificationResult =
  | { ok: true; claims: MdcmsPreviewTokenClaims }
  | {
      ok: false;
      reason:
        | "missing"
        | "malformed"
        | "expired"
        | "invalid_signature"
        | "invalid_claim";
    };
```

High-level helper:

```ts
const document = await cms.getPreviewDocumentFromRequest(request, {
  secret: process.env.MDCMS_PREVIEW_TOKEN_SECRET!,
});
```

This verifies the request and fetches the draft document by `documentId` with
`draft: true`. It remains read-only and fits the `@mdcms/sdk` package boundary.

The helpers should work in common server runtimes used by Next.js, Remix,
Astro, SvelteKit, and plain Node/Bun server handlers.

## Host Route Patterns

Recommended private preview route:

```ts
const preview = await verifyMdcmsPreviewRequest(request, {
  secret: process.env.MDCMS_PREVIEW_TOKEN_SECRET!,
});

if (!preview.ok) {
  return new Response("Preview unavailable", { status: 401 });
}

const document = await cms.get(preview.claims.type, {
  id: preview.claims.documentId,
  locale: preview.claims.locale,
  draft: true,
});
```

The route should render dynamically and avoid published-page caches:

- Next.js App Router: use dynamic rendering and `fetch(..., { cache:
  "no-store" })` or equivalent SDK fetch override.
- Generic HTTP routes: send `Cache-Control: private, no-store`.
- Existing public routes with ISR should branch into an uncached draft path when
  the preview token verifies.

Public draft preview route:

Some projects may intentionally expose drafts, for example for low-sensitivity
content, internal-only deployments, or staged sites protected elsewhere. The
docs should not say this is forbidden. They should say that if unpublished
content must stay private, `draft: true` must be gated by a preview token,
session, or another host-owned protection mechanism.

## Documentation And Skills

Update canonical docs and public skills after the spec is updated:

- `docs/specs/SPEC-003-content-storage-versioning-and-migrations.md`: add the
  preview-token content API endpoint, request/response contract, auth mode,
  scope, target routing, and error codes.
- `docs/specs/SPEC-006-studio-runtime-and-ui.md`: update the real-app preview
  surface flow so token minting is part of loading and refreshing private
  previews.
- Studio docs under `apps/docs`: add a live preview integration guide covering
  `resolvePreviewUrl`, token verification, `draft: true`, and no-store cache
  behavior.
- `apps/studio-example`: convert the preview example from demo-key-only draft
  reads to the preview-token route pattern.
- `skills/mdcms-studio-embed`: add live preview setup steps for
  `resolvePreviewUrl` and private preview routes.
- `skills/mdcms-sdk-integration`: add the SDK preview verification helper,
  public-vs-private draft preview guidance, and cache warnings.
- `skills/mdcms-content-editing`: clarify that draft visibility depends on the
  host application's preview route policy.

## Error Handling

The token endpoint should return deterministic errors:

- `UNAUTHORIZED` (`401`) for missing/invalid session or API key.
- `FORBIDDEN` (`403`) when the caller lacks `content:read:draft`.
- `NOT_FOUND` (`404`) for a missing, deleted, or inaccessible document.
- `INVALID_INPUT` (`400`) for malformed request bodies.
- `PREVIEW_TOKEN_UNAVAILABLE` (`503`) when the server has no preview token
  signing secret configured.

SDK verification errors should avoid leaking secret material. Host examples
should return `401` or a neutral preview-unavailable page for invalid private
preview tokens.

## Testing

Implementation should cover:

- server token minting requires `content:read:draft`;
- token claims include document, project, environment, locale, path,
  `draftRevision`, expiry, and optional preview URL;
- missing preview signing secret returns a deterministic unavailable error;
- SDK helper accepts a valid token and rejects expired, malformed, wrong
  signature, wrong issuer, wrong audience, and mismatched expected-claim tokens;
- high-level SDK helper fetches `draft: true` by verified document id;
- Studio refresh mints a fresh token after saving unsaved draft changes;
- example preview routes use no-store/dynamic draft fetching;
- docs and skills describe both private-preview best practice and intentionally
  public draft preview routes.

## Open Decisions

None. The approved first pass is signed JWT preview tokens with SDK verification
helpers, not opaque token introspection and not host-owned static secrets as the
primary path.
