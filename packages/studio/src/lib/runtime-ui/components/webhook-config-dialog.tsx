"use client";

import type {
  WebhookConfig,
  WebhookCreateInput,
  WebhookUpdateInput,
} from "@mdcms/shared";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";
import { WebhookConfigForm } from "./webhook-config-form.js";

export {
  WebhookConfigDialogError,
  WebhookConfigForm,
  buildWebhookConfigCreateInput,
  buildWebhookConfigUpdateInput,
  createInitialWebhookConfigDialogFormState,
  generateWebhookSigningSecret,
  getWebhookConfigDialogErrorMessage,
  isWebhookConfigDialogSubmittable,
  webhookConfigDialogFormReducer,
} from "./webhook-config-form.js";

export type {
  CreateInitialWebhookConfigDialogFormStateOptions,
  WebhookConfigCreateFormProps,
  WebhookConfigDialogFormAction,
  WebhookConfigDialogFormState,
  WebhookConfigDialogMode,
  WebhookConfigEditFormProps,
  WebhookConfigFormProps,
  WebhookSigningSecretRandomValues,
} from "./webhook-config-form.js";

type WebhookConfigDialogBaseProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isSubmitting: boolean;
  error: Error | null;
};

export type WebhookConfigCreateDialogProps = WebhookConfigDialogBaseProps & {
  mode: "create";
  onSubmit: (input: WebhookCreateInput) => Promise<unknown>;
};

export type WebhookConfigEditDialogProps = WebhookConfigDialogBaseProps & {
  mode: "edit";
  config: WebhookConfig | null;
  onSubmit: (input: WebhookUpdateInput) => Promise<unknown>;
};

export type WebhookConfigDialogProps =
  | WebhookConfigCreateDialogProps
  | WebhookConfigEditDialogProps;

export function WebhookConfigDialog(props: WebhookConfigDialogProps) {
  const { mode, open, onOpenChange } = props;
  const config = mode === "edit" ? props.config : null;

  const title = mode === "create" ? "Create webhook" : "Edit webhook";
  const description =
    mode === "create"
      ? "Add an HTTPS endpoint for selected MDCMS events."
      : "Update the endpoint, events, active state, or rotate the signing secret.";

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-mdcms-webhook-dialog-content
        className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-2xl"
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {mode === "create" ? (
          <WebhookConfigForm
            mode="create"
            onSubmit={props.onSubmit}
            onCancel={() => handleOpenChange(false)}
            onSubmitted={() => handleOpenChange(false)}
            isSubmitting={props.isSubmitting}
            error={props.error}
            formClassName="flex min-h-0 flex-1 flex-col"
            bodyClassName="-mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1 py-4"
            footerClassName="shrink-0 pt-2"
            useDialogFooter
            dataScope="dialog"
          />
        ) : (
          <WebhookConfigForm
            mode="edit"
            config={config}
            onSubmit={props.onSubmit}
            onCancel={() => handleOpenChange(false)}
            onSubmitted={() => handleOpenChange(false)}
            isSubmitting={props.isSubmitting}
            error={props.error}
            formClassName="flex min-h-0 flex-1 flex-col"
            bodyClassName="-mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1 py-4"
            footerClassName="shrink-0 pt-2"
            useDialogFooter
            dataScope="dialog"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
