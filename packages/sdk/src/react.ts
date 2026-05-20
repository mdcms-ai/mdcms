import { evaluate } from "@mdx-js/mdx";
import type { ContentDocumentResponse, MdcmsConfig } from "@mdcms/shared";
import type { ReactNode } from "react";
import * as runtime from "react/jsx-runtime";

import { Box, Image, Link, Text } from "./react-primitives.js";

export type MdcmsRendererErrorCode =
  | "MDCMS_RENDERER_SERVER_ONLY"
  | "MDCMS_RENDERER_COMPONENT_LOAD_FAILED"
  | "MDCMS_RENDERER_MDX_RENDER_FAILED"
  | "MDCMS_RENDERER_UNSUPPORTED_MDX_ESM";

export type MdcmsRendererOptions = {
  development?: boolean;
};

export type RenderMdcmsContentOptions = MdcmsRendererOptions & {
  config: MdcmsConfig;
};

export type MdcmsRenderer = {
  render: (document: ContentDocumentResponse) => Promise<ReactNode>;
};

export class MdcmsRendererError extends Error {
  readonly code: MdcmsRendererErrorCode;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(input: {
    code: MdcmsRendererErrorCode;
    message: string;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(input.message);
    this.name = "MdcmsRendererError";
    this.code = input.code;
    this.details = input.details;
    this.cause = input.cause;
  }
}

function assertServerRuntime(): void {
  if ((globalThis as { window?: unknown }).window !== undefined) {
    throw new MdcmsRendererError({
      code: "MDCMS_RENDERER_SERVER_ONLY",
      message:
        "@mdcms/sdk/react renders content on the server only. Do not import it from client components or browser bundles.",
    });
  }
}

function assertNoMdxEsm(document: ContentDocumentResponse): void {
  if (/^\s*(import|export)\s/m.test(document.body)) {
    throw new MdcmsRendererError({
      code: "MDCMS_RENDERER_UNSUPPORTED_MDX_ESM",
      message:
        "@mdcms/sdk/react does not support MDX import or export syntax. Register components in mdcms.config.ts instead.",
      details: {
        documentId: document.documentId,
      },
    });
  }
}

function toComponentMap(
  loadedComponents: Map<string, unknown>,
): Record<string, unknown> {
  const components: Record<string, unknown> = {
    Box,
    Image,
    Link,
    Text,
  };

  for (const [name, component] of loadedComponents) {
    components[name] = component;
  }

  return components;
}

export function createMdcmsRenderer(
  config: MdcmsConfig,
  options: MdcmsRendererOptions = {},
): MdcmsRenderer {
  const componentLoadResults = new Map<string, Promise<unknown>>();

  async function loadComponent(input: {
    name: string;
    load?: () => Promise<unknown>;
  }): Promise<unknown> {
    const existing = componentLoadResults.get(input.name);

    if (existing) {
      return existing;
    }

    if (!input.load) {
      return undefined;
    }

    const loadResult = input.load().catch((error: unknown) => {
      componentLoadResults.delete(input.name);

      throw new MdcmsRendererError({
        code: "MDCMS_RENDERER_COMPONENT_LOAD_FAILED",
        message: `Failed to load MDX component "${input.name}".`,
        details: {
          componentName: input.name,
        },
        cause: error,
      });
    });

    componentLoadResults.set(input.name, loadResult);
    return loadResult;
  }

  async function loadComponents(): Promise<Map<string, unknown>> {
    const loadedComponents = new Map<string, unknown>();

    for (const component of config.components ?? []) {
      const resolved = await loadComponent({
        name: component.name,
        load: component.load,
      });

      if (resolved !== undefined && resolved !== null) {
        loadedComponents.set(component.name, resolved);
      }
    }

    return loadedComponents;
  }

  return {
    async render(document) {
      assertServerRuntime();
      assertNoMdxEsm(document);

      const components = toComponentMap(await loadComponents());

      try {
        const evaluated = await evaluate(
          {
            path: `document.${document.format}`,
            value: document.body,
          },
          {
            ...runtime,
            baseUrl: import.meta.url,
            development: options.development ?? false,
          },
        );
        const Content = evaluated.default;
        const renderContent = Content as (props: {
          components?: Record<string, unknown>;
        }) => ReactNode;

        return renderContent({ components });
      } catch (error) {
        if (error instanceof MdcmsRendererError) {
          throw error;
        }

        throw new MdcmsRendererError({
          code: "MDCMS_RENDERER_MDX_RENDER_FAILED",
          message: `Failed to render MDCMS document "${document.documentId}".`,
          details: {
            documentId: document.documentId,
            format: document.format,
          },
          cause: error,
        });
      }
    },
  };
}

export function renderMdcmsContent(
  document: ContentDocumentResponse,
  options: RenderMdcmsContentOptions,
): Promise<ReactNode> {
  return createMdcmsRenderer(options.config, options).render(document);
}
