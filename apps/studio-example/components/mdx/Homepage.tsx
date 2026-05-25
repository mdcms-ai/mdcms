import type { ReactNode } from "react";

function text(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

type HomeHeroProps = {
  eyebrow?: string;
  title?: string;
  summary?: string;
  primaryHref?: string;
  primaryLabel?: string;
  secondaryHref?: string;
  secondaryLabel?: string;
};

export function HomeHero({
  eyebrow,
  title,
  summary,
  primaryHref,
  primaryLabel,
  secondaryHref,
  secondaryLabel,
}: HomeHeroProps) {
  return (
    <section className="landing-hero">
      <div className="hero-copy">
        <p className="eyebrow">{text(eyebrow, "MDCMS demo")}</p>
        <h1>
          {text(title, "Content operations without giving up local files")}
        </h1>
        <p>
          {text(
            summary,
            "MDCMS keeps editorial work, local Markdown workflows, and application previews on the same content contract.",
          )}
        </p>
        <div className="hero-actions">
          <a href={primaryHref ?? "/pages"}>
            {text(primaryLabel, "Browse pages")}
          </a>
          {secondaryHref ? (
            <a href={secondaryHref}>{text(secondaryLabel, "Open")}</a>
          ) : null}
        </div>
      </div>
    </section>
  );
}

type HomeSectionProps = {
  eyebrow?: string;
  title?: string;
  summary?: string;
  children?: ReactNode;
};

export function HomeSection({
  eyebrow,
  title,
  summary,
  children,
}: HomeSectionProps) {
  return (
    <section className="home-band">
      <div>
        <p className="eyebrow">{text(eyebrow, "Content layer")}</p>
        <h2>{text(title, "Use the same documents across every surface.")}</h2>
        {summary ? <p>{summary}</p> : null}
      </div>
      <div>{children}</div>
    </section>
  );
}

export function HomeFeatureGrid({ children }: { children?: ReactNode }) {
  return (
    <div className="workflow-list">
      {children ?? (
        <HomeFeature title="Draft preview">
          Rendered content appears in the consumer app.
        </HomeFeature>
      )}
    </div>
  );
}

export function HomeFeature({
  title,
  children,
}: {
  title?: string;
  children?: ReactNode;
}) {
  return (
    <article className="home-feature-card">
      <strong>{text(title, "Draft preview")}</strong>
      <div className="home-feature-card-body">
        {children ?? "Rendered content appears in the consumer app."}
      </div>
    </article>
  );
}

type HomeCtaProps = {
  title?: string;
  href?: string;
  label?: string;
  children?: ReactNode;
};

export function HomeCta({ title, href, label, children }: HomeCtaProps) {
  return (
    <section className="home-cta">
      <div>
        <p className="eyebrow">Next step</p>
        <h2>{text(title, "Inspect the rendered content library")}</h2>
        {children ? <p>{children}</p> : null}
      </div>
      <a href={href ?? "/demo/sdk-content"}>{text(label, "Open SDK output")}</a>
    </section>
  );
}
