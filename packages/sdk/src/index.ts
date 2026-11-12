export * from "./lib/sdk.js";

// Response types used by the client's public signatures, so apps can type
// documents without adding @mdcms/shared as a dependency.
export type {
  ApiDataEnvelope,
  ApiPaginatedEnvelope,
  ContentDocumentResponse,
  ContentMediaResolveError,
  ContentReferenceResolveError,
  ContentResolveError,
  MdcmsPreviewTokenClaims,
  MdcmsPreviewTokenExpectedClaims,
  MdcmsPreviewVerificationResult,
  PaginationMetadata,
  ResolveErrorsMap,
} from "@mdcms/shared";
