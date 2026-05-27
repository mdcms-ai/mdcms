"use client";

import { useReducer, useState } from "react";
import {
  Plus,
  MoreHorizontal,
  Mail,
  Edit,
  ShieldOff,
  Trash2,
  LogOut,
  Loader2,
  AlertCircle,
  Users,
  X,
  Clock,
} from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { Badge } from "../../components/ui/badge.js";
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

const roleConfig = {
  owner: {
    label: "Owner",
    className: "bg-primary/10 text-primary border-primary/20",
  },
  admin: {
    label: "Admin",
    className: "bg-foreground/10 text-foreground border-foreground/20",
  },
  editor: {
    label: "Editor",
    className: "bg-border text-foreground-muted border-border",
  },
  viewer: {
    label: "Viewer",
    className: "bg-transparent text-foreground-muted border-border",
  },
};

type Role = keyof typeof roleConfig;

function getHighestRole(grants: UserWithGrants["grants"]): Role {
  const roleRank: Record<Role, number> = {
    owner: 3,
    admin: 2,
    editor: 1,
    viewer: 0,
  };
  let highest: Role = "viewer";
  for (const grant of grants) {
    const role = grant.role as Role;
    if (roleRank[role] !== undefined && roleRank[role] > roleRank[highest]) {
      highest = role;
    }
  }
  return highest;
}

function getScopeLabel(grants: UserWithGrants["grants"]): string {
  const pathPrefixes = grants.flatMap((g) =>
    g.pathPrefix ? [g.pathPrefix] : [],
  );
  if (pathPrefixes.length > 0) {
    return pathPrefixes.length === 1
      ? pathPrefixes[0]!
      : `${pathPrefixes[0]} +${pathPrefixes.length - 1}`;
  }
  return "Full project";
}

function formatJoinedDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/* ----------------------------------------------------------------- */
/* InviteUserDialog                                                   */
/* ----------------------------------------------------------------- */

type InviteFormState = {
  email: string;
  role: string;
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
  | { type: "field"; field: "email" | "role" | "pathPrefix"; value: string }
  | { type: "error"; message: string | null };

function inviteFormReducer(
  state: InviteFormState,
  action: InviteFormAction,
): InviteFormState {
  switch (action.type) {
    case "reset":
      return initialInviteState;
    case "field":
      return { ...state, [action.field]: action.value };
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
      const useFolderPrefix = form.pathPrefix && activeEnvironment;
      await inviteUser({
        email: form.email,
        grants: [
          {
            role: form.role,
            scopeKind:
              form.role === "admin"
                ? "global"
                : useFolderPrefix
                  ? "folder_prefix"
                  : "project",
            project:
              form.role === "admin" ? undefined : activeProject || undefined,
            environment:
              form.role === "admin"
                ? undefined
                : useFolderPrefix
                  ? activeEnvironment
                  : undefined,
            pathPrefix:
              form.role === "admin"
                ? undefined
                : useFolderPrefix
                  ? form.pathPrefix
                  : undefined,
          },
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
        <Button>
          <Plus className="mr-2 size-4" />
          Invite User
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a new user</DialogTitle>
          <DialogDescription>
            Send an invitation to join this CMS instance
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-muted" />
              <Input
                id="email"
                type="email"
                placeholder="user@company.com"
                value={form.email}
                onChange={(e) =>
                  dispatch({
                    type: "field",
                    field: "email",
                    value: e.target.value,
                  })
                }
                className="pl-9"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Role</Label>
            <Select
              value={form.role}
              onValueChange={(value) =>
                dispatch({ type: "field", field: "role", value })
              }
            >
              <SelectTrigger>
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
            <div className="space-y-2">
              <Label htmlFor="path-prefix">Folder prefix (optional)</Label>
              <Input
                id="path-prefix"
                placeholder="e.g. content/blog"
                value={form.pathPrefix}
                onChange={(e) =>
                  dispatch({
                    type: "field",
                    field: "pathPrefix",
                    value: e.target.value,
                  })
                }
                className="font-mono"
              />
              <p className="text-xs text-foreground-muted">
                Restricts access to content under this path only. Leave empty
                for full project access.
              </p>
            </div>
          )}

          {form.error && (
            <p className="text-sm text-destructive">{form.error}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={isInviting || !form.email} onClick={handleInvite}>
            {isInviting ? "Sending..." : "Send Invitation"}
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
  role: string;
  pathPrefix: string;
  error: string | null;
};

type EditRoleAction =
  | { type: "role-change"; value: string }
  | { type: "path-prefix-change"; value: string }
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
    case "role-change":
      return { ...state, role: action.value };
    case "path-prefix-change":
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
    const useFolderPrefix = form.pathPrefix && activeEnvironment;
    const editedGrant = {
      role: form.role,
      scopeKind:
        form.role === "admin"
          ? "global"
          : useFolderPrefix
            ? "folder_prefix"
            : "project",
      project:
        form.role === "admin"
          ? undefined
          : (target.currentGrants[0]?.project ?? activeProject ?? undefined),
      environment:
        form.role === "admin"
          ? undefined
          : useFolderPrefix
            ? activeEnvironment
            : undefined,
      pathPrefix:
        form.role === "admin"
          ? undefined
          : useFolderPrefix
            ? form.pathPrefix
            : undefined,
    };
    const updatedGrants =
      target.currentGrants.length > 1
        ? [
            editedGrant,
            ...target.currentGrants.slice(1).map((g) => ({
              role: g.role,
              scopeKind: g.scopeKind,
              project: g.project ?? undefined,
              environment: g.environment ?? undefined,
              pathPrefix: g.pathPrefix ?? undefined,
            })),
          ]
        : [editedGrant];
    dispatch({ type: "error", message: null });
    try {
      await updateGrants(target.userId, updatedGrants);
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit role</DialogTitle>
          <DialogDescription>
            Change the role for {target?.userName}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Role</Label>
            <Select
              value={form.role}
              onValueChange={(value) =>
                dispatch({ type: "role-change", value })
              }
            >
              <SelectTrigger>
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
            <div className="space-y-2">
              <Label htmlFor="edit-role-path-prefix">
                Folder prefix (optional)
              </Label>
              <Input
                id="edit-role-path-prefix"
                placeholder="e.g. content/blog"
                value={form.pathPrefix}
                onChange={(e) =>
                  dispatch({
                    type: "path-prefix-change",
                    value: e.target.value,
                  })
                }
                className="font-mono"
              />
              <p className="text-xs text-foreground-muted">
                Restricts access to content under this path only. Leave empty
                for full project access.
              </p>
            </div>
          )}
          {form.error && (
            <p className="text-sm text-destructive">{form.error}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={isUpdatingGrants} onClick={handleSave}>
            {isUpdatingGrants ? "Saving..." : "Save"}
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
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-foreground-muted">
        Pending Invitations ({invites.length})
      </h2>
      <div className="rounded-lg border border-border divide-y divide-border">
        {invites.map((invite) => (
          <div
            key={invite.id}
            className="flex items-center justify-between px-4 py-3"
          >
            <div className="flex items-center gap-3">
              <div className="flex size-8 items-center justify-center rounded-full bg-background-subtle">
                <Clock className="size-4 text-foreground-muted" />
              </div>
              <div>
                <p className="text-sm font-medium">{invite.email}</p>
                <p className="text-xs text-foreground-muted">
                  Expires {formatJoinedDate(invite.expiresAt)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">
                {invite.grants[0]?.role ?? "editor"}
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-foreground-muted hover:text-destructive"
                disabled={isRevoking}
                onClick={() => onRevoke(invite.id, invite.email)}
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
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
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead className="w-28">Role</TableHead>
            <TableHead className="w-32">Scope</TableHead>
            <TableHead className="w-28">Joined</TableHead>
            <TableHead className="w-14"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user) => {
            const role = getHighestRole(user.grants);
            return (
              <TableRow key={user.id}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Avatar className="size-8">
                      <AvatarFallback>
                        {user.name
                          .split(" ")
                          .map((n) => n[0])
                          .join("")}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-medium">{user.name}</p>
                      <p className="text-sm text-foreground-muted">
                        {user.email}
                      </p>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={cn("text-xs", roleConfig[role].className)}
                  >
                    {roleConfig[role].label}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-foreground-muted">
                  {getScopeLabel(user.grants)}
                </TableCell>
                <TableCell className="text-sm text-foreground-muted">
                  {formatJoinedDate(user.createdAt)}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-8">
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <TooltipProvider>
                        <DropdownMenuItem
                          disabled={role === "owner"}
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
                        <DropdownMenuItem
                          disabled={isRevokingSessions}
                          onClick={() => onRevokeSessions(user.id, user.name)}
                        >
                          <LogOut className="mr-2 size-4" />
                          Revoke sessions
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {role === "owner" ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="w-full">
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
                              <p>
                                Owners cannot be removed. Transfer ownership
                                first.
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            disabled={isRemoving}
                            onClick={() => onRemoveUser(user.id, user.name)}
                          >
                            <Trash2 className="mr-2 size-4" />
                            Remove user
                          </DropdownMenuItem>
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
    </div>
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
      <div className="min-h-screen">
        <PageHeader breadcrumbs={[{ label: "Users" }]} />
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <ShieldOff className="mb-4 size-8 text-foreground-muted" />
          <h3 className="mb-2 text-lg font-semibold">Access denied</h3>
          <p className="text-sm text-foreground-muted">
            You don&apos;t have permission to manage users.
          </p>
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

  return (
    <div className="min-h-screen">
      <PageHeader breadcrumbs={[{ label: "Users" }]} />

      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Users</h1>
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
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-6 animate-spin text-foreground-muted" />
          </div>
        )}

        {status === "error" && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <AlertCircle className="mb-4 size-8 text-destructive" />
            <h3 className="mb-2 text-lg font-semibold">Failed to load users</h3>
            <p className="mb-4 text-sm text-foreground-muted">{errorMessage}</p>
            <Button variant="ghost" onClick={refresh}>
              Try again
            </Button>
          </div>
        )}

        {status === "empty" && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 rounded-full bg-background-subtle p-4">
              <Users className="size-8 text-foreground-muted" />
            </div>
            <h3 className="mb-2 text-lg font-semibold">No users found</h3>
            <p className="text-sm text-foreground-muted">
              Invite someone to get started.
            </p>
          </div>
        )}

        <PendingInvitesList
          invites={pendingInvites}
          isRevoking={isRevokingInvite}
          onRevoke={handleRevokeInvite}
        />

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
