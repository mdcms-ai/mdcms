import type { StudioMountContext } from "@mdcms/shared";

export type MatchableRoute = {
  id: string;
  path: string;
};

function normalizeBasePath(path: string): string {
  const trimmed = path.trim();

  if (trimmed.length === 0 || trimmed === "/") {
    return "";
  }

  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function normalizeInternalPath(path: string): string {
  const trimmed = path.trim();

  if (trimmed.length === 0 || trimmed === "/") {
    return "/";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function stripStudioBasePath(
  pathname: string,
  basePath: string,
): string {
  const normalizedBasePath = normalizeBasePath(basePath);
  const normalizedPathname = normalizeInternalPath(pathname);

  if (normalizedBasePath.length === 0) {
    return normalizedPathname;
  }

  if (normalizedPathname === normalizedBasePath) {
    return "/";
  }

  const prefixedBasePath = `${normalizedBasePath}/`;

  if (!normalizedPathname.startsWith(prefixedBasePath)) {
    return "/";
  }

  return normalizeInternalPath(
    normalizedPathname.slice(normalizedBasePath.length),
  );
}

function getRouteSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export function matchStudioRoute<T extends MatchableRoute>(
  pathname: string,
  routes: readonly T[],
): T | undefined {
  const targetSegments = getRouteSegments(normalizeInternalPath(pathname));

  return routes.find((route) => {
    const routeSegments = getRouteSegments(route.path);

    return (
      routeSegments.length === targetSegments.length &&
      routeSegments.every((segment, index) => {
        if (segment.startsWith(":")) {
          return true;
        }

        return segment === targetSegments[index];
      })
    );
  });
}

function createDocumentPreviewRequest(routeId: string | undefined):
  | {
      componentName: string;
      props: Record<string, unknown>;
      key: string;
    }
  | undefined {
  if (routeId !== "content.document") {
    return undefined;
  }

  return {
    componentName: "HeroBanner",
    props: { title: "Launch" },
    key: "preview:content.document",
  };
}

export function startDocumentPreview(input: {
  routeId: string | undefined;
  container: unknown | null;
  hostBridge: StudioMountContext["hostBridge"];
}): (() => void) | undefined {
  const request = createDocumentPreviewRequest(input.routeId);

  if (!request || !input.container) {
    return undefined;
  }

  return input.hostBridge.renderMdxPreview({
    container: input.container,
    componentName: request.componentName,
    props: request.props,
    key: request.key,
  });
}

export function extractStudioRouteParams(
  pathname: string,
  route: MatchableRoute | undefined,
): Record<string, string> {
  if (!route) {
    return {};
  }

  const targetSegments = getRouteSegments(normalizeInternalPath(pathname));
  const routeSegments = getRouteSegments(route.path);
  const params: Record<string, string> = {};

  routeSegments.forEach((segment, index) => {
    if (!segment.startsWith(":")) {
      return;
    }

    const value = targetSegments[index];

    if (value !== undefined) {
      params[segment.slice(1)] = decodeURIComponent(value);
    }
  });

  return params;
}
