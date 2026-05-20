import type { MdxComponentCatalogEntry } from "@mdcms/shared";

const BUILT_IN_IMPORT_PATH = "@mdcms/sdk/react-primitives";

export const BUILT_IN_MDX_COMPONENTS = [
  {
    name: "Box",
    importPath: BUILT_IN_IMPORT_PATH,
    builtIn: true,
    extractedProps: {
      style: { type: "style", required: false },
      children: { type: "rich-text", required: false },
    },
  },
  {
    name: "Text",
    importPath: BUILT_IN_IMPORT_PATH,
    builtIn: true,
    extractedProps: {
      style: { type: "style", required: false },
      children: { type: "rich-text", required: false },
    },
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
  },
] satisfies MdxComponentCatalogEntry[];
