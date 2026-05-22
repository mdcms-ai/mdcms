import Link from "next/link";
import type { ReactNode } from "react";

import { createMdcmsRenderer } from "@mdcms/sdk/react";

import type { PreviewDocumentResult } from "../../lib/preview-content";
import config from "../../mdcms.config";

const previewRenderer = createMdcmsRenderer(config);

async function renderPreviewBody(
  result: PreviewDocumentResult,
): Promise<ReactNode> {
  if (!result.ok) {
    return null;
  }

  return previewRenderer.render(result.document);
}

export async function PreviewDocumentView({
  heading,
  result,
}: {
  heading: string;
  result: PreviewDocumentResult;
}) {
  const renderedBody = await renderPreviewBody(result);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f8fafc",
        color: "#0f172a",
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <div
        style={{
          margin: "0 auto",
          maxWidth: "880px",
          padding: "48px 24px 72px",
        }}
      >
        <header
          style={{
            marginBottom: "32px",
            borderBottom: "1px solid #e2e8f0",
            paddingBottom: "20px",
          }}
        >
          <p
            style={{
              margin: "0 0 8px",
              color: "#475569",
              fontSize: "13px",
              fontWeight: 700,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            Draft rendered from MDCMS
          </p>
          <h1 style={{ margin: 0, fontSize: "42px", lineHeight: 1.05 }}>
            {heading}
          </h1>
        </header>

        {!result.ok ? (
          <section>
            <h2>Preview unavailable</h2>
            <p>
              {result.code} ({result.status})
            </p>
            <p>{result.message}</p>
          </section>
        ) : (
          <article>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "8px",
                marginBottom: "28px",
                color: "#475569",
                fontSize: "13px",
              }}
            >
              <span>
                type=<code>{result.document.type}</code>
              </span>
              <span>
                path=<code>{result.document.path}</code>
              </span>
              <span>
                draftRevision=<code>{result.document.draftRevision}</code>
              </span>
              <Link
                href={`/admin/content/${result.document.type}/${result.document.documentId}`}
              >
                Open in Studio
              </Link>
            </div>
            {renderedBody}
          </article>
        )}
      </div>
    </main>
  );
}
