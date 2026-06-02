export type DocumentPreviewRouteSource = "explicit" | "post-slug" | "page-path";

export type DocumentPreviewRouteResolution =
  | {
      status: "ready";
      href: string;
      label: string;
      source: DocumentPreviewRouteSource;
    }
  | {
      status: "unavailable";
      reason: "no-route";
      message: string;
    };

type PreviewableDocument = {
  type: string;
  path: string;
  frontmatter: Record<string, unknown>;
};

const PREVIEW_URL_FIELDS = ["previewUrl", "previewHref"] as const;

function encodePathSegments(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeTypeKey(type: string): string {
  return type.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeDocumentPath(path: string): string {
  return path.replace(/\.(md|mdx)$/i, "");
}

function resolveExplicitPreviewUrl(
  frontmatter: Record<string, unknown>,
): string | undefined {
  for (const field of PREVIEW_URL_FIELDS) {
    const value = getString(frontmatter[field]);

    if (value) return value;
  }

  return undefined;
}

function getPagePreviewPath(documentPath: string): string | undefined {
  const normalizedPath = normalizeDocumentPath(documentPath);
  const relativePath = normalizedPath.startsWith("content/pages/")
    ? normalizedPath.slice("content/pages/".length)
    : normalizedPath.startsWith("pages/")
      ? normalizedPath.slice("pages/".length)
      : normalizedPath;

  return relativePath.trim().length > 0
    ? `/preview/page/${encodePathSegments(relativePath)}`
    : undefined;
}

export function resolveDocumentPreviewRoute(
  document: PreviewableDocument,
): DocumentPreviewRouteResolution {
  const explicitUrl = resolveExplicitPreviewUrl(document.frontmatter);

  if (explicitUrl) {
    return {
      status: "ready",
      href: explicitUrl,
      label: explicitUrl,
      source: "explicit",
    };
  }

  const typeKey = normalizeTypeKey(document.type);

  if (typeKey === "post" || typeKey === "blogpost") {
    const slug = getString(document.frontmatter.slug);

    if (slug) {
      const href = `/preview/post/${encodeURIComponent(slug)}`;

      return {
        status: "ready",
        href,
        label: href,
        source: "post-slug",
      };
    }
  }

  if (typeKey === "page") {
    const href = getPagePreviewPath(document.path);

    if (href) {
      return {
        status: "ready",
        href,
        label: href,
        source: "page-path",
      };
    }
  }

  return {
    status: "unavailable",
    reason: "no-route",
    message: "No route configured for this document.",
  };
}
