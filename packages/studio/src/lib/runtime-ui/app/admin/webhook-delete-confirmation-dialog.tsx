"use client";

import type { WebhookConfig } from "@mdcms/shared";

import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";

export function WebhookDeleteConfirmationDialog({
  config,
  error,
  isDeleting,
  onConfirm,
  onOpenChange,
}: {
  config: WebhookConfig | null;
  error: Error | null;
  isDeleting: boolean;
  onConfirm: (id: string) => Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const errorMessage = error?.message || "Failed to delete webhook.";

  return (
    <Dialog open={config !== null} onOpenChange={onOpenChange}>
      {config && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete webhook</DialogTitle>
            <DialogDescription>
              Delete {config.url}. Delivery history remains available for audit.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {errorMessage}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isDeleting}
              onClick={() => void onConfirm(config.id)}
            >
              {isDeleting ? "Deleting..." : "Delete webhook"}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
