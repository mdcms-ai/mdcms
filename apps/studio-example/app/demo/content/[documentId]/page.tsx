import Link from "next/link";

import { getPreviewHrefForDocument } from "../../../../lib/preview-routing";
import { RenderedContent } from "../../../../lib/rendered-content";
import config from "../../../../mdcms.config";
import { RequestError, SiteHeader } from "../../../site-components";

type ContentDocument = {
  documentId: string;
  type: string;
  locale: string;
  path: string;
  format: "md" | "mdx";
  frontmatter: Record<string, unknown>;
  body: string;
  draftRevision: number;
  publishedVersion: number | null;
};

type DocumentResult =
  | {
      ok: true;
      document: ContentDocument;
    }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
    };

type DocumentPageProps = {
  params: Promise<{
    documentId: string;
  }>;
};

function toRequestHeaders(): Headers {
  const headers = new Headers({
    "x-mdcms-project": config.project,
    "x-mdcms-environment": config.environment,
  });

  const apiKey = process.env.MDCMS_DEMO_API_KEY?.trim();

  if (apiKey) {
    headers.set("authorization", `Bearer ${apiKey}`);
  }

  return headers;
}

function isContentDocument(value: unknown): value is ContentDocument {
  if (!value || typeof value !== "object") {
    return false;
  }

  const row = value as Record<string, unknown>;
  return (
    typeof row.documentId === "string" &&
    typeof row.type === "string" &&
    typeof row.locale === "string" &&
    typeof row.path === "string" &&
    (row.format === "md" || row.format === "mdx") &&
    typeof row.frontmatter === "object" &&
    row.frontmatter !== null &&
    !Array.isArray(row.frontmatter) &&
    typeof row.body === "string" &&
    typeof row.draftRevision === "number" &&
    Number.isInteger(row.draftRevision) &&
    (row.publishedVersion === null ||
      (typeof row.publishedVersion === "number" &&
        Number.isInteger(row.publishedVersion)))
  );
}

async function fetchDocument(documentId: string): Promise<DocumentResult> {
  const url = new URL(`/api/v1/content/${documentId}`, config.serverUrl);
  url.searchParams.set("project", config.project);
  url.searchParams.set("environment", config.environment);
  url.searchParams.set("draft", "true");

  let response: Response;

  try {
    response = await fetch(url, {
      method: "GET",
      headers: toRequestHeaders(),
      cache: "no-store",
    });
  } catch (error) {
    return {
      ok: false,
      status: 502,
      code: "REMOTE_ERROR",
      message:
        error instanceof Error
          ? `Failed to reach content API: ${error.message}`
          : "Failed to reach content API.",
    };
  }

  const body = (await response.json().catch(() => undefined)) as
    | {
        code?: unknown;
        message?: unknown;
        data?: unknown;
      }
    | undefined;

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      code: typeof body?.code === "string" ? body.code : "REMOTE_ERROR",
      message:
        typeof body?.message === "string"
          ? body.message
          : `Content request failed (${response.status}).`,
    };
  }

  if (!isContentDocument(body?.data)) {
    return {
      ok: false,
      status: 502,
      code: "REMOTE_ERROR",
      message: 'Content API response is missing a valid "data" payload.',
    };
  }

  return {
    ok: true,
    document: body.data,
  };
}

export default async function DemoContentDocumentPage({
  params,
}: DocumentPageProps) {
  const { documentId } = await params;
  const result = await fetchDocument(documentId);
  const previewHref = result.ok
    ? getPreviewHrefForDocument(result.document)
    : undefined;

  return (
    <main className="site-shell">
      <SiteHeader active="sdk" />

      <section className="library-hero">
        <p className="eyebrow">API detail</p>
        <h1>{result.ok ? result.document.path : documentId}</h1>
        <p>
          Direct content API response for <strong>{config.project}</strong> /{" "}
          <strong>{config.environment}</strong>, rendered for inspection.
        </p>
        <p>
          <Link href="/demo/content">Back to API documents</Link>
          {" | "}
          <Link
            href={
              result.ok
                ? `/demo/sdk-content/${documentId}?type=${encodeURIComponent(result.document.type)}`
                : `/demo/sdk-content/${documentId}`
            }
          >
            SDK detail
          </Link>
          {previewHref ? (
            <>
              {" | "}
              <Link href={previewHref}>Open preview route</Link>
            </>
          ) : null}
        </p>
      </section>

      <section className="library-content">
        {!result.ok ? (
          <RequestError
            code={result.code}
            message={result.message}
            status={result.status}
            title="Document could not be loaded"
          />
        ) : (
          <article className="rendered-surface">
            <div className="document-card-header">
              <div>
                <p className="document-type">{result.document.type}</p>
                <h2>{result.document.path}</h2>
              </div>
              <span>{result.document.locale}</span>
            </div>
            <div className="rendered-preview">
              <RenderedContent body={result.document.body} />
            </div>
          </article>
        )}
      </section>
    </main>
  );
}
