import { MdcmsApiError, MdcmsClientError, createClient } from "@mdcms/sdk";
import type { ContentDocumentResponse } from "@mdcms/cli";

import config from "../mdcms.config";

export type PreviewRequestFailure = {
  status: number;
  code: string;
  message: string;
};

export type PreviewDocumentResult =
  | {
      ok: true;
      document: ContentDocumentResponse;
    }
  | ({
      ok: false;
    } & PreviewRequestFailure);

function getDemoApiKey(): string {
  const apiKey = process.env.MDCMS_DEMO_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      "Set MDCMS_DEMO_API_KEY to enable rendered preview routes.",
    );
  }

  return apiKey;
}

function getPreviewTokenSecret(): string {
  const secret = process.env.MDCMS_PREVIEW_TOKEN_SECRET?.trim();

  if (!secret) {
    throw new Error(
      "Set MDCMS_PREVIEW_TOKEN_SECRET to enable private preview routes.",
    );
  }

  return secret;
}

function createPreviewClient() {
  return createClient({
    serverUrl: config.serverUrl,
    apiKey: getDemoApiKey(),
    project: config.project,
    environment: config.environment,
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        cache: "no-store",
      }),
  });
}

function toPreviewRequestFailure(error: unknown): PreviewRequestFailure {
  if (error instanceof MdcmsApiError) {
    return {
      status: error.statusCode,
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof MdcmsClientError) {
    return {
      status:
        error.code === "NOT_FOUND"
          ? 404
          : error.code === "PREVIEW_TOKEN_INVALID"
            ? 401
            : 502,
      code: error.code,
      message: error.message,
    };
  }

  return {
    status: 500,
    code: "PREVIEW_ERROR",
    message:
      error instanceof Error
        ? error.message
        : "Rendered preview could not load the requested document.",
  };
}

export type PreviewRouteSearchParams = Record<
  string,
  string | string[] | undefined
>;

export function createPreviewRequestUrl(
  pathname: string,
  searchParams: PreviewRouteSearchParams = {},
): string {
  const url = new URL(pathname, "https://mdcms-preview.local");

  for (const [key, value] of Object.entries(searchParams)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, item);
      }
      continue;
    }

    url.searchParams.set(key, value);
  }

  return url.href;
}

export async function fetchPreviewDocumentFromRequestUrl(
  requestUrl: string,
): Promise<PreviewDocumentResult> {
  try {
    const client = createPreviewClient();
    const document = await client.getPreviewDocumentFromRequest(requestUrl, {
      secret: getPreviewTokenSecret(),
    });

    return {
      ok: true,
      document,
    };
  } catch (error) {
    return {
      ok: false,
      ...toPreviewRequestFailure(error),
    };
  }
}
