import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  createInMemoryContentStore,
  toPublishedReadDocument,
} from "./in-memory-store.js";
import type { ContentWriteAttribution } from "@mdcms/shared";

test("store preserves creator and records each mutation actor and origin", async () => {
  const scope = { project: "attribution", environment: "production" };
  const store = createInMemoryContentStore({
    schemaScopes: [
      {
        ...scope,
        schemas: {
          Note: {
            type: "Note",
            directory: "notes",
            localized: false,
            fields: {},
          },
        },
      },
    ],
  });
  const creator: ContentWriteAttribution = {
    actorId: "user_creator",
    origin: { channel: "studio", credential: "session" },
  };
  const writer: ContentWriteAttribution = {
    actorId: "user_writer",
    origin: { channel: "api", credential: "api_key", apiKeyId: "key-1" },
  };
  const created = await store.create(
    scope,
    {
      type: "Note",
      path: "notes/test",
      locale: "en",
      format: "md",
      frontmatter: {},
      body: "first",
    },
    { attribution: creator },
  );
  assert.equal(created.createdBy, creator.actorId);
  assert.deepEqual(created.createdOrigin, creator.origin);
  const updated = await store.update(
    scope,
    created.documentId,
    { body: "second" },
    { attribution: writer },
  );
  assert.equal(updated.createdBy, creator.actorId);
  assert.equal(updated.updatedBy, writer.actorId);
  assert.deepEqual(updated.updatedOrigin, writer.origin);
  await store.publish(scope, created.documentId, { attribution: writer });
  const versions = await store.listVersions(scope, created.documentId, {});
  assert.equal(versions.rows[0]?.publishedBy, writer.actorId);
  assert.deepEqual(versions.rows[0]?.publishedOrigin, writer.origin);
  for (const mutate of [
    () => store.unpublish(scope, created.documentId, { attribution: creator }),
    () => store.softDelete(scope, created.documentId, { attribution: creator }),
    () => store.restore(scope, created.documentId, { attribution: creator }),
    () =>
      store.restoreVersion(scope, created.documentId, 1, {
        targetStatus: "draft",
        attribution: creator,
      }),
  ]) {
    const document = await mutate();
    assert.equal(document.updatedBy, creator.actorId);
    assert.deepEqual(document.updatedOrigin, creator.origin);
  }
});

test("published memory reads keep publication attribution after a different user edits the draft", async () => {
  const scope = { project: "published-attribution", environment: "production" };
  const store = createInMemoryContentStore({
    schemaScopes: [
      {
        ...scope,
        schemas: {
          Note: {
            type: "Note",
            directory: "notes",
            localized: false,
            fields: {},
          },
        },
      },
    ],
  });
  const publisher: ContentWriteAttribution = {
    actorId: "publisher",
    origin: { channel: "studio", credential: "session" },
  };
  const editor: ContentWriteAttribution = {
    actorId: "draft-editor",
    origin: { channel: "api", credential: "api_key", apiKeyId: "key-editor" },
  };
  const created = await store.create(
    scope,
    {
      type: "Note",
      path: "notes/attribution",
      locale: "en",
      format: "md",
      body: "Published body",
      frontmatter: {},
    },
    { attribution: publisher },
  );
  await store.publish(scope, created.documentId, { attribution: publisher });
  const version = await store.getVersion(scope, created.documentId, 1);
  const draft = await store.update(
    scope,
    created.documentId,
    { body: "Draft body" },
    { attribution: editor },
  );
  const published = await store.getById(scope, created.documentId);
  const listed = (await store.list(scope, {})).rows[0];
  for (const visible of [published, listed]) {
    assert.equal(visible?.body, "Published body");
    assert.equal(visible?.updatedBy, publisher.actorId);
    assert.deepEqual(visible?.updatedOrigin, publisher.origin);
  }
  assert.equal(draft.updatedBy, editor.actorId);
  assert.deepEqual(draft.updatedOrigin, editor.origin);
  // Legacy snapshots predate origins, while their current draft can have one.
  const { publishedOrigin: _origin, ...legacyVersion } = version;
  const legacyVisible = toPublishedReadDocument(draft, legacyVersion);
  assert.equal(legacyVisible.updatedBy, publisher.actorId);
  assert.equal("updatedOrigin" in legacyVisible, false);
});
