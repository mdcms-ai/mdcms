import Link from "next/link";

import { getPreviewHrefForDocument } from "../../../lib/preview-routing";
import { RenderedContent } from "../../../lib/rendered-content";
import config from "../../../mdcms.config";
import { RequestError, SiteHeader } from "../../site-components";

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

type ContentListResult =
  | {
      ok: true;
      documents: ContentDocument[];
      total: number;
    }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
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

async function fetchContentList(): Promise<ContentListResult> {
  const url = new URL("/api/v1/content", config.serverUrl);
  url.searchParams.set("project", config.project);
  url.searchParams.set("environment", config.environment);
  url.searchParams.set("draft", "true");
  url.searchParams.set("limit", "50");
  url.searchParams.set("offset", "0");

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
        pagination?: {
          total?: unknown;
        };
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

  const rows = Array.isArray(body?.data)
    ? body.data.filter((entry) => isContentDocument(entry))
    : [];
  const total =
    typeof body?.pagination?.total === "number"
      ? body.pagination.total
      : rows.length;

  if (!Array.isArray(body?.data)) {
    return {
      ok: false,
      status: 502,
      code: "REMOTE_ERROR",
      message: 'Content API response is missing "data" array.',
    };
  }

  return {
    ok: true,
    documents: rows,
    total,
  };
}

export default async function DemoContentPage() {
  const result = await fetchContentList();

  return (
    <main className="site-shell">
      <SiteHeader active="sdk" />

      <section className="library-hero">
        <p className="eyebrow">Direct API</p>
        <h1>Rendered documents from the content API.</h1>
        <p>
          Scope: <strong>{config.project}</strong> /{" "}
          <strong>{config.environment}</strong>. This diagnostic route fetches
          draft documents directly from <strong>{config.serverUrl}</strong>.
        </p>
        <p>
          <Link href="/demo/sdk-content">Open the SDK-rendered library</Link>
        </p>
      </section>

      <section className="library-content">
        {!result.ok ? (
          <RequestError
            code={result.code}
            message={result.message}
            status={result.status}
            title="Documents could not be loaded"
          />
        ) : result.documents.length === 0 ? (
          <section className="empty-state">
            <h2>No documents</h2>
            <p>The target scope has no content documents yet.</p>
          </section>
        ) : (
          <section className="document-group">
            <div className="section-heading">
              <p className="eyebrow">all types</p>
              <h2>Documents</h2>
              <span>{result.total}</span>
            </div>
            <div className="document-grid">
              {result.documents.map((document) => {
                const previewHref = getPreviewHrefForDocument(document);

                return (
                  <article className="document-card" key={document.documentId}>
                    <div className="document-card-header">
                      <div>
                        <p className="document-type">{document.type}</p>
                        <h3>{document.path}</h3>
                      </div>
                      <span>{document.locale}</span>
                    </div>
                    <div className="rendered-preview">
                      <RenderedContent body={document.body} />
                    </div>
                    <div className="document-actions">
                      <Link href={`/demo/content/${document.documentId}`}>
                        API detail
                      </Link>
                      <Link
                        href={`/demo/sdk-content/${document.documentId}?type=${encodeURIComponent(document.type)}`}
                      >
                        SDK detail
                      </Link>
                      {previewHref ? (
                        <Link href={previewHref}>Open preview</Link>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}
      </section>
    </main>
  );
}
