import type { ReactNode } from "react";

import type { ContentDocumentResponse } from "@mdcms/cli";
import { createMdcmsRenderer } from "@mdcms/sdk/react";

import config from "../mdcms.config";
import {
  createDemoSdkClient,
  toDemoRequestFailure,
  type DemoRequestFailure,
} from "./demo-sdk-client";
import { getPreviewHrefForDocument } from "./preview-routing";

const documentRenderer = createMdcmsRenderer(config);
const preferredTypeOrder = ["page", "post"];

export type ExampleDocumentGroup = {
  type: string;
  label: string;
  total: number;
  documents: RenderedExampleDocument[];
};

export type RenderedExampleDocument = {
  document: ContentDocumentResponse;
  title: string;
  summary: string | undefined;
  previewHref: string | undefined;
  renderedBody: ReactNode;
  renderError: DocumentRenderError | undefined;
};

export type ExampleDocumentLibraryResult =
  | {
      ok: true;
      groups: ExampleDocumentGroup[];
      total: number;
    }
  | ({
      ok: false;
    } & DemoRequestFailure);

export type RenderedHomePageResult =
  | {
      ok: true;
      document: ContentDocumentResponse;
      title: string;
      summary: string | undefined;
      renderedBody: ReactNode;
      previewHref: string | undefined;
    }
  | ({
      ok: false;
    } & DemoRequestFailure);

export type DocumentRenderError = {
  code: string;
  message: string;
};

function titleizeType(type: string): string {
  return `${type.slice(0, 1).toUpperCase()}${type.slice(1)}s`;
}

function getConfiguredDocumentTypes(): string[] {
  const configuredTypes = (config.types ?? []).map((type) => type.name);
  const orderedTypes = [...preferredTypeOrder, ...configuredTypes];

  return [...new Set(orderedTypes)].filter((type) => type.trim().length > 0);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function getDocumentTitle(document: ContentDocumentResponse): string {
  return (
    getString(document.frontmatter.title) ??
    document.path.split("/").filter(Boolean).at(-1) ??
    document.documentId
  );
}

export function getDocumentSummary(
  document: ContentDocumentResponse,
): string | undefined {
  const frontmatterSummary =
    getString(document.frontmatter.summary) ??
    getString(document.frontmatter.excerpt);

  if (frontmatterSummary) {
    return frontmatterSummary;
  }

  return document.body
    .split(/\n+/)
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length > 0 &&
        !line.startsWith("#") &&
        !line.startsWith("<") &&
        !line.startsWith("-") &&
        line !== "---" &&
        !/^\d+\./.test(line),
    );
}

function toDocumentRenderError(error: unknown): DocumentRenderError {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "RENDER_ERROR";

  return {
    code,
    message:
      error instanceof Error
        ? error.message
        : "This document preview could not be rendered.",
  };
}

async function renderDocument(
  document: ContentDocumentResponse,
): Promise<RenderedExampleDocument> {
  const baseDocument = {
    document,
    title: getDocumentTitle(document),
    summary: getDocumentSummary(document),
    previewHref: getPreviewHrefForDocument(document),
  };

  try {
    return {
      ...baseDocument,
      renderedBody: await documentRenderer.render(document),
      renderError: undefined,
    };
  } catch (error) {
    return {
      ...baseDocument,
      renderedBody: null,
      renderError: toDocumentRenderError(error),
    };
  }
}

async function renderRequiredDocument(
  document: ContentDocumentResponse,
): Promise<RenderedExampleDocument> {
  return {
    document,
    title: getDocumentTitle(document),
    summary: getDocumentSummary(document),
    previewHref: getPreviewHrefForDocument(document),
    renderedBody: await documentRenderer.render(document),
    renderError: undefined,
  };
}

export async function fetchRenderedHomePage(): Promise<RenderedHomePageResult> {
  try {
    const client = createDemoSdkClient();
    const result = await client.list("page", {
      draft: true,
      path: "content/pages/home",
      limit: 2,
    });

    if (result.data.length === 0) {
      return {
        ok: false,
        status: 404,
        code: "NOT_FOUND",
        message: 'No page document matched path "content/pages/home".',
      };
    }

    if (result.data.length > 1) {
      return {
        ok: false,
        status: 502,
        code: "AMBIGUOUS_RESULT",
        message: 'Multiple page documents matched path "content/pages/home".',
      };
    }

    const document = result.data[0]!;
    const rendered = await renderRequiredDocument(document);

    return {
      ok: true,
      document,
      title: rendered.title,
      summary: rendered.summary,
      renderedBody: rendered.renderedBody,
      previewHref: rendered.previewHref,
    };
  } catch (error) {
    return {
      ok: false,
      ...toDemoRequestFailure(error),
    };
  }
}

export async function fetchRenderedDocumentLibrary(): Promise<ExampleDocumentLibraryResult> {
  try {
    const client = createDemoSdkClient();
    const groups = await Promise.all(
      getConfiguredDocumentTypes().map(async (type) => {
        const result = await client.list(type, {
          draft: true,
          limit: 50,
          offset: 0,
          sort: "path",
          order: "asc",
        });

        return {
          type,
          label: titleizeType(type),
          total: result.pagination.total,
          documents: await Promise.all(result.data.map(renderDocument)),
        };
      }),
    );

    const populatedGroups = groups.filter(
      (group) => group.documents.length > 0 || group.total > 0,
    );

    return {
      ok: true,
      groups: populatedGroups,
      total: populatedGroups.reduce((sum, group) => sum + group.total, 0),
    };
  } catch (error) {
    return {
      ok: false,
      ...toDemoRequestFailure(error),
    };
  }
}
