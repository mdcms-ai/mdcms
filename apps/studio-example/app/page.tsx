import { fetchRenderedHomePage } from "../lib/example-documents";
import { RequestError, SiteHeader } from "./site-components";

export const metadata = {
  title: "MDCMS Demo",
  description: "Rendered MDCMS home page managed from draft content.",
};

export default async function HomePage() {
  const home = await fetchRenderedHomePage();

  return (
    <main className="site-shell">
      <SiteHeader active="home" />

      {home.ok ? (
        home.renderedBody
      ) : (
        <section className="library-content">
          <RequestError
            code={home.code}
            message={home.message}
            status={home.status}
            title="Home page could not be rendered"
          />
        </section>
      )}
    </main>
  );
}
