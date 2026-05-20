import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

import { RuntimeError } from "../runtime/error.js";
import { extractMdxComponentProps } from "./extracted-props.js";

const EXTRACT_PROPS_TEST_TIMEOUT_MS = 15_000;

async function withTempDir<T>(
  prefix: string,
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));

  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeComponentFile(
  directory: string,
  filename: string,
  source: string,
): Promise<string> {
  const filePath = join(directory, filename);
  await writeFile(filePath, source, "utf8");
  return filePath;
}

test("extractMdxComponentProps extracts supported prop shapes", async () => {
  await withTempDir("mdcms-extracted-props-", async (directory) => {
    const filePath = await writeComponentFile(
      directory,
      "Chart.tsx",
      `
        type ReactNode = string | number | boolean | null;

        export interface ChartProps {
          title?: string;
          count: number;
          published: boolean;
          kind: "bar" | "line";
          data: number[];
          tags?: string[];
          children?: ReactNode;
        }

        export function Chart(_props: ChartProps) {
          return null;
        }
      `,
    );

    assert.deepEqual(
      extractMdxComponentProps({
        filePath,
        componentName: "Chart",
      }),
      {
        title: { type: "string", required: false },
        count: { type: "number", required: true },
        published: { type: "boolean", required: true },
        kind: { type: "enum", required: true, values: ["bar", "line"] },
        data: { type: "array", required: true, items: "number" },
        tags: { type: "array", required: false, items: "string" },
        children: { type: "rich-text", required: false },
      },
    );
  });
});

test("extractMdxComponentProps omits unsupported prop shapes", async () => {
  await withTempDir("mdcms-extracted-props-", async (directory) => {
    const filePath = await writeComponentFile(
      directory,
      "Widget.tsx",
      `
        type HTMLDivElement = { tag: "div" };
        type Ref<T> = { current: T | null } | ((value: T | null) => void) | null;

        export interface WidgetProps {
          onClick?: () => void;
          forwardedRef?: Ref<HTMLDivElement>;
          options: Record<string, string>;
          pair: [number, number];
        }

        export function Widget(_props: WidgetProps) {
          return null;
        }
      `,
    );

    assert.deepEqual(
      extractMdxComponentProps({
        filePath,
        componentName: "Widget",
      }),
      {},
    );
  });
});

test("extractMdxComponentProps accepts compatible prop hints and preserves extraction output", async () => {
  await withTempDir("mdcms-extracted-props-", async (directory) => {
    const filePath = await writeComponentFile(
      directory,
      "Hero.tsx",
      `
        export interface HeroProps {
          title: string;
          website?: string;
          body: string;
          rating: number;
          imageRef: string;
          variant: "primary" | "secondary";
          options: {
            theme: string;
            compact: boolean;
          };
          hiddenProp: boolean;
        }

        export function Hero(_props: HeroProps) {
          return null;
        }
      `,
    );

    assert.deepEqual(
      extractMdxComponentProps({
        filePath,
        componentName: "Hero",
        propHints: {
          title: { widget: "color-picker" },
          website: { format: "url" },
          body: { widget: "textarea" },
          rating: { widget: "slider", min: 0, max: 10, step: 2 },
          imageRef: { widget: "image" },
          variant: {
            widget: "select",
            options: [
              "primary",
              {
                label: "Secondary",
                value: "secondary",
              },
            ],
          },
          options: { widget: "json" },
          hiddenProp: { widget: "hidden" },
        },
      }),
      {
        title: { type: "string", required: true },
        website: { type: "string", required: false, format: "url" },
        body: { type: "string", required: true },
        rating: { type: "number", required: true },
        imageRef: { type: "string", required: true },
        variant: {
          type: "enum",
          required: true,
          values: ["primary", "secondary"],
        },
        options: { type: "json", required: true },
        hiddenProp: { type: "boolean", required: true },
      },
    );
  });
});

test(
  "extractMdxComponentProps rejects incompatible prop hints deterministically",
  { timeout: EXTRACT_PROPS_TEST_TIMEOUT_MS },
  async () => {
    await withTempDir("mdcms-extracted-props-", async (directory) => {
      const filePath = await writeComponentFile(
        directory,
        "LinkCard.tsx",
        `
          export interface LinkCardProps {
            title: string;
            website?: string;
            count: number;
            publishedAt: Date;
            kind: "bar" | "line";
            tags: string[];
            children: string;
            handlerMap: Record<string, () => void>;
          }

          export function LinkCard(_props: LinkCardProps) {
            return null;
          }
        `,
      );

      assert.throws(
        () =>
          extractMdxComponentProps({
            filePath,
            componentName: "LinkCard",
            propHints: {
              missing: { widget: "hidden" },
            },
          }),
        (error: unknown) =>
          error instanceof RuntimeError &&
          error.code === "INVALID_CONFIG" &&
          error.message.includes("missing"),
      );

      assert.throws(
        () =>
          extractMdxComponentProps({
            filePath,
            componentName: "LinkCard",
            propHints: {
              count: { format: "url" },
            },
          }),
        (error: unknown) =>
          error instanceof RuntimeError &&
          error.code === "INVALID_CONFIG" &&
          error.message.includes("count"),
      );

      assert.throws(
        () =>
          extractMdxComponentProps({
            filePath,
            componentName: "LinkCard",
            propHints: {
              publishedAt: { widget: "json" },
            },
          }),
        (error: unknown) =>
          error instanceof RuntimeError &&
          error.code === "INVALID_CONFIG" &&
          error.message.includes("publishedAt"),
      );

      assert.throws(
        () =>
          extractMdxComponentProps({
            filePath,
            componentName: "LinkCard",
            propHints: {
              kind: {
                widget: "select",
                options: ["bar", 1],
              },
            },
          }),
        (error: unknown) =>
          error instanceof RuntimeError &&
          error.code === "INVALID_CONFIG" &&
          error.message.includes("kind"),
      );

      assert.throws(
        () =>
          extractMdxComponentProps({
            filePath,
            componentName: "LinkCard",
            propHints: {
              handlerMap: { widget: "json" },
            },
          }),
        (error: unknown) =>
          error instanceof RuntimeError &&
          error.code === "INVALID_CONFIG" &&
          error.message.includes("handlerMap"),
      );
    });
  },
);

test("extractMdxComponentProps derives requiredness from declared prop types only", async () => {
  await withTempDir("mdcms-extracted-props-", async (directory) => {
    const filePath = await writeComponentFile(
      directory,
      "Optionality.tsx",
      `
        export interface OptionalityProps {
          title: string | undefined;
          subtitle?: string;
        }

        export function Optionality({
          title = "fallback",
          subtitle,
        }: OptionalityProps) {
          return null;
        }
      `,
    );

    assert.deepEqual(
      extractMdxComponentProps({
        filePath,
        componentName: "Optionality",
      }),
      {
        title: { type: "string", required: false },
        subtitle: { type: "string", required: false },
      },
    );
  });
});

test("extractMdxComponentProps does not treat non-ref names containing Ref as refs", async () => {
  await withTempDir("mdcms-extracted-props-", async (directory) => {
    const filePath = await writeComponentFile(
      directory,
      "PreferenceRefCard.tsx",
      `
        export enum PreferenceRef {
          primary = "primary",
          secondary = "secondary",
        }

        export interface PreferenceRefCardProps {
          preferenceRef: PreferenceRef;
        }

        export function PreferenceRefCard(_props: PreferenceRefCardProps) {
          return null;
        }
      `,
    );

    assert.deepEqual(
      extractMdxComponentProps({
        filePath,
        componentName: "PreferenceRefCard",
      }),
      {
        preferenceRef: {
          type: "enum",
          required: true,
          values: ["primary", "secondary"],
        },
      },
    );
  });
});

test("extractMdxComponentProps only treats children as rich text when the type is renderable", async () => {
  await withTempDir("mdcms-extracted-props-", async (directory) => {
    const filePath = await writeComponentFile(
      directory,
      "StructuredChildren.tsx",
      `
        export interface StructuredChildrenProps {
          children: string[];
        }

        export function StructuredChildren(_props: StructuredChildrenProps) {
          return null;
        }
      `,
    );

    assert.deepEqual(
      extractMdxComponentProps({
        filePath,
        componentName: "StructuredChildren",
      }),
      {
        children: { type: "array", required: true, items: "string" },
      },
    );
  });
});

test("extractMdxComponentProps keeps optional string-literal enums", async () => {
  await withTempDir("mdcms-extracted-props-", async (directory) => {
    const filePath = await writeComponentFile(
      directory,
      "OptionalEnum.tsx",
      `
        export interface OptionalEnumProps {
          kind?: "bar" | "line";
        }

        export function OptionalEnum(_props: OptionalEnumProps) {
          return null;
        }
      `,
    );

    assert.deepEqual(
      extractMdxComponentProps({
        filePath,
        componentName: "OptionalEnum",
      }),
      {
        kind: {
          type: "enum",
          required: false,
          values: ["bar", "line"],
        },
      },
    );
  });
});

test("extractMdxComponentProps extracts React inline style props", async () => {
  await withTempDir("mdcms-extracted-props-", async (directory) => {
    const filePath = await writeComponentFile(
      directory,
      "StyledBox.tsx",
      `
        declare namespace React {
          export type CSSProperties = Record<string, string | number>;
        }

        export interface StyledBoxProps {
          style?: React.CSSProperties;
          label: string;
        }

        export function StyledBox(_props: StyledBoxProps) {
          return null;
        }
      `,
    );

    assert.deepEqual(
      extractMdxComponentProps({
        filePath,
        componentName: "StyledBox",
      }),
      {
        style: { type: "style", required: false },
        label: { type: "string", required: true },
      },
    );
  });
});

test("extractMdxComponentProps extracts CSSProperties imported from React", async () => {
  await withTempDir("mdcms-extracted-props-", async (directory) => {
    const reactTypesPath = await writeComponentFile(
      directory,
      "react.d.ts",
      `
        declare module "react" {
          export type CSSProperties = Record<string, string | number>;
        }
      `,
    );
    const filePath = await writeComponentFile(
      directory,
      "StyledText.tsx",
      `
        import type { CSSProperties } from "react";

        export interface StyledTextProps {
          style: CSSProperties;
        }

        export function StyledText(_props: StyledTextProps) {
          return null;
        }
      `,
    );
    const tsconfigPath = join(directory, "tsconfig.json");

    await writeFile(
      tsconfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            jsx: "react-jsx",
            strict: true,
          },
          files: [reactTypesPath, filePath],
        },
        null,
        2,
      ),
      "utf8",
    );

    assert.deepEqual(
      extractMdxComponentProps({
        filePath,
        componentName: "StyledText",
        tsconfigPath,
      }),
      {
        style: { type: "style", required: true },
      },
    );
  });
});

test("extractMdxComponentProps extracts MdcmsInlineStyle props", async () => {
  await withTempDir("mdcms-extracted-props-", async (directory) => {
    const filePath = await writeComponentFile(
      directory,
      "MdcmsStyledBox.tsx",
      `
        type MdcmsInlineStyle = Record<string, string | number>;

        export interface MdcmsStyledBoxProps {
          style?: MdcmsInlineStyle;
        }

        export function MdcmsStyledBox(_props: MdcmsStyledBoxProps) {
          return null;
        }
      `,
    );

    assert.deepEqual(
      extractMdxComponentProps({
        filePath,
        componentName: "MdcmsStyledBox",
      }),
      {
        style: { type: "style", required: false },
      },
    );
  });
});

test("extractMdxComponentProps omits arbitrary style-shaped object props", async () => {
  await withTempDir("mdcms-extracted-props-", async (directory) => {
    const filePath = await writeComponentFile(
      directory,
      "StyledPanel.tsx",
      `
        export interface StyledPanelProps {
          style?: Record<string, string | number>;
          sx?: Record<string, string | number>;
        }

        export function StyledPanel(_props: StyledPanelProps) {
          return null;
        }
      `,
    );

    assert.deepEqual(
      extractMdxComponentProps({
        filePath,
        componentName: "StyledPanel",
      }),
      {},
    );
  });
});

test("extractMdxComponentProps omits incompatible MdcmsInlineStyle aliases", async () => {
  await withTempDir("mdcms-extracted-props-", async (directory) => {
    const filePath = await writeComponentFile(
      directory,
      "BrokenMdcmsStyledBox.tsx",
      `
        type MdcmsInlineStyle = Record<string, boolean>;

        export interface BrokenMdcmsStyledBoxProps {
          style?: MdcmsInlineStyle;
        }

        export function BrokenMdcmsStyledBox(_props: BrokenMdcmsStyledBoxProps) {
          return null;
        }
      `,
    );

    assert.deepEqual(
      extractMdxComponentProps({
        filePath,
        componentName: "BrokenMdcmsStyledBox",
      }),
      {},
    );
  });
});

test("extractMdxComponentProps reads props from exported class components", async () => {
  await withTempDir("mdcms-extracted-props-", async (directory) => {
    const filePath = await writeComponentFile(
      directory,
      "ClassChart.tsx",
      `
        class Component<Props> {
          props!: Props;
        }

        export interface ClassChartProps {
          title: string;
        }

        export class ClassChart extends Component<ClassChartProps> {}
      `,
    );

    assert.deepEqual(
      extractMdxComponentProps({
        filePath,
        componentName: "ClassChart",
      }),
      {
        title: { type: "string", required: true },
      },
    );
  });
});

test("extractMdxComponentProps honors tsconfigPath when loading compiler options", async () => {
  await withTempDir("mdcms-extracted-props-", async (directory) => {
    const filePath = await writeComponentFile(
      directory,
      "ConfiguredChart.tsx",
      `
        export interface ConfiguredChartProps {
          title?: string;
        }

        export function ConfiguredChart(_props: ConfiguredChartProps) {
          return null;
        }
      `,
    );
    const tsconfigPath = join(directory, "tsconfig.json");

    await writeFile(
      tsconfigPath,
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            jsx: "react-jsx",
            strict: true,
          },
          include: ["./ConfiguredChart.tsx"],
        },
        null,
        2,
      ),
      "utf8",
    );

    assert.deepEqual(
      extractMdxComponentProps({
        filePath,
        componentName: "ConfiguredChart",
        tsconfigPath,
      }),
      {
        title: { type: "string", required: false },
      },
    );
  });
});

test("extractMdxComponentProps falls back to a default export when names do not match", async () => {
  await withTempDir("mdcms-extracted-props-", async (directory) => {
    const filePath = await writeComponentFile(
      directory,
      "DefaultChart.tsx",
      `
        interface DefaultChartProps {
          title?: string;
        }

        export default function DefaultChart(_props: DefaultChartProps) {
          return null;
        }
      `,
    );

    assert.deepEqual(
      extractMdxComponentProps({
        filePath,
        componentName: "Chart",
      }),
      {
        title: { type: "string", required: false },
      },
    );
  });
});

test("extractMdxComponentProps falls back to the only exported callable when names do not match", async () => {
  await withTempDir("mdcms-extracted-props-", async (directory) => {
    const filePath = await writeComponentFile(
      directory,
      "HeroModule.tsx",
      `
        interface MarketingHeroProps {
          title?: string;
        }

        export function MarketingHero(_props: MarketingHeroProps) {
          return null;
        }
      `,
    );

    assert.deepEqual(
      extractMdxComponentProps({
        filePath,
        componentName: "Hero",
      }),
      {
        title: { type: "string", required: false },
      },
    );
  });
});
