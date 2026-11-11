import type { AiContentStore } from "@mdcms/modules";
import { RuntimeError } from "@mdcms/shared";
import type { AgentDispatch } from "./dispatcher.js";
import { dispatchJson, validateAgentDocument } from "./content.js";
import {
  documentEnvelopeSchema,
  documentListEnvelopeSchema,
} from "./schema.js";

/** Request-bound adapter. All reads and writes repeat domain-route authorization. */
export function createAssistantContentExecutor(
  dispatch: AgentDispatch,
): AiContentStore {
  const path = (id: string) => `/api/v1/content/${encodeURIComponent(id)}`;
  const getById: AiContentStore["getById"] = async (_scope, id) => {
    try {
      return documentEnvelopeSchema.parse(
        await dispatchJson(dispatch, {
          method: "GET",
          path: path(id),
          query: { draft: "true", fileFields: "raw" },
        }),
      ).data;
    } catch (error) {
      if (!(error instanceof RuntimeError) || error.code !== "NOT_FOUND")
        throw error;
      // The detail route excludes trash; use the authorized trash listing.
      let offset = 0;
      for (;;) {
        const page = documentListEnvelopeSchema.parse(
          await dispatchJson(dispatch, {
            method: "GET",
            path: "/api/v1/content",
            query: {
              draft: "true",
              isDeleted: "true",
              fileFields: "raw",
              limit: "100",
              offset: String(offset),
            },
          }),
        );
        const found = page.data.find((document) => document.documentId === id);
        if (found) return found;
        if (!page.pagination.hasMore) return undefined;
        offset += page.pagination.limit;
      }
    }
  };
  const required = async (scope: Parameters<typeof getById>[0], id: string) => {
    const document = await getById(scope, id);
    if (!document)
      throw new RuntimeError({
        code: "NOT_FOUND",
        message: "Document not found.",
        statusCode: 404,
      });
    return document;
  };
  return {
    getById,
    async create(_scope, payload, options) {
      await validateAgentDocument(
        dispatch,
        {
          type: payload.type,
          frontmatter: payload.frontmatter ?? {},
          body: payload.body ?? "",
          format: payload.format ?? "md",
        },
        options.expectedSchemaHash,
      );
      return documentEnvelopeSchema.parse(
        await dispatchJson(dispatch, {
          method: "POST",
          path: "/api/v1/content",
          schemaHash: options.expectedSchemaHash,
          body: payload,
          query: { fileFields: "raw" },
        }),
      ).data;
    },
    async update(scope, id, payload, options) {
      const current = await required(scope, id);
      await validateAgentDocument(
        dispatch,
        {
          ...current,
          ...payload,
          frontmatter: payload.frontmatter ?? current.frontmatter,
          body: payload.body ?? current.body,
        },
        options.expectedSchemaHash,
      );
      return documentEnvelopeSchema.parse(
        await dispatchJson(dispatch, {
          method: "PUT",
          path: path(id),
          schemaHash: options.expectedSchemaHash,
          body: { ...payload, draftRevision: options.expectedDraftRevision },
          query: { fileFields: "raw" },
        }),
      ).data;
    },
    async softDelete(_scope, id, options) {
      return documentEnvelopeSchema.parse(
        await dispatchJson(dispatch, {
          method: "DELETE",
          path: path(id),
          query: {
            fileFields: "raw",
            ...(options.expectedDraftRevision === undefined
              ? {}
              : {
                  expectedDraftRevision: String(options.expectedDraftRevision),
                }),
          },
        }),
      ).data;
    },
    async restore(scope, id, options) {
      const current = await required(scope, id);
      if (!options.expectedSchemaHash)
        throw new RuntimeError({
          code: "SCHEMA_HASH_REQUIRED",
          message: "Schema hash is required.",
          statusCode: 400,
        });
      await validateAgentDocument(
        dispatch,
        current,
        options.expectedSchemaHash,
      );
      return documentEnvelopeSchema.parse(
        await dispatchJson(dispatch, {
          method: "POST",
          path: `${path(id)}/restore`,
          body: {
            targetStatus: "draft",
            expectedDraftRevision: options.expectedDraftRevision,
          },
          query: { fileFields: "raw" },
        }),
      ).data;
    },
  };
}
