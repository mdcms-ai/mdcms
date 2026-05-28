import Link from "next/link";

import type { ContentDocumentResponse } from "@mdcms/cli";
import { createMdcmsRenderer } from "@mdcms/sdk/react";

import { getDocumentTitle } from "../../../../lib/example-documents";
import { getPreviewHrefForDocument } from "../../../../lib/preview-routing";
import config from "../../../../mdcms.config";
import { createDemoSdkClient, toDemoRequestFailure } from "../sdk-demo-client";
import { RequestError, SiteHeader } from "../../../site-components";

const contentRenderer = createMdcmsRenderer(config);

type DocumentResult =
  | {
      ok: true;
      document: ContentDocumentResponse;
    }
  | ({
      ok: false;
    } & ReturnType<typeof toDemoRequestFailure>);

type DocumentPageProps = {
  params: Promise<{
    documentId: string;
  }>;
  searchParams?: Promise<{
    type?: string;
  }>;
};

async function fetchDocument(
  type: string,
  documentId: string,
): Promise<DocumentResult> {
  try {
    const client = createDemoSdkClient();
    const document = await client.get(type, {
      id: documentId,
      draft: true,
    });

    return {
      ok: true,
      document,
    };
  } catch (error) {
    return {
      ok: false,
      ...toDemoRequestFailure(error),
    };
  }
}

export default async function DemoSdkContentDocumentPage({
  params,
  searchParams,
}: DocumentPageProps) {
  const { documentId } = await params;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const type = resolvedSearchParams?.type?.trim() || "post";
  const result = await fetchDocument(type, documentId);
  const previewHref = result.ok
    ? getPreviewHrefForDocument(result.document)
    : undefined;
  const renderedBody = result.ok
    ? await contentRenderer.render(result.document)
    : null;

  return (
    <main className="site-shell">
      <SiteHeader active="sdk" />

      <section className="library-hero">
        <p className="eyebrow">SDK detail</p>
        <h1>{result.ok ? getDocumentTitle(result.document) : documentId}</h1>
        <p>
          Rendered with <strong>@mdcms/sdk</strong> from draft content in{" "}
          <strong>{config.project}</strong> /{" "}
          <strong>{config.environment}</strong>.
        </p>
        <p>
          <Link href="/demo/sdk-content">Back to SDK documents</Link>
          {" | "}
          <Link href={`/demo/content/${documentId}`}>API metadata</Link>
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
            <div className="rendered-preview">{renderedBody}</div>
          </article>
        )}
      </section>
    </main>
  );
}
