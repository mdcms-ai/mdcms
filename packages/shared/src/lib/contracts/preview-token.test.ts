import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MDCMS_PREVIEW_TOKEN_AUDIENCE,
  MDCMS_PREVIEW_TOKEN_ISSUER,
  MDCMS_PREVIEW_TOKEN_QUERY_PARAM,
  appendMdcmsPreviewTokenToUrl,
  readMdcmsPreviewTokenFromUrl,
  signMdcmsPreviewToken,
  verifyMdcmsPreviewToken,
  type MdcmsPreviewTokenMintClaims,
} from "./preview-token.js";

function makeClaims(
  overrides: Partial<MdcmsPreviewTokenMintClaims> = {},
): MdcmsPreviewTokenMintClaims {
  return {
    project: "marketing-site",
    environment: "staging",
    documentId: "doc-123",
    type: "post",
    path: "content/posts/hello.md",
    locale: "en",
    draftRevision: 7,
    previewUrl: "/preview/post/hello?preview=true",
    ...overrides,
  };
}

test("signMdcmsPreviewToken and verifyMdcmsPreviewToken round-trip document claims", async () => {
  const { token, expiresAt } = await signMdcmsPreviewToken({
    secret: "test-preview-secret",
    claims: makeClaims({ documentId: "doc-1", draftRevision: 7 }),
    now: new Date("2026-06-02T10:00:00.000Z"),
    ttlSeconds: 300,
  });

  assert.equal(expiresAt, "2026-06-02T10:05:00.000Z");

  const result = await verifyMdcmsPreviewToken(token, {
    secret: "test-preview-secret",
    now: new Date("2026-06-02T10:01:00.000Z"),
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.claims.iss, MDCMS_PREVIEW_TOKEN_ISSUER);
    assert.equal(result.claims.aud, MDCMS_PREVIEW_TOKEN_AUDIENCE);
    assert.equal(result.claims.sub, "doc-1");
    assert.equal(result.claims.documentId, "doc-1");
    assert.equal(result.claims.project, "marketing-site");
    assert.equal(result.claims.environment, "staging");
    assert.equal(result.claims.locale, "en");
    assert.equal(result.claims.draftRevision, 7);
    assert.equal(result.claims.previewUrl, "/preview/post/hello?preview=true");
  }
});

test("verifyMdcmsPreviewToken rejects expired tokens", async () => {
  const { token } = await signMdcmsPreviewToken({
    secret: "test-preview-secret",
    claims: makeClaims(),
    now: new Date("2026-06-02T10:00:00.000Z"),
    ttlSeconds: 60,
  });

  const result = await verifyMdcmsPreviewToken(token, {
    secret: "test-preview-secret",
    now: new Date("2026-06-02T10:02:00.000Z"),
  });

  assert.deepEqual(result, { ok: false, reason: "expired" });
});

test("verifyMdcmsPreviewToken rejects malformed and wrong-signature tokens", async () => {
  assert.deepEqual(
    await verifyMdcmsPreviewToken("not-a-jwt", {
      secret: "test-preview-secret",
    }),
    { ok: false, reason: "malformed" },
  );

  const { token } = await signMdcmsPreviewToken({
    secret: "test-preview-secret",
    claims: makeClaims(),
    now: new Date("2026-06-02T10:00:00.000Z"),
    ttlSeconds: 300,
  });

  assert.deepEqual(
    await verifyMdcmsPreviewToken(token, {
      secret: "different-secret",
      now: new Date("2026-06-02T10:01:00.000Z"),
    }),
    { ok: false, reason: "invalid_signature" },
  );
});

test("verifyMdcmsPreviewToken rejects invalid issuer, audience, and expected claims", async () => {
  const { token: wrongIssuerToken } = await signMdcmsPreviewToken({
    secret: "test-preview-secret",
    claims: makeClaims(),
    issuer: "other",
    now: new Date("2026-06-02T10:00:00.000Z"),
    ttlSeconds: 300,
  });

  assert.deepEqual(
    await verifyMdcmsPreviewToken(wrongIssuerToken, {
      secret: "test-preview-secret",
      now: new Date("2026-06-02T10:01:00.000Z"),
    }),
    { ok: false, reason: "invalid_claim" },
  );

  const { token: wrongAudienceToken } = await signMdcmsPreviewToken({
    secret: "test-preview-secret",
    claims: makeClaims(),
    audience: "other",
    now: new Date("2026-06-02T10:00:00.000Z"),
    ttlSeconds: 300,
  });

  assert.deepEqual(
    await verifyMdcmsPreviewToken(wrongAudienceToken, {
      secret: "test-preview-secret",
      now: new Date("2026-06-02T10:01:00.000Z"),
    }),
    { ok: false, reason: "invalid_claim" },
  );

  const { token } = await signMdcmsPreviewToken({
    secret: "test-preview-secret",
    claims: makeClaims({ documentId: "doc-expected" }),
    now: new Date("2026-06-02T10:00:00.000Z"),
    ttlSeconds: 300,
  });

  assert.deepEqual(
    await verifyMdcmsPreviewToken(token, {
      secret: "test-preview-secret",
      now: new Date("2026-06-02T10:01:00.000Z"),
      expected: {
        documentId: "doc-other",
      },
    }),
    { ok: false, reason: "invalid_claim" },
  );
});

test("preview token URL helpers preserve existing query parameters", () => {
  assert.equal(
    appendMdcmsPreviewTokenToUrl(
      "/preview/post/hello?preview=true",
      "token-value",
    ),
    "/preview/post/hello?preview=true&mdcms_preview_token=token-value",
  );

  assert.equal(
    appendMdcmsPreviewTokenToUrl("https://site.test/blog/hello", "token-value"),
    "https://site.test/blog/hello?mdcms_preview_token=token-value",
  );

  const url = new URL(
    `https://site.test/blog?${MDCMS_PREVIEW_TOKEN_QUERY_PARAM}=token-value`,
  );
  assert.equal(readMdcmsPreviewTokenFromUrl(url), "token-value");
  assert.equal(
    readMdcmsPreviewTokenFromUrl(new URL("https://site.test/blog")),
    undefined,
  );
});
