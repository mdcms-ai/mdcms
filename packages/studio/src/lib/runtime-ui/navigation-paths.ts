export function isExternalHref(href: string): boolean {
  return /^(https?:)?\/\//.test(href) || href.startsWith("mailto:");
}

function normalizeBasePath(path: string | undefined): string {
  if (!path) {
    return "";
  }

  const trimmed = path.trim();

  if (trimmed.length === 0 || trimmed === "/") {
    return "";
  }

  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function normalizeInternalHref(path: string): string {
  const trimmed = path.trim();

  if (trimmed.length === 0 || trimmed === "/") {
    return "/";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function resolveStudioRootedAdminHref(
  basePath: string,
  href: string,
): string | undefined {
  if (!basePath.endsWith("/admin")) {
    return undefined;
  }

  if (href === "/admin") {
    return basePath;
  }

  if (!href.startsWith("/admin/")) {
    return undefined;
  }

  return `${basePath}${href.slice("/admin".length)}`;
}

export function resolveStudioHref(
  basePath: string | undefined,
  href: string,
): string {
  if (isExternalHref(href)) {
    return href;
  }

  const normalizedBasePath = normalizeBasePath(basePath);
  const normalizedHref = normalizeInternalHref(href);

  if (normalizedBasePath.length === 0) {
    return normalizedHref;
  }

  if (
    normalizedHref === normalizedBasePath ||
    normalizedHref.startsWith(`${normalizedBasePath}/`)
  ) {
    return normalizedHref;
  }

  const studioRootedHref = resolveStudioRootedAdminHref(
    normalizedBasePath,
    normalizedHref,
  );

  if (studioRootedHref) {
    return studioRootedHref;
  }

  if (normalizedHref === "/") {
    return normalizedBasePath;
  }

  return `${normalizedBasePath}${normalizedHref}`;
}
