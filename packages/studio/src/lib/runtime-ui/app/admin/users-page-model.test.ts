import assert from "node:assert/strict";
import { test } from "bun:test";

import type { UserWithGrants } from "../../../users-api.js";
import { createUpdatedGrants } from "./users-page-model.js";

function grant(
  overrides: Partial<UserWithGrants["grants"][number]>,
): UserWithGrants["grants"][number] {
  return {
    id: "grant-1",
    role: "viewer",
    scopeKind: "global",
    project: null,
    environment: null,
    pathPrefix: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as UserWithGrants["grants"][number];
}

test("saving a project-scoped Admin keeps the project scope", () => {
  const grants = createUpdatedGrants({
    role: "admin",
    pathPrefix: "",
    currentGrants: [
      grant({ role: "admin", scopeKind: "project", project: "field-notes" }),
    ],
    activeProject: "other-project",
    activeEnvironment: "production",
  });

  assert.deepEqual(grants, [
    { role: "admin", scopeKind: "project", project: "field-notes" },
  ]);
});

test("choosing Admin for a non-admin user grants it instance-wide", () => {
  const grants = createUpdatedGrants({
    role: "admin",
    pathPrefix: "",
    currentGrants: [
      grant({ role: "editor", scopeKind: "project", project: "field-notes" }),
    ],
    activeProject: "field-notes",
    activeEnvironment: "production",
  });

  assert.deepEqual(grants, [{ role: "admin", scopeKind: "global" }]);
});

test("additional project-scoped Admin grants survive an edit of the first grant", () => {
  const grants = createUpdatedGrants({
    role: "editor",
    pathPrefix: "",
    currentGrants: [
      grant({ role: "viewer", scopeKind: "project", project: "docs" }),
      grant({
        id: "grant-2",
        role: "admin",
        scopeKind: "project",
        project: "field-notes",
      }),
    ],
    activeProject: "docs",
    activeEnvironment: "production",
  });

  assert.deepEqual(grants, [
    { role: "editor", scopeKind: "project", project: "docs" },
    { role: "admin", scopeKind: "project", project: "field-notes" },
  ]);
});
