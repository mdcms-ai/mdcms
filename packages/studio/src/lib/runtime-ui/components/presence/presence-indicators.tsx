"use client";

import type { CollaborationPresenceUser } from "@mdcms/shared";

import { cn } from "../../lib/utils.js";
import { Avatar, AvatarFallback } from "../ui/avatar.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip.js";

export type PresenceIndicatorsProps = {
  users: CollaborationPresenceUser[];
  maxVisible?: number;
  className?: string;
};

function getPresenceInitials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  const initials =
    parts.length >= 2
      ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`
      : (parts[0] ?? label).slice(0, 2);

  return initials.toUpperCase() || "?";
}

function getPresenceLabel(user: CollaborationPresenceUser): string {
  return `${user.label} ${user.mode === "edit" ? "editing" : "viewing"}`;
}

export function PresenceIndicators({
  users,
  maxVisible = 3,
  className,
}: PresenceIndicatorsProps) {
  if (users.length === 0) {
    return null;
  }

  const visibleUsers = users.slice(0, maxVisible);
  const hiddenCount = Math.max(0, users.length - visibleUsers.length);

  return (
    <TooltipProvider delayDuration={150}>
      <div
        data-mdcms-presence-indicators="true"
        className={cn("flex h-5 items-center -space-x-1.5", className)}
      >
        {visibleUsers.map((user) => {
          const label = getPresenceLabel(user);

          return (
            <Tooltip key={user.sessionId}>
              <TooltipTrigger asChild>
                <span
                  role="img"
                  aria-label={label}
                  title={label}
                  data-mdcms-presence-mode={user.mode}
                  data-mdcms-presence-session={user.sessionId}
                  className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-card bg-card ring-1 ring-background"
                >
                  <Avatar className="size-5">
                    <AvatarFallback
                      className="text-[8px] font-bold text-white"
                      style={{ backgroundColor: user.color }}
                    >
                      {getPresenceInitials(user.label)}
                    </AvatarFallback>
                  </Avatar>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">{label}</TooltipContent>
            </Tooltip>
          );
        })}
        {hiddenCount > 0 && (
          <span
            aria-label={`${hiddenCount} more collaborator${hiddenCount === 1 ? "" : "s"}`}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-card bg-background-subtle font-mono text-[8px] font-bold text-foreground-muted ring-1 ring-background"
          >
            +{hiddenCount}
          </span>
        )}
      </div>
    </TooltipProvider>
  );
}
