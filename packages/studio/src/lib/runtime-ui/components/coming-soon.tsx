"use client";

import { LucideIcon } from "lucide-react";
import { Badge } from "./ui/badge.js";

interface ComingSoonProps {
  icon: LucideIcon;
  title: string;
  description: string;
}

export function ComingSoon({
  icon: Icon,
  title,
  description,
}: ComingSoonProps) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-24">
      <div className="flex max-w-md flex-col items-center text-center">
        <div className="mb-4 flex size-10 items-center justify-center rounded-lg border border-border bg-card">
          <Icon className="size-[18px] text-foreground-muted" />
        </div>
        <h2 className="text-lg font-medium">{title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-foreground-muted">
          {description}
        </p>
        <Badge
          variant="outline"
          className="mt-4 font-normal text-muted-foreground"
        >
          Coming soon
        </Badge>
        <p className="mt-6 text-xs text-foreground-muted">
          Want to help build this?{" "}
          <a
            href="https://github.com/blazity/mdcms"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            Contribute on GitHub
          </a>
        </p>
      </div>
    </div>
  );
}
