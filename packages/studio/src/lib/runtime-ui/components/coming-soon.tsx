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
    <div className="relative flex flex-col items-center justify-center py-24">
      {/* Large watermark icon */}
      <Icon className="absolute size-64 text-foreground/[0.02] pointer-events-none" />

      <div className="relative z-10 flex flex-col items-center text-center max-w-md">
        <div className="mb-5 flex size-12 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="size-6 text-primary" />
        </div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
          {description}
        </p>
        <Badge
          variant="outline"
          className="mt-4 font-normal text-muted-foreground"
        >
          Coming soon
        </Badge>
        <p className="mt-6 text-xs text-muted-foreground/60">
          Want to help build this?{" "}
          <a
            href="https://github.com/blazity/mdcms"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary/70 hover:text-primary hover:underline"
          >
            Contribute on GitHub
          </a>
        </p>
      </div>
    </div>
  );
}
