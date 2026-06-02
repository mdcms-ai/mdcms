type PreviewRouteDocument = {
  type: string;
  path: string;
  frontmatter: Record<string, unknown>;
};

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

function getPagePreviewPath(documentPath: string): string | undefined {
  const normalizedPath = documentPath.replace(/\.(md|mdx)$/i, "");
  const relativePath = normalizedPath.startsWith("content/pages/")
    ? normalizedPath.slice("content/pages/".length)
    : normalizedPath.startsWith("pages/")
      ? normalizedPath.slice("pages/".length)
      : normalizedPath;

  return relativePath.trim().length > 0
    ? `/preview/page/${encodePathSegments(relativePath)}?preview=true`
    : undefined;
}

export function getPreviewHrefForDocument(
  document: PreviewRouteDocument,
): string | undefined {
  if (document.type === "post") {
    const slug = getString(document.frontmatter.slug);

    return slug
      ? `/preview/post/${encodeURIComponent(slug)}?preview=true`
      : undefined;
  }

  if (document.type === "page") {
    return getPagePreviewPath(document.path);
  }

  return undefined;
}
