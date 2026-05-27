export type EditorToolbarAvailability = "enabled" | "visual-only";

export type EditorToolbarItem = {
  id:
    | "undo"
    | "redo"
    | "bold"
    | "italic"
    | "underline"
    | "strike"
    | "code"
    | "highlight"
    | "heading1"
    | "heading2"
    | "bulletList"
    | "orderedList"
    | "taskList"
    | "blockquote"
    | "codeBlock"
    | "horizontalRule"
    | "image"
    | "link"
    | "table"
    | "insertComponent";
  label: string;
  availability: EditorToolbarAvailability;
};

export type EditorToolbarGroup = {
  id: "history" | "formatting" | "headings" | "lists" | "blocks" | "media";
  items: EditorToolbarItem[];
};

export type EditorToolbarLayout = {
  primaryGroups: EditorToolbarGroup[];
  secondaryItems: EditorToolbarItem[];
};

export function createEditorToolbarLayout(): EditorToolbarLayout {
  return {
    primaryGroups: [
      {
        id: "history",
        items: [
          { id: "undo", label: "Undo", availability: "enabled" },
          { id: "redo", label: "Redo", availability: "enabled" },
        ],
      },
      {
        id: "formatting",
        items: [
          { id: "bold", label: "Bold", availability: "enabled" },
          { id: "italic", label: "Italic", availability: "enabled" },
          { id: "underline", label: "Underline", availability: "enabled" },
          { id: "strike", label: "Strikethrough", availability: "enabled" },
          { id: "code", label: "Inline code", availability: "enabled" },
          { id: "highlight", label: "Highlight", availability: "enabled" },
        ],
      },
      {
        id: "headings",
        items: [
          { id: "heading1", label: "H1", availability: "enabled" },
          { id: "heading2", label: "H2", availability: "enabled" },
        ],
      },
      {
        id: "lists",
        items: [
          { id: "bulletList", label: "Bulleted list", availability: "enabled" },
          {
            id: "orderedList",
            label: "Numbered list",
            availability: "enabled",
          },
          { id: "taskList", label: "Task list", availability: "enabled" },
        ],
      },
      {
        id: "blocks",
        items: [
          { id: "blockquote", label: "Quote", availability: "enabled" },
          { id: "codeBlock", label: "Code block", availability: "enabled" },
          {
            id: "horizontalRule",
            label: "Horizontal rule",
            availability: "enabled",
          },
        ],
      },
      {
        id: "media",
        items: [
          { id: "image", label: "Insert image", availability: "enabled" },
          { id: "link", label: "Insert link", availability: "enabled" },
          { id: "table", label: "Insert table", availability: "visual-only" },
        ],
      },
    ],
    secondaryItems: [
      {
        id: "insertComponent",
        label: "Add block",
        availability: "enabled",
      },
    ],
  };
}
