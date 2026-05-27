import { fetchRenderedDocumentLibrary } from "../../lib/example-documents";
import { DocumentLibrary, RequestError, SiteHeader } from "../site-components";

export const metadata = {
  title: "Content Library | MDCMS Demo",
  description: "Browse rendered pages, posts, and configured MDCMS documents.",
};

export default async function PagesIndexPage() {
  const result = await fetchRenderedDocumentLibrary();

  return (
    <main className="site-shell">
      <SiteHeader active="pages" />

      <section className="library-hero">
        <p className="eyebrow">Content library</p>
        <h1>Pages, posts, and campaigns in one rendered index.</h1>
        <p>
          Pages appear first so the site hierarchy is easy to scan. Posts and
          other configured document types follow in the same draft scope.
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
        ) : (
          <DocumentLibrary
            emptyMessage="The configured MDCMS scope has no draft documents yet."
            groups={result.groups}
          />
        )}
      </section>
    </main>
  );
}
