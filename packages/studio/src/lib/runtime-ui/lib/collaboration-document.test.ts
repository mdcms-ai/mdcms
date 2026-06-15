import assert from "node:assert/strict";
import { test } from "bun:test";
import * as decoding from "lib0/decoding.js";
import * as encoding from "lib0/encoding.js";
import * as syncProtocol from "y-protocols/sync.js";
import * as Y from "yjs";

import {
  COLLABORATION_DOCUMENT_FIELD_NAME,
  createCollaborationDocumentConnectionKey,
  createCollaborationDocumentName,
  createDocumentCollaborationWebSocketUrl,
  encodeCollaborationAuthMessage,
  encodeCollaborationSyncStep1Message,
  handleCollaborationSyncMessage,
} from "./collaboration-document.js";

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_NAME = "marketing:draft:11111111-1111-4111-8111-111111111111";

test("createDocumentCollaborationWebSocketUrl targets the SPEC-007 document room endpoint", () => {
  assert.equal(
    createDocumentCollaborationWebSocketUrl({
      serverUrl: "http://localhost:4000",
      project: "marketing",
      environment: "draft",
      documentId: DOCUMENT_ID,
    }),
    `ws://localhost:4000/api/v1/collaboration?project=marketing&environment=draft&documentId=${DOCUMENT_ID}`,
  );

  assert.equal(
    createDocumentCollaborationWebSocketUrl({
      serverUrl: "https://cms.example.com/api",
      project: "marketing site",
      environment: "preview/draft",
      documentId: DOCUMENT_ID,
    }),
    `wss://cms.example.com/api/api/v1/collaboration?project=marketing+site&environment=preview%2Fdraft&documentId=${DOCUMENT_ID}`,
  );
});

test("createCollaborationDocumentName and connection key are stable per routed document room", () => {
  const documentName = createCollaborationDocumentName({
    project: "marketing",
    environment: "draft",
    documentId: DOCUMENT_ID,
  });

  assert.equal(documentName, DOCUMENT_NAME);
  assert.equal(
    createCollaborationDocumentConnectionKey({
      webSocketUrl: "ws://localhost:4000/api/v1/collaboration",
      documentName,
    }),
    `ws://localhost:4000/api/v1/collaboration\u0000${DOCUMENT_NAME}`,
  );
});

test("encodeCollaborationAuthMessage matches Hocuspocus token auth framing", () => {
  const message = encodeCollaborationAuthMessage(DOCUMENT_NAME);
  const decoder = decoding.createDecoder(message);

  assert.equal(decoding.readVarString(decoder), DOCUMENT_NAME);
  assert.equal(decoding.readVarUint(decoder), 2);
  assert.equal(decoding.readVarUint(decoder), 0);
  assert.equal(decoding.readVarString(decoder), "");
});

test("handleCollaborationSyncMessage applies incoming sync and sends required replies", () => {
  const localDoc = new Y.Doc();
  const remoteDoc = new Y.Doc();
  const remoteText = remoteDoc.getXmlFragment(
    COLLABORATION_DOCUMENT_FIELD_NAME,
  );
  remoteText.insert(0, [new Y.XmlText("Shared body")]);

  const incoming = encoding.createEncoder();
  encoding.writeVarString(incoming, DOCUMENT_NAME);
  encoding.writeVarUint(incoming, 0);
  syncProtocol.writeSyncStep1(incoming, remoteDoc);

  const replies: Uint8Array[] = [];
  const result = handleCollaborationSyncMessage({
    documentName: DOCUMENT_NAME,
    document: localDoc,
    data: encoding.toUint8Array(incoming),
    send: (reply) => replies.push(reply),
  });

  assert.equal(result.type, "sync");
  assert.equal(replies.length, 1);

  const localSyncStep1 = encodeCollaborationSyncStep1Message(
    DOCUMENT_NAME,
    localDoc,
  );
  const decodedLocalStep = decoding.createDecoder(localSyncStep1);
  assert.equal(decoding.readVarString(decodedLocalStep), DOCUMENT_NAME);
  assert.equal(decoding.readVarUint(decodedLocalStep), 0);
});
