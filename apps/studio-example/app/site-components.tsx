import Link from "next/link";

import type {
  ExampleDocumentGroup,
  RenderedExampleDocument,
} from "../lib/example-documents";

type SiteHeaderProps = {
  active: "home" | "pages" | "studio" | "sdk";
};

export function SiteHeader({ active }: SiteHeaderProps) {
  return (
    <header className="site-header">
      <Link className="site-brand" href="/">
        MDCMS Demo
      </Link>
      <nav aria-label="Primary navigation" className="site-nav">
        <Link
          aria-current={active === "home" ? "page" : undefined}
          data-active={active === "home" ? "true" : undefined}
          href="/"
        >
          Home
        </Link>
        <Link
          aria-current={active === "pages" ? "page" : undefined}
          data-active={active === "pages" ? "true" : undefined}
          href="/pages"
        >
          Pages
        </Link>
        <Link
          aria-current={active === "studio" ? "page" : undefined}
          data-active={active === "studio" ? "true" : undefined}
          href="/admin"
        >
          Studio
        </Link>
        <Link
          aria-current={active === "sdk" ? "page" : undefined}
          data-active={active === "sdk" ? "true" : undefined}
          href="/demo/sdk-content"
        >
          SDK
        </Link>
      </nav>
    </header>
  );
}

export function RequestError({
  title,
  code,
  status,
  message,
}: {
  title: string;
  code: string;
  status: number;
  message: string;
}) {
  return (
    <section className="request-error">
      <p className="eyebrow">Preview unavailable</p>
      <h2>{title}</h2>
      <p>
        {code} ({status})
      </p>
      <p>{message}</p>
    </section>
  );
}

export function DocumentLibrary({
  groups,
  emptyMessage,
}: {
  groups: ExampleDocumentGroup[];
  emptyMessage: string;
}) {
  if (groups.length === 0) {
    return (
      <section className="empty-state">
        <h2>No documents yet</h2>
        <p>{emptyMessage}</p>
      </section>
    );
  }

  return (
    <div className="document-library">
      {groups.map((group) => (
        <section className="document-group" key={group.type}>
          <div className="section-heading">
            <p className="eyebrow">{group.type}</p>
            <h2>{group.label}</h2>
            <span>{group.total}</span>
          </div>
          <div className="document-grid">
            {group.documents.map((document) => (
              <DocumentCard
                document={document}
                key={document.document.documentId}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function DocumentCard({
  document,
}: {
  document: RenderedExampleDocument;
}) {
  return (
    <article className="document-card">
      <div className="document-card-header">
        <div>
          <p className="document-type">{document.document.type}</p>
          <h3>{document.title}</h3>
        </div>
        <span>{document.document.locale}</span>
      </div>
      {document.summary ? (
        <p className="document-summary">{document.summary}</p>
      ) : null}
      <div
        aria-label={
          document.renderError
            ? `${document.title} preview unavailable`
            : `${document.title} preview`
        }
        className={
          document.renderError
            ? "rendered-preview rendered-preview-error"
            : "rendered-preview"
        }
      >
        {document.renderError ? (
          <>
            <p className="eyebrow">Preview unavailable</p>
            <strong>Preview could not be rendered</strong>
            <span>{document.renderError.message}</span>
          </>
        ) : (
          document.renderedBody
        )}
      </div>
      <div className="document-actions">
        {document.previewHref ? (
          <Link href={document.previewHref}>Open preview</Link>
        ) : null}
        <Link
          href={`/demo/sdk-content/${document.document.documentId}?type=${encodeURIComponent(document.document.type)}`}
        >
          SDK detail
        </Link>
        <Link
          href={`/admin/content/${document.document.type}/${document.document.documentId}`}
        >
          Edit
        </Link>
      </div>
    </article>
  );
}
