"use client";

import { useRef, useState, type FormEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.js";

export type CreateDocumentDialogProps = {
  isOpen: boolean;
  isSubmitting: boolean;
  error?: string;
  typeDirectory: string;
  localized: boolean;
  locales?: string[];
  onClose: () => void;
  onSubmit: (input: { path: string; locale?: string; title: string }) => void;
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function resolveDirectoryPrefix(typeDirectory: string): string {
  return typeDirectory.endsWith("/") ? typeDirectory : `${typeDirectory}/`;
}

function CreateDocumentForm({
  isSubmitting,
  error,
  typeDirectory,
  localized,
  locales,
  onClose,
  onSubmit,
}: Omit<CreateDocumentDialogProps, "isOpen">) {
  const prefix = resolveDirectoryPrefix(typeDirectory);
  const [title, setTitle] = useState("");
  const [path, setPath] = useState(prefix);
  const [locale, setLocale] = useState<string | undefined>(locales?.[0]);
  const pathEditedRef = useRef(false);

  const hasPrefix = path.startsWith(prefix);
  const slug = hasPrefix ? path.slice(prefix.length) : "";
  const hasValidSlug =
    hasPrefix && slug.trim().length > 0 && !slug.endsWith("/");
  const needsLocale = localized && locales && locales.length > 0;
  const canSubmit =
    title.trim().length > 0 &&
    hasValidSlug &&
    !isSubmitting &&
    (!needsLocale || !!locale);

  const handleTitleChange = (value: string) => {
    setTitle(value);
    if (!pathEditedRef.current) {
      setPath(value ? `${prefix}${slugify(value)}` : prefix);
    }
  };

  const handlePathChange = (value: string) => {
    pathEditedRef.current = true;
    setPath(value);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      path: path.trim(),
      locale: localized ? locale : undefined,
      title: title.trim(),
    });
  };

  return (
    <DialogContent>
      <form onSubmit={handleSubmit}>
        <DialogHeader>
          <DialogTitle>New Document</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="doc-title">Title</Label>
            <Input
              id="doc-title"
              value={title}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="My new document"
              disabled={isSubmitting}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="doc-path">
              Path
              <span className="ml-1 text-xs text-foreground-muted font-normal">
                (auto-generated)
              </span>
            </Label>
            <Input
              id="doc-path"
              value={path}
              onChange={(e) => handlePathChange(e.target.value)}
              placeholder={`${prefix}my-document`}
              disabled={isSubmitting}
            />
            {!hasValidSlug && path.length > 0 && (
              <p className="text-xs text-foreground-muted">
                {!hasPrefix
                  ? `Path must start with "${prefix}".`
                  : "Path needs a document name after the directory prefix."}
              </p>
            )}
          </div>
          {localized && locales && locales.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="doc-locale">Locale</Label>
              <Select
                value={locale}
                onValueChange={setLocale}
                disabled={isSubmitting}
              >
                <SelectTrigger id="doc-locale">
                  <SelectValue placeholder="Select locale" />
                </SelectTrigger>
                <SelectContent>
                  {locales.map((loc) => (
                    <SelectItem key={loc} value={loc}>
                      {loc}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
            disabled={!canSubmit}
          >
            {isSubmitting ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

export function CreateDocumentDialog({
  isOpen,
  isSubmitting,
  error,
  typeDirectory,
  localized,
  locales,
  onClose,
  onSubmit,
}: CreateDocumentDialogProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      {isOpen ? (
        <CreateDocumentForm
          error={error}
          isSubmitting={isSubmitting}
          localized={localized}
          locales={locales}
          onClose={onClose}
          onSubmit={onSubmit}
          typeDirectory={typeDirectory}
        />
      ) : null}
    </Dialog>
  );
}
