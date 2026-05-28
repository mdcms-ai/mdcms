"use client";

import { type ReactNode, useReducer, useState } from "react";
import {
  AlertCircle,
  Clock,
  Edit,
  Loader2,
  LogOut,
  Mail,
  MoreHorizontal,
  Plus,
  ShieldOff,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { Avatar, AvatarFallback } from "../../components/ui/avatar.js";
import { Input } from "../../components/ui/input.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.js";
import { Label } from "../../components/ui/label.js";
import { PageHeader } from "../../components/layout/page-header.js";
import { useToast } from "../../components/toast.js";
import { useUserList } from "../../hooks/use-user-list.js";
import type { UserWithGrants } from "../../../users-api.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/tooltip.js";
import { cn } from "../../lib/utils.js";
import { useCanManageUsers } from "./capabilities-context.js";
import { useStudioMountInfo } from "./mount-info-context.js";
import {
  canUseOwnerProtectedAction,
  createGrantInput,
  createUpdatedGrants,
  getHighestRole,
  getScopeDisplay,
  type Role,
  type ScopeDisplay,
} from "./users-page-model.js";

const roleConfig = {
  owner: {
    label: "Owner",
    badgeClassName: "bg-foreground text-background border-foreground",
    avatarClassName: "bg-foreground text-background",
  },
  admin: {
    label: "Admin",
    badgeClassName: "bg-primary/10 text-primary border-transparent",
    avatarClassName: "bg-blue-100 text-primary",
  },
  editor: {
    label: "Editor",
    badgeClassName: "bg-background-subtle text-foreground border-transparent",
    avatarClassName: "bg-blue-100 text-primary",
  },
  viewer: {
    label: "Viewer",
    badgeClassName: "bg-transparent text-foreground-muted border-border/80",
    avatarClassName: "bg-blue-100 text-primary",
  },
} as const;

type InviteRole = Exclude<Role, "owner">;

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function deriveInitials(name: string, email: string): string {
  const source = name.trim() || email.trim() || "?";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

function SectionCard({
  eyebrow,
  title,
  hint,
  children,
  className,
}: {
  eyebrow: string;
  title: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-lg border border-card-border bg-card shadow-[0_1px_2px_rgba(0,0,0,.05)]",
        className,
      )}
    >
      <div className="flex items-center gap-3 border-b border-divider px-4 py-3.5 sm:px-[18px]">
        <div className="min-w-0">
          <div className="font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-foreground-muted">
            {eyebrow}
          </div>
          <h2 className="mt-0.5 truncate font-heading text-base font-bold leading-tight text-foreground">
            {title}
          </h2>
        </div>
        {hint ? (
          <span className="ml-auto shrink-0 font-mono text-[11px] text-foreground-muted">
            {hint}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function RoleBadge({ role }: { role: Role }) {
  return (
    <span
      className={cn(
        "inline-flex w-fit shrink-0 items-center rounded-[3px] border px-2 py-[3px] font-mono text-[10px] font-bold leading-none tracking-[0.06em]",
        roleConfig[role].badgeClassName,
      )}
    >
      {roleConfig[role].label}
    </span>
  );
}

function ScopeChip({ display }: { display: ScopeDisplay }) {
  return (
    <span
      title={display.variant === "folder" ? display.title : undefined}
      className={cn(
        "inline-flex max-w-52 items-center truncate rounded-[3px] px-2 py-1 font-mono text-[11px] leading-none",
        display.variant === "full"
          ? "bg-transparent italic text-foreground-muted"
          : "bg-background-subtle text-foreground-muted",
      )}
    >
      {display.label}
    </span>
  );
}

function StatePanel({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-card-border bg-card px-6 py-14 text-center shadow-[0_1px_2px_rgba(0,0,0,.05)]">
      <div className="mx-auto mb-4 grid size-10 place-items-center rounded-full bg-background-subtle text-foreground-muted">
        {icon}
      </div>
      <h2 className="font-heading text-xl font-bold text-foreground">
        {title}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-foreground-muted">
        {description}
      </p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/* ----------------------------------------------------------------- */
/* InviteUserDialog                                                   */
/* ----------------------------------------------------------------- */

type InviteFormState = {
  email: string;
  role: InviteRole;
  pathPrefix: string;
  error: string | null;
};

const initialInviteState: InviteFormState = {
  email: "",
  role: "editor",
  pathPrefix: "",
  error: null,
};

type InviteFormAction =
  | { type: "reset" }
  | { type: "email"; value: string }
  | { type: "role"; value: InviteRole }
  | { type: "path-prefix"; value: string }
  | { type: "error"; message: string | null };

function inviteFormReducer(
  state: InviteFormState,
  action: InviteFormAction,
): InviteFormState {
  switch (action.type) {
    case "reset":
      return initialInviteState;
    case "email":
      return { ...state, email: action.value };
    case "role":
      return { ...state, role: action.value };
    case "path-prefix":
      return { ...state, pathPrefix: action.value };
    case "error":
      return { ...state, error: action.message };
  }
}

function InviteUserDialog({
  open,
  onOpenChange,
  inviteUser,
  isInviting,
  activeProject,
  activeEnvironment,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inviteUser: ReturnType<typeof useUserList>["inviteUser"];
  isInviting: boolean;
  activeProject: string | null;
  activeEnvironment: string | null;
  onInvited: () => void;
}) {
  const [form, dispatch] = useReducer(inviteFormReducer, initialInviteState);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      dispatch({ type: "reset" });
    }
    onOpenChange(nextOpen);
  };

  async function handleInvite() {
    dispatch({ type: "error", message: null });
    try {
      await inviteUser({
        email: form.email,
        grants: [
          createGrantInput({
            role: form.role,
            pathPrefix: form.pathPrefix,
            activeProject,
            activeEnvironment,
          }),
        ],
      });
      onInvited();
      handleOpenChange(false);
    } catch (err) {
      dispatch({
        type: "error",
        message:
          err instanceof Error ? err.message : "Failed to send invitation.",
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button className="rounded-sm shadow-primary-btn">
          <Plus className="size-4" />
          Invite user
        </Button>
      </DialogTrigger>
      <DialogContent className="gap-0 overflow-hidden rounded-lg border-border bg-card p-0 sm:max-w-[480px]">
        <DialogHeader className="px-6 pb-3 pt-5">
          <DialogTitle className="font-heading text-[22px] font-bold leading-tight">
            Invite a new user
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-5 text-foreground-muted">
            Send an invitation to join this CMS instance.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-6 pb-5 pt-2">
          <div className="space-y-1.5">
            <Label
              htmlFor="email"
              className="font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted"
            >
              Email
            </Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-muted" />
              <Input
                id="email"
                type="email"
                placeholder="user@company.com"
                value={form.email}
                onChange={(event) =>
                  dispatch({ type: "email", value: event.target.value })
                }
                className="h-9 rounded-sm border-border bg-background pl-9 text-[13px]"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
              Role
            </Label>
            <Select
              value={form.role}
              onValueChange={(value) =>
                dispatch({ type: "role", value: value as InviteRole })
              }
            >
              <SelectTrigger className="h-9 rounded-sm border-border bg-background text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="editor">Editor</SelectItem>
                <SelectItem value="viewer">Viewer</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {(form.role === "editor" || form.role === "viewer") && (
            <div className="space-y-1.5">
              <Label
                htmlFor="path-prefix"
                className="font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted"
              >
                Folder prefix
              </Label>
              <Input
                id="path-prefix"
                placeholder="e.g. content/blog"
                value={form.pathPrefix}
                onChange={(event) =>
                  dispatch({
                    type: "path-prefix",
                    value: event.target.value,
                  })
                }
                className="h-9 rounded-sm border-border bg-background font-mono text-[12px]"
              />
              <p className="font-mono text-[10px] leading-4 text-foreground-muted">
                Optional. Leave empty for full project access.
              </p>
            </div>
          )}

          {form.error && (
            <p className="rounded-sm bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {form.error}
            </p>
          )}
        </div>
        <DialogFooter className="border-t border-divider bg-background-subtle px-6 py-3">
          <Button
            variant="ghost"
            className="rounded-sm"
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            className="rounded-sm"
            disabled={isInviting || !form.email.trim()}
            onClick={handleInvite}
          >
            {isInviting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Sending
              </>
            ) : (
              "Send invitation"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------------------------------------------- */
/* EditRoleDialog                                                     */
/* ----------------------------------------------------------------- */

export type EditRoleTarget = {
  userId: string;
  userName: string;
  currentRole: Role;
  currentGrants: UserWithGrants["grants"];
};

type EditRoleState = {
  role: Role;
  pathPrefix: string;
  error: string | null;
};

type EditRoleAction =
  | { type: "role"; value: Role }
  | { type: "path-prefix"; value: string }
  | { type: "error"; message: string | null };

function createEditRoleState(target: EditRoleTarget): EditRoleState {
  return {
    role: target.currentRole,
    pathPrefix: target.currentGrants[0]?.pathPrefix ?? "",
    error: null,
  };
}

function editRoleReducer(
  state: EditRoleState,
  action: EditRoleAction,
): EditRoleState {
  switch (action.type) {
    case "role":
      return { ...state, role: action.value };
    case "path-prefix":
      return { ...state, pathPrefix: action.value };
    case "error":
      return { ...state, error: action.message };
  }
}

function EditRoleDialog({
  target,
  ...props
}: {
  target: EditRoleTarget | null;
  onOpenChange: (open: boolean) => void;
  updateGrants: ReturnType<typeof useUserList>["updateGrants"];
  isUpdatingGrants: boolean;
  activeEnvironment: string | null;
  activeProject: string | null;
  onSaved: (userName: string) => void;
}) {
  if (!target) {
    return <Dialog open={false} onOpenChange={props.onOpenChange} />;
  }

  return (
    <EditRoleDialogOpen
      key={`${target.userId}:${target.currentRole}:${target.currentGrants[0]?.pathPrefix ?? ""}`}
      target={target}
      {...props}
    />
  );
}

function EditRoleDialogOpen({
  target,
  onOpenChange,
  updateGrants,
  isUpdatingGrants,
  activeEnvironment,
  activeProject,
  onSaved,
}: {
  target: EditRoleTarget;
  onOpenChange: (open: boolean) => void;
  updateGrants: ReturnType<typeof useUserList>["updateGrants"];
  isUpdatingGrants: boolean;
  activeEnvironment: string | null;
  activeProject: string | null;
  onSaved: (userName: string) => void;
}) {
  const [form, dispatch] = useReducer(
    editRoleReducer,
    target,
    createEditRoleState,
  );

  async function handleSave() {
    dispatch({ type: "error", message: null });
    try {
      await updateGrants(
        target.userId,
        createUpdatedGrants({
          role: form.role,
          pathPrefix: form.pathPrefix,
          currentGrants: target.currentGrants,
          activeProject,
          activeEnvironment,
        }),
      );
      onSaved(target.userName);
      onOpenChange(false);
    } catch (err) {
      dispatch({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to update role.",
      });
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden rounded-lg border-border bg-card p-0 sm:max-w-[480px]">
        <DialogHeader className="px-6 pb-3 pt-5">
          <DialogTitle className="font-heading text-[22px] font-bold leading-tight">
            Edit role
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-5 text-foreground-muted">
            Change the role and scope for {target.userName}.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-6 pb-5 pt-2">
          <div className="space-y-1.5">
            <Label className="font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
              Role
            </Label>
            <Select
              value={form.role}
              onValueChange={(value) =>
                dispatch({ type: "role", value: value as Role })
              }
            >
              <SelectTrigger className="h-9 rounded-sm border-border bg-background text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="owner">Owner</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="editor">Editor</SelectItem>
                <SelectItem value="viewer">Viewer</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {(form.role === "editor" || form.role === "viewer") && (
            <div className="space-y-1.5">
              <Label
                htmlFor="edit-role-path-prefix"
                className="font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted"
              >
                Folder prefix
              </Label>
              <Input
                id="edit-role-path-prefix"
                placeholder="e.g. content/blog"
                value={form.pathPrefix}
                onChange={(event) =>
                  dispatch({
                    type: "path-prefix",
                    value: event.target.value,
                  })
                }
                className="h-9 rounded-sm border-border bg-background font-mono text-[12px]"
              />
              <p className="font-mono text-[10px] leading-4 text-foreground-muted">
                Optional. Leave empty for full project access.
              </p>
            </div>
          )}
          {(form.role === "owner" || form.role === "admin") && (
            <p className="rounded-sm bg-background-subtle px-3 py-2 font-mono text-[10px] leading-4 text-foreground-muted">
              {roleConfig[form.role].label} uses global scope.
            </p>
          )}
          {form.error && (
            <p className="rounded-sm bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {form.error}
            </p>
          )}
        </div>
        <DialogFooter className="border-t border-divider bg-background-subtle px-6 py-3">
          <Button
            variant="ghost"
            className="rounded-sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            className="rounded-sm"
            disabled={isUpdatingGrants}
            onClick={handleSave}
          >
            {isUpdatingGrants ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Saving
              </>
            ) : (
              "Save"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------------------------------------------- */
/* PendingInvitesList                                                 */
/* ----------------------------------------------------------------- */

function PendingInvitesList({
  invites,
  isRevoking,
  onRevoke,
}: {
  invites: ReturnType<typeof useUserList>["pendingInvites"];
  isRevoking: boolean;
  onRevoke: (inviteId: string, email: string) => void;
}) {
  if (invites.length === 0) return null;

  return (
    <SectionCard
      eyebrow="Awaiting acceptance"
      title="Pending invitations"
      hint={formatCount(invites.length, "pending", "pending")}
    >
      <div className="divide-y divide-divider">
        {invites.map((invite) => {
          const role = getHighestRole(invite.grants);
          return (
            <div
              key={invite.id}
              className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-[18px]"
            >
              <div className="grid size-8 shrink-0 place-items-center rounded-full bg-background-subtle text-foreground-muted">
                <Clock className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold text-foreground">
                  {invite.email}
                </p>
                <p className="mt-0.5 font-mono text-[11px] text-foreground-muted">
                  Expires {formatDate(invite.expiresAt)}
                </p>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <RoleBadge role={role} />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-sm text-foreground-muted hover:text-destructive"
                  disabled={isRevoking}
                  aria-label={`Revoke invitation for ${invite.email}`}
                  onClick={() => onRevoke(invite.id, invite.email)}
                >
                  {isRevoking ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <X className="size-4" />
                  )}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

/* ----------------------------------------------------------------- */
/* UsersTable                                                         */
/* ----------------------------------------------------------------- */

function UsersTable({
  users,
  isRemoving,
  isRevokingSessions,
  onEditRole,
  onRevokeSessions,
  onRemoveUser,
}: {
  users: ReturnType<typeof useUserList>["users"];
  isRemoving: boolean;
  isRevokingSessions: boolean;
  onEditRole: (target: EditRoleTarget) => void;
  onRevokeSessions: (userId: string, userName: string) => void;
  onRemoveUser: (userId: string, userName: string) => void;
}) {
  return (
    <SectionCard
      eyebrow="Active members"
      title="Users"
      hint={formatCount(users.length, "entry", "entries")}
    >
      <Table className="min-w-[760px]">
        <TableHeader className="bg-background-subtle">
          <TableRow className="border-divider hover:bg-background-subtle">
            <TableHead className="h-10 px-4 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-foreground-muted">
              User
            </TableHead>
            <TableHead className="h-10 w-28 px-4 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-foreground-muted">
              Role
            </TableHead>
            <TableHead className="h-10 w-48 px-4 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-foreground-muted">
              Scope
            </TableHead>
            <TableHead className="h-10 w-32 px-4 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-foreground-muted">
              Joined
            </TableHead>
            <TableHead className="h-10 w-20 px-4 text-right font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-foreground-muted">
              Actions
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user) => {
            const role = getHighestRole(user.grants);
            const scope = getScopeDisplay(user.grants);
            const canUseProtectedActions = canUseOwnerProtectedAction(role);
            return (
              <TableRow
                key={user.id}
                className="border-divider hover:bg-background-subtle/60"
              >
                <TableCell className="max-w-[280px] px-4 py-3.5">
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar className="size-8 shrink-0">
                      <AvatarFallback
                        className={cn(
                          "font-heading text-[11px] font-bold",
                          roleConfig[role].avatarClassName,
                        )}
                      >
                        {deriveInitials(user.name, user.email)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold text-foreground">
                        {user.name}
                      </p>
                      <p className="truncate text-xs text-foreground-muted">
                        {user.email}
                      </p>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="px-4 py-3.5">
                  <RoleBadge role={role} />
                </TableCell>
                <TableCell className="px-4 py-3.5">
                  <ScopeChip display={scope} />
                </TableCell>
                <TableCell className="px-4 py-3.5 font-mono text-[11px] text-foreground-muted">
                  {formatDate(user.createdAt)}
                </TableCell>
                <TableCell className="px-4 py-3.5 text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="rounded-sm text-foreground-muted"
                        aria-label={`Actions for ${user.name}`}
                      >
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      <TooltipProvider>
                        {canUseProtectedActions ? (
                          <DropdownMenuItem
                            onClick={() =>
                              onEditRole({
                                userId: user.id,
                                userName: user.name,
                                currentRole: role,
                                currentGrants: user.grants,
                              })
                            }
                          >
                            <Edit className="mr-2 size-4" />
                            Edit role
                          </DropdownMenuItem>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="block">
                                <DropdownMenuItem disabled>
                                  <Edit className="mr-2 size-4" />
                                  Edit role
                                </DropdownMenuItem>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="left">
                              Owner role changes must leave at least one active
                              owner.
                            </TooltipContent>
                          </Tooltip>
                        )}
                        <DropdownMenuItem
                          disabled={isRevokingSessions}
                          onClick={() => onRevokeSessions(user.id, user.name)}
                        >
                          <LogOut className="mr-2 size-4" />
                          Revoke sessions
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {canUseProtectedActions ? (
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            disabled={isRemoving}
                            onClick={() => onRemoveUser(user.id, user.name)}
                          >
                            <Trash2 className="mr-2 size-4" />
                            Remove user
                          </DropdownMenuItem>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="block">
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  disabled
                                >
                                  <Trash2 className="mr-2 size-4" />
                                  Remove user
                                </DropdownMenuItem>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="left">
                              Owners cannot be removed. Transfer ownership
                              first.
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </TooltipProvider>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </SectionCard>
  );
}

/* ----------------------------------------------------------------- */
/* UsersPage (orchestrator)                                           */
/* ----------------------------------------------------------------- */

export default function UsersPage() {
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [editRoleTarget, setEditRoleTarget] = useState<EditRoleTarget | null>(
    null,
  );

  const toast = useToast();
  const {
    status,
    users,
    pendingInvites,
    errorMessage,
    refresh,
    inviteUser,
    isInviting,
    removeUser,
    isRemoving,
    revokeSessions,
    isRevokingSessions,
    updateGrants,
    isUpdatingGrants,
    revokeInvite,
    isRevokingInvite,
  } = useUserList();

  const canManageUsers = useCanManageUsers();
  const { project: activeProject, environment: activeEnvironment } =
    useStudioMountInfo();

  if (!canManageUsers) {
    return (
      <div className="min-h-screen bg-background">
        <PageHeader breadcrumbs={[{ label: "Users" }]} />
        <div className="p-6">
          <StatePanel
            icon={<ShieldOff className="size-5" />}
            title="Access denied"
            description="You don't have permission to manage users."
          />
        </div>
      </div>
    );
  }

  async function handleRevokeSessions(userId: string, userName: string) {
    try {
      await revokeSessions(userId);
      toast.success(`Sessions revoked for ${userName}.`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to revoke sessions.",
      );
    }
  }

  async function handleRemoveUser(userId: string, userName: string) {
    const confirmed = window.confirm(
      `Are you sure you want to remove ${userName}? This action cannot be undone.`,
    );
    if (!confirmed) return;
    try {
      await removeUser(userId);
      toast.success(`${userName} has been removed.`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to remove user.",
      );
    }
  }

  async function handleRevokeInvite(inviteId: string, email: string) {
    try {
      await revokeInvite(inviteId);
      toast.success(`Invitation for ${email} has been revoked.`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to revoke invitation.",
      );
    }
  }

  const memberCount = formatCount(users.length, "member", "members");
  const inviteCount = formatCount(
    pendingInvites.length,
    "pending invitation",
    "pending invitations",
  );
  const projectScope = activeProject ?? "current project";

  return (
    <div className="min-h-screen bg-background">
      <PageHeader breadcrumbs={[{ label: "Users" }]} />

      <div className="space-y-5 p-4 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <h1 className="font-heading text-[36px] font-bold leading-[1.05] tracking-normal text-foreground">
              Users
            </h1>
            <p className="mt-1.5 font-mono text-[12px] leading-5 text-foreground-muted">
              {memberCount} · {inviteCount} · scoped to {projectScope}
            </p>
          </div>
          <InviteUserDialog
            open={inviteDialogOpen}
            onOpenChange={setInviteDialogOpen}
            inviteUser={inviteUser}
            isInviting={isInviting}
            activeProject={activeProject}
            activeEnvironment={activeEnvironment}
            onInvited={() => toast.success("Invitation sent successfully.")}
          />
        </div>

        {status === "loading" && (
          <StatePanel
            icon={<Loader2 className="size-5 animate-spin" />}
            title="Loading users"
            description="Fetching members and pending invitations for this project."
          />
        )}

        {status === "error" && (
          <StatePanel
            icon={<AlertCircle className="size-5 text-destructive" />}
            title="Failed to load users"
            description={errorMessage ?? "Failed to load users."}
            action={
              <Button variant="ghost" className="rounded-sm" onClick={refresh}>
                Try again
              </Button>
            }
          />
        )}

        {status !== "error" && (
          <PendingInvitesList
            invites={pendingInvites}
            isRevoking={isRevokingInvite}
            onRevoke={handleRevokeInvite}
          />
        )}

        {status === "empty" && (
          <StatePanel
            icon={<Users className="size-5" />}
            title="No users found"
            description="Invite someone to give them access to this project."
          />
        )}

        {status === "ready" && (
          <UsersTable
            users={users}
            isRemoving={isRemoving}
            isRevokingSessions={isRevokingSessions}
            onEditRole={setEditRoleTarget}
            onRevokeSessions={handleRevokeSessions}
            onRemoveUser={handleRemoveUser}
          />
        )}

        <EditRoleDialog
          target={editRoleTarget}
          onOpenChange={(open) => {
            if (!open) setEditRoleTarget(null);
          }}
          updateGrants={updateGrants}
          isUpdatingGrants={isUpdatingGrants}
          activeEnvironment={activeEnvironment}
          activeProject={activeProject}
          onSaved={(userName) => toast.success(`Role updated for ${userName}.`)}
        />
      </div>
    </div>
  );
}
