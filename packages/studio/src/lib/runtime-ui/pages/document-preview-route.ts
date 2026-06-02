import type { MdcmsPreviewDocument, StudioMountContext } from "@mdcms/shared";

export type DocumentPreviewRouteSource = "config";

export type DocumentPreviewRouteResolution =
  | {
      status: "ready";
      href: string;
      label: string;
      source: DocumentPreviewRouteSource;
    }
  | {
      status: "unavailable";
      reason: "not-configured" | "no-route" | "resolver-error";
      message: string;
    };

export type ResolveDocumentPreviewRouteInput = {
  document: MdcmsPreviewDocument;
  preview?: StudioMountContext["preview"];
};

function normalizeResolvedPreviewHref(value: unknown): string | undefined {
  const href =
    value instanceof URL
      ? value.href
      : typeof value === "string"
        ? value.trim()
        : "";

  return href.length > 0 ? href : undefined;
}

export function resolveDocumentPreviewRoute(
  input: ResolveDocumentPreviewRouteInput,
): DocumentPreviewRouteResolution {
  const contentType = input.document.type;

  if (!input.preview) {
    return {
      status: "unavailable",
      reason: "not-configured",
      message: `Live preview is not configured for content type "${contentType}". Add resolvePreviewUrl to this content type in mdcms.config.ts to enable route preview.`,
    };
  }

  if (input.preview.hasPreviewUrlResolver?.(contentType) === false) {
    return {
      status: "unavailable",
      reason: "not-configured",
      message: `Live preview is not configured for content type "${contentType}". Add resolvePreviewUrl to this content type in mdcms.config.ts to enable route preview.`,
    };
  }

  let resolvedHref: unknown;

  try {
    resolvedHref = input.preview.resolvePreviewUrl(input.document);
  } catch {
    return {
      status: "unavailable",
      reason: "resolver-error",
      message: `resolvePreviewUrl failed for content type "${contentType}". Check mdcms.config.ts.`,
    };
  }

  const href = normalizeResolvedPreviewHref(resolvedHref);

  if (!href) {
    return {
      status: "unavailable",
      reason: "no-route",
      message: `resolvePreviewUrl did not return a preview URL for content type "${contentType}". Check mdcms.config.ts and this document's fields.`,
    };
  }

  return {
    status: "ready",
    href,
    label: href,
    source: "config",
  };
}
