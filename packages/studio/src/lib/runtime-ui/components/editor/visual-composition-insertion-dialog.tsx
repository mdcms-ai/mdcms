"use client";

import type { StudioMountContext } from "@mdcms/shared";

import {
  MdxPropsEditorHost,
  type PropsEditorValue,
} from "../../../mdx-props-editor-host.js";
import { Button } from "../ui/button.js";
import { validateMdxComponentRequiredProps } from "./visual-composition-commands.js";
import type { VisualCompositionInsertion } from "./visual-composition-types.js";

export type VisualCompositionInsertionDialogProps = {
  context: StudioMountContext;
  pendingInsertion: VisualCompositionInsertion | null;
  value: PropsEditorValue;
  onValueChange: (value: PropsEditorValue) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

export function VisualCompositionInsertionDialog({
  context,
  pendingInsertion,
  value,
  onValueChange,
  onCancel,
  onConfirm,
}: VisualCompositionInsertionDialogProps) {
  if (!pendingInsertion || pendingInsertion.block.kind !== "mdx-component") {
    return null;
  }

  const component = pendingInsertion.block.component;
  const validation = validateMdxComponentRequiredProps(component, value);

  return (
    <section
      data-mdcms-visual-insertion-dialog={component.name}
      className="absolute inset-x-4 bottom-4 z-30 mx-auto max-w-lg rounded-md border border-border bg-card p-4 shadow-[0_24px_60px_-24px_rgba(0,0,0,0.45)]"
    >
      <div className="mb-3 space-y-1">
        <p className="text-sm font-medium text-foreground">
          Configure {component.name}
        </p>
        <p className="text-xs text-foreground-muted">
          Required props must be valid before the block is inserted.
        </p>
        {!validation.valid ? (
          <p
            data-mdcms-visual-insertion-missing-props={component.name}
            className="text-xs text-destructive"
          >
            Missing required props: {validation.missing.join(", ")}
          </p>
        ) : null}
      </div>

      <div className="max-h-80 overflow-y-auto rounded-md border border-border bg-background-subtle p-3">
        <MdxPropsEditorHost
          component={component}
          context={context}
          value={value}
          onChange={(patch) => onValueChange({ ...value, ...patch })}
          readOnly={false}
          forbidden={false}
        />
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={!validation.valid}
          onClick={() => {
            if (validation.valid) {
              onConfirm();
            }
          }}
        >
          Insert block
        </Button>
      </div>
    </section>
  );
}
