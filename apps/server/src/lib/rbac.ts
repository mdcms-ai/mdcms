import { RuntimeError } from "@mdcms/shared";

export const RBAC_ROLES = ["viewer", "editor", "admin", "owner"] as const;

export type RbacRole = (typeof RBAC_ROLES)[number];

export type RbacGlobalScope = {
  kind: "global";
};

export type RbacProjectScope = {
  kind: "project";
  project: string;
};

export type RbacFolderPrefixScope = {
  kind: "folder_prefix";
  project: string;
  environment: string;
  pathPrefix: string;
};

export type RbacGrant =
  | {
      role: "owner" | "admin";
      scope: RbacGlobalScope;
      source?: string;
    }
  | {
      role: "editor" | "viewer";
      scope: RbacGlobalScope | RbacProjectScope | RbacFolderPrefixScope;
      source?: string;
    };

export type RbacResourceTarget = {
  project: string;
  environment?: string;
  path?: string;
};

export type RbacAction =
  | "content:read"
  | "content:read:draft"
  | "content:write"
  | "content:publish"
  | "content:unpublish"
  | "content:delete"
  | "schema:read"
  | "schema:write"
  | "media:read"
  | "media:upload"
  | "media:delete"
  | "projects:read"
  | "projects:write"
  | "user:manage"
  | "settings:manage"
  | "ai:use";

const ROLE_RANK: Record<RbacRole, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

const ROLE_ACTIONS: Record<RbacRole, readonly RbacAction[]> = {
  viewer: ["content:read", "schema:read", "media:read", "projects:read"],
  editor: [
    "content:read",
    "content:read:draft",
    "content:write",
    "content:publish",
    "content:unpublish",
    "content:delete",
    "schema:read",
    "media:read",
    "media:upload",
    "projects:read",
    "ai:use",
  ],
  admin: [
    "content:read",
    "content:read:draft",
    "content:write",
    "content:publish",
    "content:unpublish",
    "content:delete",
    "schema:read",
    "schema:write",
    "media:read",
    "media:upload",
    "media:delete",
    "projects:read",
    "projects:write",
    "user:manage",
    "settings:manage",
    "ai:use",
  ],
  owner: [
    "content:read",
    "content:read:draft",
    "content:write",
    "content:publish",
    "content:unpublish",
    "content:delete",
    "schema:read",
    "schema:write",
    "media:read",
    "media:upload",
    "media:delete",
    "projects:read",
    "projects:write",
    "user:manage",
    "settings:manage",
    "ai:use",
  ],
};

function assertGrantScopeCompatibility(grant: RbacGrant): void {
  if (
    (grant.role === "owner" || grant.role === "admin") &&
    grant.scope.kind !== "global"
  ) {
    throw new RuntimeError({
      code: "INVALID_RBAC_GRANT",
      message: `${grant.role} role must be instance-wide (global scope only).`,
      statusCode: 400,
      details: {
        role: grant.role,
        scopeKind: grant.scope.kind,
      },
    });
  }
}

function normalizePathPrefix(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return "";
  }

  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function collapsePathTraversal(input: string): string {
  const segments: string[] = [];
  for (const segment of input.split("/")) {
    if (segment === "..") {
      segments.pop();
    } else if (segment !== "" && segment !== ".") {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  const normalizedPath = collapsePathTraversal(path.trim().replace(/^\/+/, ""));
  const normalizedPrefix = normalizePathPrefix(prefix).replace(/^\/+/, "");
  if (!normalizedPrefix) {
    return true;
  }

  if (normalizedPath === normalizedPrefix.slice(0, -1)) {
    return true;
  }

  return normalizedPath.startsWith(normalizedPrefix);
}

function isGrantApplicable(
  grant: RbacGrant,
  target: RbacResourceTarget,
): boolean {
  if (grant.scope.kind === "global") {
    return true;
  }

  if (grant.scope.kind === "project") {
    return grant.scope.project === target.project;
  }

  if (
    !target.environment ||
    !target.path ||
    grant.scope.project !== target.project ||
    grant.scope.environment !== target.environment
  ) {
    return false;
  }

  return pathMatchesPrefix(target.path, grant.scope.pathPrefix);
}

function pickHigherRole(left: RbacRole, right: RbacRole): RbacRole {
  return ROLE_RANK[left] >= ROLE_RANK[right] ? left : right;
}

export function evaluateEffectiveRole(
  grants: readonly RbacGrant[],
  target: RbacResourceTarget,
): RbacRole | undefined {
  let best: RbacRole | undefined;

  for (const grant of grants) {
    assertGrantScopeCompatibility(grant);

    if (!isGrantApplicable(grant, target)) {
      continue;
    }

    best = best ? pickHigherRole(best, grant.role) : grant.role;
  }

  return best;
}

export function evaluatePermission(input: {
  grants: readonly RbacGrant[];
  target: RbacResourceTarget;
  action: RbacAction;
}): {
  allowed: boolean;
  effectiveRole?: RbacRole;
} {
  const effectiveRole = evaluateEffectiveRole(input.grants, input.target);

  if (!effectiveRole) {
    return {
      allowed: false,
    };
  }

  return {
    allowed: ROLE_ACTIONS[effectiveRole].includes(input.action),
    effectiveRole,
  };
}

export type OwnerMutationIntent = "remove_owner" | "demote_owner";

export function assertOwnerMutationAllowed(input: {
  activeOwnerCount: number;
  intent: OwnerMutationIntent;
}): void {
  if (input.activeOwnerCount <= 1) {
    throw new RuntimeError({
      code: "OWNER_INVARIANT_VIOLATION",
      message:
        "Cannot remove or demote the last remaining Owner for this instance.",
      statusCode: 409,
      details: {
        activeOwnerCount: input.activeOwnerCount,
        intent: input.intent,
      },
    });
  }
}
