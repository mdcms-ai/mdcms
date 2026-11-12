import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  createClient,
  type ApiPaginatedEnvelope,
  type ContentDocumentResponse,
} from "./index.js";

const document: ContentDocumentResponse = {
  documentId: "11111111-1111-4111-8111-111111111111",
  translationGroupId: "22222222-2222-4222-8222-222222222222",
  project: "marketing-site",
  environment: "production",
  path: "content/posts/hello-world",
  type: "post",
  locale: "en",
  format: "md",
  isDeleted: false,
  hasUnpublishedChanges: false,
  version: 1,
  publishedVersion: 1,
  draftRevision: 1,
  frontmatter: { title: "Hello", slug: "hello-world" },
  body: "Hello",
  createdBy: "user",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedBy: "user",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("the package root exports the document response types used by the client", async () => {
  const response: ApiPaginatedEnvelope<ContentDocumentResponse> = {
    data: [document],
    pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
  };
  const cms = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "key",
    project: "marketing-site",
    environment: "production",
    fetch: (async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  });

  const listed: ApiPaginatedEnvelope<ContentDocumentResponse> =
    await cms.list("post");

  assert.deepEqual(listed, response);
});
