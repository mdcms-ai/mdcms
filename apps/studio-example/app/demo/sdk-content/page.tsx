import Link from "next/link";

import { fetchRenderedDocumentLibrary } from "../../../lib/example-documents";
import config from "../../../mdcms.config";
import {
  DocumentLibrary,
  RequestError,
  SiteHeader,
} from "../../site-components";

export default async function DemoSdkContentPage() {
  const result = await fetchRenderedDocumentLibrary();

  return (
    <main className="site-shell">
      <SiteHeader active="sdk" />

      <section className="library-hero">
        <p className="eyebrow">SDK client</p>
        <h1>Rendered draft documents from the SDK.</h1>
        <p>
          Scope: <strong>{config.project}</strong> /{" "}
          <strong>{config.environment}</strong>. This route uses{" "}
          <strong>@mdcms/sdk</strong> and includes pages, posts, and the other
          configured content types.
        </p>
        <p>
          <Link href="/pages">Open the public pages index</Link>
        </p>
      </section>

      <section className="library-content">
        {!result.ok ? (
          <RequestError
            code={result.code}
            message={result.message}
            status={result.status}
            title="SDK documents could not be loaded"
          />
        ) : (
          <DocumentLibrary
            emptyMessage="The SDK did not find any draft documents in this scope."
            groups={result.groups}
          />
        )}
      </section>
    </main>
  );
}
