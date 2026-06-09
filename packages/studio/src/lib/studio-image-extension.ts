import { Node, mergeAttributes, type JSONContent } from "@tiptap/core";

type ImageMarkdownToken = {
  href?: string;
  src?: string;
  title?: string | null;
  text?: string;
  alt?: string | null;
};

function createMarkdownImageLabel(value: unknown): string {
  return String(value ?? "").replace(/[\\[\]]/g, "\\$&");
}

function createMarkdownImageDestination(value: unknown): string {
  return String(value ?? "").replace(
    /[\s()<>\\]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

function createMarkdownImageTitle(value: unknown): string {
  return String(value ?? "").replace(/["\\]/g, "\\$&");
}

function renderMarkdownImage(node: JSONContent): string {
  const attrs = node.attrs ?? {};
  const label = createMarkdownImageLabel(attrs.alt);
  const destination = createMarkdownImageDestination(attrs.src);
  const title =
    typeof attrs.title === "string" && attrs.title.length > 0
      ? ` "${createMarkdownImageTitle(attrs.title)}"`
      : "";

  return `![${label}](${destination}${title})`;
}

export const StudioImageExtension = Node.create({
  name: "image",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      src: {
        default: "",
      },
      alt: {
        default: "",
      },
      title: {
        default: null,
      },
    };
  },

  parseHTML() {
    return [{ tag: "img[src]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes)];
  },

  markdownTokenName: "image",

  parseMarkdown(token, helpers) {
    const imageToken = token as unknown as ImageMarkdownToken;

    return helpers.createNode("image", {
      src: imageToken.href ?? imageToken.src ?? "",
      alt: imageToken.text ?? imageToken.alt ?? "",
      title: imageToken.title ?? null,
    });
  },

  renderMarkdown(node) {
    return renderMarkdownImage(node);
  },
});
