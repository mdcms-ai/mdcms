import type { JSONContent } from "@tiptap/core";
import type { StudioMountContext } from "@mdcms/shared";
import {
  createMdxAutoFormFields,
  type MdxAutoFormField,
} from "@mdcms/shared/mdx/auto-form";

type MdxCatalogComponent = NonNullable<
  StudioMountContext["mdx"]
>["catalog"]["components"][number];

export type MdxComponentKind = "void" | "wrapper";

const MDX_CHILDREN_PROP_NAME = "children";

export function isMdxComponentVisibleInInsertUi(
  component: MdxCatalogComponent,
): boolean {
  return component.builtIn !== true;
}

export function getMdxComponentKind(
  component: MdxCatalogComponent,
): MdxComponentKind {
  return component.extractedProps?.[MDX_CHILDREN_PROP_NAME]?.type ===
    "rich-text"
    ? "wrapper"
    : "void";
}

export function createMdxComponentNodeAttributes(
  component: MdxCatalogComponent,
  props: Record<string, unknown> = {},
): {
  componentName: string;
  props: Record<string, unknown>;
  isVoid: boolean;
} {
  return {
    componentName: component.name,
    props,
    isVoid: getMdxComponentKind(component) === "void",
  };
}

export function createMdxComponentInsertContent(
  component: MdxCatalogComponent,
  props: Record<string, unknown> = {},
): JSONContent {
  const attrs = createMdxComponentNodeAttributes(component, props);

  return attrs.isVoid
    ? {
        type: "mdxComponent",
        attrs,
      }
    : {
        type: "mdxComponent",
        attrs,
        // Wrapper components need an initial text block so authors can focus
        // the nested content hole immediately after insertion.
        content: [{ type: "paragraph" }],
      };
}

export function getMdxComponentAutoFormFields(
  component: MdxCatalogComponent,
): MdxAutoFormField[] {
  return createMdxAutoFormFields(
    component.extractedProps,
    component.propHints,
  ).filter((field) => {
    return !(
      field.name === MDX_CHILDREN_PROP_NAME && field.control === "rich-text"
    );
  });
}
