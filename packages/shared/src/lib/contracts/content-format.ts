export type ContentFormatValue = "md" | "mdx";

// Opening and closing fences may each be indented zero to three spaces, and
// the closing fence repeats the opening fence character at least as often.
const FENCED_CODE_BLOCK =
  /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm;
const INLINE_CODE = /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;

/**
 * A JSX element whose name starts with a capital letter (`<Cta />`,
 * `<Callout>`, `<Docs.Note>`) that does not directly follow a letter or
 * digit. Inline Markdown markers and punctuation may precede it
 * (`**<Cta />**`, `Hello,<Cta />`), while prose such as `Array<T>` does not
 * count as a component.
 */
const COMPONENT_TAG =
  /(?<![A-Za-z0-9])<[A-Z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*(?=[\s/>])/;

/** An MDX ESM statement: a line that starts with `import ` or `export `. */
const ESM_STATEMENT = /^(?:import|export)\s/m;

const LIST_ITEM_START = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const INDENTED_LINE = /^(?: {4}|\t)/;

/**
 * Removes Markdown indented code blocks: runs of lines indented by four
 * spaces or a tab that start after a blank line (or at the start of the
 * body). Indented lines inside a list are list content, not code, so they are
 * kept.
 */
function stripIndentedCode(text: string): string {
  const lines = text.split("\n");
  let previousBlank = true;
  let inList = false;
  let inCode = false;

  return lines
    .map((line) => {
      const blank = line.trim().length === 0;
      const indented = INDENTED_LINE.test(line);

      if (inCode) {
        if (blank || indented) {
          return "";
        }

        inCode = false;
      }

      if (!blank && indented && previousBlank && !inList) {
        inCode = true;
        previousBlank = false;
        return "";
      }

      if (!blank && !indented) {
        inList = LIST_ITEM_START.test(line);
      }

      previousBlank = blank;
      return line;
    })
    .join("\n");
}

function stripCode(body: string): string {
  return stripIndentedCode(body.replace(FENCED_CODE_BLOCK, "")).replace(
    INLINE_CODE,
    "",
  );
}

/**
 * The format a document body needs: `mdx` when, outside code blocks and code
 * spans, it contains a component element or an ESM `import`/`export`
 * statement; `md` otherwise. Lowercase HTML tags and `{braces}` alone keep a
 * body `md`, because they are valid Markdown.
 *
 * This is the single rule for a document's format. The server stores and
 * returns it, Studio shows it, the renderer compiles with it, and the CLI
 * names local files after it.
 */
export function inferContentFormat(body: string): ContentFormatValue {
  const prose = stripCode(body);

  return COMPONENT_TAG.test(prose) || ESM_STATEMENT.test(prose) ? "mdx" : "md";
}
