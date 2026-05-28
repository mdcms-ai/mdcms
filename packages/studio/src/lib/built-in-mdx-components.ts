import type {
  MdcmsInlineStyle,
  MdxComponentCatalogEntry,
  MdxExtractedProps,
} from "@mdcms/shared";
import { createElement, type CSSProperties, type ReactNode } from "react";

const BUILT_IN_IMPORT_PATH = "@mdcms/sdk/react-primitives";

export const BUILT_IN_MDX_COMPONENT_NAMES = [
  "Box",
  "Text",
  "Image",
  "Link",
] as const;

export type BuiltInMdxComponentName =
  (typeof BUILT_IN_MDX_COMPONENT_NAMES)[number];

export type StudioMdxComponentRegistration = {
  name: string;
  importPath: string;
  description?: string;
  propHints?: MdxComponentCatalogEntry["propHints"];
  propsEditor?: string;
  load?: () => Promise<unknown>;
  loadPropsEditor?: () => Promise<unknown>;
  extractedProps?: MdxExtractedProps;
  builtIn?: true;
};

const builtInMdxComponentNameSet = new Set<string>(
  BUILT_IN_MDX_COMPONENT_NAMES,
);

export function isBuiltInMdxComponentName(name: string): boolean {
  return builtInMdxComponentNameSet.has(name);
}

export function assertNoBuiltInMdxComponentNames(
  components: readonly { name: string }[] = [],
): void {
  const reservedName = components.find((component) =>
    isBuiltInMdxComponentName(component.name),
  )?.name;

  if (!reservedName) {
    return;
  }

  throw new Error(
    `MDX component name "${reservedName}" is reserved for an MDCMS built-in component.`,
  );
}

type StudioBuiltInMdxComponent = MdxComponentCatalogEntry &
  StudioMdxComponentRegistration & {
    builtIn: true;
    load: () => Promise<unknown>;
  };

const STUDIO_BUILT_IN_MDX_COMPONENTS: StudioBuiltInMdxComponent[] = [
  {
    name: "Box",
    importPath: BUILT_IN_IMPORT_PATH,
    builtIn: true,
    extractedProps: {
      style: { type: "style", required: false },
      children: { type: "rich-text", required: false },
    },
    load: async () => Box,
  },
  {
    name: "Text",
    importPath: BUILT_IN_IMPORT_PATH,
    builtIn: true,
    extractedProps: {
      style: { type: "style", required: false },
      children: { type: "rich-text", required: false },
    },
    load: async () => Text,
  },
  {
    name: "Image",
    importPath: BUILT_IN_IMPORT_PATH,
    builtIn: true,
    extractedProps: {
      src: { type: "string", required: true },
      alt: { type: "string", required: true },
      style: { type: "style", required: false },
    },
    load: async () => Image,
  },
  {
    name: "Link",
    importPath: BUILT_IN_IMPORT_PATH,
    builtIn: true,
    extractedProps: {
      href: { type: "string", required: true },
      style: { type: "style", required: false },
      children: { type: "rich-text", required: false },
    },
    load: async () => Link,
  },
];

export function withBuiltInMdxComponents<
  TComponent extends StudioMdxComponentRegistration,
>(
  components: readonly TComponent[] = [],
): Array<TComponent | StudioBuiltInMdxComponent> {
  const hostComponents = components.filter(
    (component) => !isBuiltInMdxComponentName(component.name),
  );

  return [...STUDIO_BUILT_IN_MDX_COMPONENTS, ...hostComponents];
}

export type BoxProps = {
  style?: MdcmsInlineStyle;
  children?: ReactNode;
};

function Box({ style, children }: BoxProps) {
  return createElement(
    "div",
    { style: style as CSSProperties | undefined },
    children,
  );
}

export type TextProps = {
  style?: MdcmsInlineStyle;
  children?: ReactNode;
};

function Text({ style, children }: TextProps) {
  return createElement(
    "span",
    { style: style as CSSProperties | undefined },
    children,
  );
}

export type ImageProps = {
  src: string;
  alt: string;
  style?: MdcmsInlineStyle;
};

function Image({ src, alt, style }: ImageProps) {
  return createElement("img", {
    src,
    alt,
    style: style as CSSProperties | undefined,
  });
}

export type LinkProps = {
  href: string;
  style?: MdcmsInlineStyle;
  children?: ReactNode;
};

function Link({ href, style, children }: LinkProps) {
  return createElement(
    "a",
    { href, style: style as CSSProperties | undefined },
    children,
  );
}
