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
      status: error.code === "NOT_FOUND" ? 404 : 502,
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

export async function fetchPreviewPostBySlug(
  slug: string,
): Promise<PreviewDocumentResult> {
  try {
    const client = createPreviewClient();
    const document = await client.get("post", {
      slug,
      draft: true,
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

function getPageDocumentPath(pathSegments: string[]): string {
  return `content/pages/${pathSegments.filter(Boolean).join("/")}`;
}

export async function fetchPreviewPageByPath(
  pathSegments: string[],
): Promise<PreviewDocumentResult> {
  try {
    const client = createPreviewClient();
    const result = await client.list("page", {
      draft: true,
      path: getPageDocumentPath(pathSegments),
      limit: 2,
    });

    if (result.data.length === 0) {
      return {
        ok: false,
        status: 404,
        code: "NOT_FOUND",
        message: `No page document matched path "${getPageDocumentPath(pathSegments)}".`,
      };
    }

    if (result.data.length > 1) {
      return {
        ok: false,
        status: 502,
        code: "AMBIGUOUS_RESULT",
        message: `Multiple page documents matched path "${getPageDocumentPath(pathSegments)}".`,
      };
    }

    return {
      ok: true,
      document: result.data[0]!,
    };
  } catch (error) {
    return {
      ok: false,
      ...toPreviewRequestFailure(error),
    };
  }
}
