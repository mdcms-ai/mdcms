export type ContentFormatValue = "md" | "mdx";

const FENCED_CODE_BLOCK =
  /^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1\2[`~]*[ \t]*$|(?![\s\S]))/gm;
const INLINE_CODE = /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;

/**
 * A JSX element whose name starts with a capital letter (`<Cta />`,
 * `<Callout>`, `<Docs.Note>`), opening at the start of the text or after
 * whitespace, `>` or `(`. Requiring that boundary keeps prose such as
 * `Array<T>` from counting as a component.
 */
const COMPONENT_TAG =
  /(?:^|[\s>(])<[A-Z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*(?=[\s/>])/;

/** An MDX ESM statement: a line that starts with `import ` or `export `. */
const ESM_STATEMENT = /^(?:import|export)\s/m;

function stripCode(body: string): string {
  return body.replace(FENCED_CODE_BLOCK, "").replace(INLINE_CODE, "");
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
