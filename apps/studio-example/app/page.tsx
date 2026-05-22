import Link from "next/link";

import { fetchRenderedHomePage } from "../lib/example-documents";
import { RenderedSurface, RequestError, SiteHeader } from "./site-components";

export default async function HomePage() {
  const home = await fetchRenderedHomePage();

  return (
    <main className="site-shell">
      <SiteHeader active="home" />

      <section className="landing-hero">
        <div className="hero-copy">
          <p className="eyebrow">Rendered from a page document</p>
          <h1>Build content workflows on top of Markdown.</h1>
          <p>
            This example site reads draft MDCMS content through the SDK and
            renders it as the consumer app would. Studio, CLI sync, and previews
            all point at the same documents.
          </p>
          <div className="hero-actions">
            <Link href="/pages">Browse pages</Link>
            <Link href="/admin">Open Studio</Link>
          </div>
        </div>

        <aside className="hero-panel">
          <div className="hero-panel-header">
            <span>content/pages/home</span>
            <span>{home.ok ? "live draft" : "offline"}</span>
          </div>
          {home.ok ? (
            <RenderedSurface label="CMS-rendered home page">
              {home.renderedBody}
            </RenderedSurface>
          ) : (
            <RequestError
              code={home.code}
              message={home.message}
              status={home.status}
              title="Home page could not be rendered"
            />
          )}
        </aside>
      </section>

      <section className="home-band">
        <div>
          <p className="eyebrow">One content layer</p>
          <h2>Use the same documents across every surface.</h2>
          <p>
            The example app keeps the public site focused on rendered pages
            while still linking into the Studio and SDK inspection flows when
            you need them.
          </p>
        </div>
        <ul className="workflow-list">
          <li>
            <strong>Pages first</strong>
            <span>
              `/pages` lists CMS page documents first, then posts and other
              configured content types.
            </span>
          </li>
          <li>
            <strong>Rendered previews</strong>
            <span>
              Cards show rendered Markdown and MDX rather than raw frontmatter
              or serialized body text.
            </span>
          </li>
          <li>
            <strong>Studio handoff</strong>
            <span>
              Every rendered card links back to the matching Studio document for
              editing.
            </span>
          </li>
        </ul>
      </section>
    </main>
  );
}
