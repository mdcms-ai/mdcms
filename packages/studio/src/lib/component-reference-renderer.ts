import type {
  AiComponentReference,
  HostBridgeV1,
  MdxComponentCatalog,
  MdxComponentCatalogEntry,
  MdxExtractedProp,
} from "@mdcms/shared";

const MAX_REFERENCE_HTML_LENGTH = 20_000;
const MAX_REFERENCE_TEXT_LENGTH = 5_000;
const MAX_STYLE_SUMMARY_LENGTH = 5_000;
const STYLE_SUMMARY_ELEMENT_LIMIT = 8;
const STYLE_SUMMARY_PROPS = [
  "display",
  "gridTemplateColumns",
  "alignItems",
  "justifyContent",
  "gap",
  "padding",
  "margin",
  "color",
  "backgroundColor",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "textTransform",
  "border",
  "borderRadius",
  "boxShadow",
] as const;

export async function createStudioComponentReferences(input: {
  catalog: MdxComponentCatalog;
  hostBridge: HostBridgeV1;
}): Promise<AiComponentReference[]> {
  if (typeof document === "undefined") {
    return [];
  }

  const references = await Promise.all(
    input.catalog.components.map((component) =>
      renderComponentReference({
        component,
        hostBridge: input.hostBridge,
      }),
    ),
  );

  return references.filter(
    (reference): reference is AiComponentReference => reference !== undefined,
  );
}

async function renderComponentReference(input: {
  component: MdxComponentCatalogEntry;
  hostBridge: HostBridgeV1;
}): Promise<AiComponentReference | undefined> {
  if (input.hostBridge.resolveComponent(input.component.name) == null) {
    return undefined;
  }

  const container = document.createElement("div");
  container.setAttribute(
    "data-mdcms-component-reference",
    input.component.name,
  );
  container.style.cssText = [
    "position:fixed",
    "left:-10000px",
    "top:-10000px",
    "width:1024px",
    "visibility:hidden",
    "pointer-events:none",
  ].join(";");
  document.body.appendChild(container);

  let cleanup: (() => void) | undefined;
  try {
    cleanup = input.hostBridge.renderMdxPreview({
      container,
      componentName: input.component.name,
      props: buildReferenceProps(input.component),
      key: `component-reference:${input.component.name}`,
    });
    await waitForPreviewFlush();

    const renderedHtml = container.innerHTML.trim();
    if (renderedHtml.length === 0) {
      return undefined;
    }

    const visibleText = normalizeVisibleText(container.textContent ?? "");
    const styleSummary = summarizeComputedStyles(container);
    return {
      componentName: input.component.name,
      source: "studio_host_preview",
      renderedHtml: renderedHtml.slice(0, MAX_REFERENCE_HTML_LENGTH),
      ...(visibleText
        ? { text: visibleText.slice(0, MAX_REFERENCE_TEXT_LENGTH) }
        : {}),
      ...(styleSummary
        ? { styleSummary: styleSummary.slice(0, MAX_STYLE_SUMMARY_LENGTH) }
        : {}),
    };
  } catch {
    return undefined;
  } finally {
    try {
      cleanup?.();
    } finally {
      container.remove();
    }
  }
}

function buildReferenceProps(
  component: MdxComponentCatalogEntry,
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(component.extractedProps ?? {})) {
    if (prop.required) {
      props[name] = sampleValueForProp(name, prop);
    }
  }
  return props;
}

function sampleValueForProp(name: string, prop: MdxExtractedProp): unknown {
  switch (prop.type) {
    case "string":
      return prop.format === "url" ? "/" : sampleText(name);
    case "number":
      return 1;
    case "boolean":
      return false;
    case "date":
      return "2026-05-26";
    case "enum":
      return prop.values[0] ?? sampleText(name);
    case "array":
      return [];
    case "style":
      return {};
    case "json":
      return {};
    case "rich-text":
      return "Sample content";
  }
}

function sampleText(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .toLowerCase();
}

/**
 * Best-effort preview flush. One frame matches the historical behavior, but
 * callers may request extra frames for components that schedule follow-up work.
 * Arbitrary delayed effects can still update after this resolves.
 */
async function waitForPreviewFlush(maxFrames = 1): Promise<void> {
  await Promise.resolve();
  const frames = Math.max(1, maxFrames);

  for (let frame = 0; frame < frames; frame += 1) {
    if (typeof requestAnimationFrame === "function") {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    } else {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
}

function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function summarizeComputedStyles(container: HTMLElement): string | undefined {
  if (typeof getComputedStyle !== "function") {
    return undefined;
  }

  const root =
    container.firstElementChild instanceof HTMLElement
      ? container.firstElementChild
      : container;
  const elements = [
    root,
    ...Array.from(root.querySelectorAll("*")).filter(
      (element): element is HTMLElement => element instanceof HTMLElement,
    ),
  ].slice(0, STYLE_SUMMARY_ELEMENT_LIMIT);

  const lines = elements.flatMap((element) => {
    const style = getComputedStyle(element);
    const pairs = STYLE_SUMMARY_PROPS.flatMap((property) => {
      const value = style[property];
      return isUsefulStyleValue(property, value)
        ? [`${property}: ${normalizeStyleValue(value)}`]
        : [];
    });
    return pairs.length > 0
      ? [`${describeElement(element)} { ${pairs.join("; ")} }`]
      : [];
  });

  return lines.length > 0 ? lines.join("\n") : undefined;
}

function describeElement(element: HTMLElement): string {
  const tag = element.tagName.toLowerCase();
  const className = Array.from(element.classList).slice(0, 3).join(".");
  return className ? `${tag}.${className}` : tag;
}

function normalizeStyleValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isUsefulStyleValue(
  property: (typeof STYLE_SUMMARY_PROPS)[number],
  value: string,
): boolean {
  const normalized = normalizeStyleValue(value);
  if (!normalized) return false;
  if (normalized === "normal") return false;
  if (normalized === "none") return false;
  if (normalized === "0px") return false;
  if (normalized === "rgba(0, 0, 0, 0)") return false;
  if (property === "color" && normalized === "rgb(0, 0, 0)") return false;
  if (property === "display" && normalized === "block") return false;
  if (property === "border" && normalized === "0px none rgb(0, 0, 0)") {
    return false;
  }
  return true;
}
