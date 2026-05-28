import type { InviteUserInput, UserWithGrants } from "../../../users-api.js";

const ROLE_RANK = {
  owner: 3,
  admin: 2,
  editor: 1,
  viewer: 0,
} as const;

export type Role = keyof typeof ROLE_RANK;
type GrantInput = InviteUserInput["grants"][number];

export type ScopeDisplay =
  | { label: string; variant: "full" }
  | { label: string; variant: "folder"; title: string };

function normalizeRole(role: string): Role {
  return role in ROLE_RANK ? (role as Role) : "viewer";
}

export function getHighestRole(grants: ReadonlyArray<{ role: string }>): Role {
  let highest: Role = "viewer";
  for (const grant of grants) {
    const role = normalizeRole(grant.role);
    if (ROLE_RANK[role] > ROLE_RANK[highest]) {
      highest = role;
    }
  }
  return highest;
}

export function getScopeDisplay(
  grants: ReadonlyArray<{ pathPrefix?: string | null }>,
): ScopeDisplay {
  const pathPrefixes = grants.flatMap((grant) => {
    const prefix = grant.pathPrefix?.trim();
    return prefix ? [prefix] : [];
  });

  if (pathPrefixes.length === 0) {
    return { label: "Full project", variant: "full" };
  }

  if (pathPrefixes.length === 1) {
    return {
      label: pathPrefixes[0]!,
      variant: "folder",
      title: pathPrefixes[0]!,
    };
  }

  return {
    label: `${pathPrefixes[0]} +${pathPrefixes.length - 1}`,
    variant: "folder",
    title: pathPrefixes.join(", "),
  };
}

export function canUseOwnerProtectedAction(role: Role): boolean {
  return role !== "owner";
}

export function createGrantInput({
  role,
  pathPrefix,
  activeProject,
  activeEnvironment,
  fallbackProject,
}: {
  role: Role;
  pathPrefix: string;
  activeProject: string | null;
  activeEnvironment: string | null;
  fallbackProject?: string | null;
}): GrantInput {
  if (role === "owner" || role === "admin") {
    return {
      role,
      scopeKind: "global",
    };
  }

  const project = fallbackProject ?? activeProject ?? undefined;
  const trimmedPathPrefix = pathPrefix.trim();

  if (trimmedPathPrefix && activeEnvironment && project) {
    return {
      role,
      scopeKind: "folder_prefix",
      project,
      environment: activeEnvironment,
      pathPrefix: trimmedPathPrefix,
    };
  }

  return {
    role,
    scopeKind: "project",
    ...(project ? { project } : {}),
  };
}

function toGrantInput(grant: UserWithGrants["grants"][number]): GrantInput {
  const role = normalizeRole(grant.role);
  const scopeKind =
    grant.scopeKind === "global" ||
    grant.scopeKind === "project" ||
    grant.scopeKind === "folder_prefix"
      ? grant.scopeKind
      : "project";

  if (role === "owner" || role === "admin" || scopeKind === "global") {
    return { role, scopeKind: "global" };
  }

  if (scopeKind === "folder_prefix") {
    return {
      role,
      scopeKind,
      ...(grant.project ? { project: grant.project } : {}),
      ...(grant.environment ? { environment: grant.environment } : {}),
      ...(grant.pathPrefix ? { pathPrefix: grant.pathPrefix } : {}),
    };
  }

  return {
    role,
    scopeKind: "project",
    ...(grant.project ? { project: grant.project } : {}),
  };
}

export function createUpdatedGrants({
  role,
  pathPrefix,
  currentGrants,
  activeProject,
  activeEnvironment,
}: {
  role: Role;
  pathPrefix: string;
  currentGrants: UserWithGrants["grants"];
  activeProject: string | null;
  activeEnvironment: string | null;
}): InviteUserInput["grants"] {
  const editedGrant = createGrantInput({
    role,
    pathPrefix,
    activeProject,
    activeEnvironment,
    fallbackProject: currentGrants[0]?.project ?? null,
  });

  if (currentGrants.length <= 1) {
    return [editedGrant];
  }

  return [editedGrant, ...currentGrants.slice(1).map(toGrantInput)];
}
