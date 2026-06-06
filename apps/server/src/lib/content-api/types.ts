import type {
  ContentBulkAction as SharedContentBulkAction,
  ContentBulkOperationInput as SharedContentBulkOperationInput,
  ContentBulkOperationItemError as SharedContentBulkOperationItemError,
  ContentBulkOperationResponse as SharedContentBulkOperationResponse,
  ContentBulkOperationResult as SharedContentBulkOperationResult,
  ContentDocumentResponse,
  ContentOverviewCountsResponse,
  ContentVersionDocumentResponse,
  ContentVersionSummaryResponse,
  SchemaRegistryTypeSnapshot,
  TranslationVariantSummary,
} from "@mdcms/shared";
import type {
  AuthorizationRequirement,
  AuthorizedActor,
  AuthorizedRequest,
} from "../auth.js";
import type { DrizzleDatabase } from "../db.js";
import { z } from "zod";

export const SortFieldSchema = z.enum(["createdAt", "updatedAt", "path"]);
export const SortOrderSchema = z.enum(["asc", "desc"]);
export const ContentFormatSchema = z.enum(["md", "mdx"]);
export const RestoreTargetStatusSchema = z.enum(["draft", "published"]);
export const ContentListGroupBySchema = z.enum(["translationGroup"]);

export const JsonObjectSchema = z
  .record(z.string(), z.unknown())
  .refine((v) => !Array.isArray(v), { message: "must be an object" });

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const DEFAULT_ACTOR = "00000000-0000-0000-0000-000000000001";

export type SortField = z.infer<typeof SortFieldSchema>;
export type SortOrder = z.infer<typeof SortOrderSchema>;
export type ContentFormat = z.infer<typeof ContentFormatSchema>;
export type RestoreTargetStatus = z.infer<typeof RestoreTargetStatusSchema>;
export type ContentListGroupBy = z.infer<typeof ContentListGroupBySchema>;

export type ContentScope = {
  project: string;
  environment: string;
};

export type ContentWriteSchemaSyncState = {
  schemaHash: string;
};

export type ContentDocument = ContentDocumentResponse;

export type ContentBulkAction = SharedContentBulkAction;

export type ContentBulkOperationInput = SharedContentBulkOperationInput;

export type ContentBulkOperationItemError = SharedContentBulkOperationItemError;

export type ContentBulkOperationResult = SharedContentBulkOperationResult;

export type ContentBulkOperationResponse = SharedContentBulkOperationResponse;

export type ContentVersionSummary = ContentVersionSummaryResponse;

export type ContentVersionDocument = ContentVersionDocumentResponse;

export type ContentPublishedSnapshot = {
  version: number;
  path: string;
  type: string;
  locale: string;
  format: ContentFormat;
  frontmatter: Record<string, unknown>;
  body: string;
  publishedAt: string;
  publishedBy: string;
  changeSummary?: string;
};

export type ContentWriteOperationOptions = {
  // Route-owned request metadata for CMS-29. HTTP content writes must pass the
  // header-derived hash once the route gate succeeds; non-HTTP direct store
  // callers may omit it.
  expectedSchemaHash?: string;
  expectedDraftRevision?: number;
};

export type ContentListQuery = {
  type?: string;
  path?: string;
  locale?: string;
  slug?: string;
  published?: string;
  isDeleted?: string;
  hasUnpublishedChanges?: string;
  draft?: string;
  resolve?: string | string[];
  project?: string;
  environment?: string;
  limit?: string;
  offset?: string;
  sort?: string;
  order?: string;
  q?: string;
  groupBy?: string;
};

export type ContentVariantSummary = TranslationVariantSummary;

export function sortVariantSummaries(
  variants: ContentVariantSummary[],
): ContentVariantSummary[] {
  return variants.sort((a, b) =>
    a.locale < b.locale
      ? -1
      : a.locale > b.locale
        ? 1
        : a.documentId < b.documentId
          ? -1
          : a.documentId > b.documentId
            ? 1
            : 0,
  );
}

export type ContentWritePayload = {
  path?: string;
  type?: string;
  locale?: string;
  format?: string;
  frontmatter?: Record<string, unknown>;
  body?: string;
  // When provided on create, the new document becomes a locale variant
  // in the source document's translation group.
  sourceDocumentId?: string;
  createdBy?: string;
  updatedBy?: string;
  draftRevision?: number;
  publishedVersion?: number | null;
};

export type ContentPublishPayload = {
  changeSummary?: unknown;
  change_summary?: unknown;
  actorId?: unknown;
};

export type ContentRestoreVersionPayload = ContentPublishPayload & {
  targetStatus?: unknown;
};

export type ContentRouteApp = {
  get?: (path: string, handler: (ctx: any) => unknown) => ContentRouteApp;
  post?: (path: string, handler: (ctx: any) => unknown) => ContentRouteApp;
  put?: (path: string, handler: (ctx: any) => unknown) => ContentRouteApp;
  delete?: (path: string, handler: (ctx: any) => unknown) => ContentRouteApp;
};

export type ContentListResult<Row> = {
  rows: Row[];
  total: number;
  limit: number;
  offset: number;
};

export type ContentOverviewCounts = ContentOverviewCountsResponse;

export type ContentStore = {
  getSchema: (
    scope: ContentScope,
    type: string,
  ) => Promise<SchemaRegistryTypeSnapshot | undefined>;
  create: (
    scope: ContentScope,
    payload: ContentWritePayload,
    options?: ContentWriteOperationOptions,
  ) => Promise<ContentDocument>;
  list: (
    scope: ContentScope,
    query: ContentListQuery,
  ) => Promise<ContentListResult<ContentDocument>>;
  getOverviewCounts: (
    scope: ContentScope,
    input: { types: string[] },
  ) => Promise<ContentOverviewCounts[]>;
  getById: (
    scope: ContentScope,
    documentId: string,
    options?: { draft?: boolean },
  ) => Promise<ContentDocument | undefined>;
  update: (
    scope: ContentScope,
    documentId: string,
    payload: ContentWritePayload,
    options?: ContentWriteOperationOptions,
  ) => Promise<ContentDocument>;
  softDelete: (
    scope: ContentScope,
    documentId: string,
  ) => Promise<ContentDocument>;
  restore: (
    scope: ContentScope,
    documentId: string,
  ) => Promise<ContentDocument>;
  listVersions: (
    scope: ContentScope,
    documentId: string,
    query: ContentListQuery,
  ) => Promise<ContentListResult<ContentVersionSummary>>;
  getVersion: (
    scope: ContentScope,
    documentId: string,
    version: number,
  ) => Promise<ContentVersionDocument>;
  restoreVersion: (
    scope: ContentScope,
    documentId: string,
    version: number,
    input: {
      targetStatus: RestoreTargetStatus;
      changeSummary?: string;
      actorId?: string;
    },
  ) => Promise<ContentDocument>;
  publish: (
    scope: ContentScope,
    documentId: string,
    input: {
      changeSummary?: string;
      actorId?: string;
    },
  ) => Promise<ContentDocument>;
  unpublish: (
    scope: ContentScope,
    documentId: string,
    input: {
      actorId?: string;
    },
  ) => Promise<ContentDocument>;
  listVariants: (
    scope: ContentScope,
    documentId: string,
  ) => Promise<ContentVariantSummary[] | undefined>;
};

export type CreateDatabaseContentStoreOptions = {
  db: DrizzleDatabase;
};

export type InMemoryContentSchemaScope = {
  project: string;
  environment: string;
  schemas: Record<string, SchemaRegistryTypeSnapshot>;
  locales?: {
    default?: string;
    supported?: string[];
  };
};

export type CreateInMemoryContentStoreOptions = {
  schemaScopes?: InMemoryContentSchemaScope[];
};

export type ContentRequestAuthorizer = (
  request: Request,
  requirement: AuthorizationRequirement,
) => Promise<AuthorizedRequest>;

export type ContentRequestCsrfProtector = (request: Request) => Promise<void>;

export type ContentWriteSchemaSyncLookup = (
  scope: ContentScope,
) => Promise<ContentWriteSchemaSyncState | undefined>;

export type ContentUserSummaryLookup = (
  userIds: string[],
) => Promise<Record<string, { name: string; email: string }>>;

export const CONTENT_LIFECYCLE_EVENTS = [
  "content.created",
  "content.updated",
  "content.published",
  "content.unpublished",
  "content.deleted",
  "content.restored",
] as const;

export type ContentLifecycleEvent = (typeof CONTENT_LIFECYCLE_EVENTS)[number];

export type ContentLifecycleActor = AuthorizedActor;

export type ContentLifecycleEventSink = {
  emitContentEvent: (input: {
    event: ContentLifecycleEvent;
    scope: ContentScope;
    document: ContentDocument;
    actor: ContentLifecycleActor;
  }) => Promise<void>;
};

export type MountContentApiRoutesOptions = {
  store: ContentStore;
  authorize: ContentRequestAuthorizer;
  requireCsrf: ContentRequestCsrfProtector;
  getWriteSchemaSyncState: ContentWriteSchemaSyncLookup;
  resolveUsers?: ContentUserSummaryLookup;
  lifecycleEvents?: ContentLifecycleEventSink;
  previewTokenSecret?: string;
  previewTokenTtlSeconds?: number;
};
