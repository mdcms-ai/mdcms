import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  mountProjectApiRoutes,
  type ProjectAuthorizationInput,
  type ProjectStore,
} from "./projects-api.js";

type Handler = (ctx: any) => Promise<unknown>;

function createHarness(accessible: string[]) {
  const routes = new Map<string, Handler>();
  const authorizations: ProjectAuthorizationInput[] = [];
  const created: string[] = [];
  const store: ProjectStore = {
    list: async () =>
      ["alpha", "beta", "gamma"].map((slug) => ({
        id: `id-${slug}`,
        slug,
        name: slug,
        environmentCount: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      })),
    create: async (input) => {
      created.push(input.name);
      return {
        id: "id-new",
        slug: input.name,
        name: input.name,
        environments: [],
      };
    },
    listEnvironments: async () => [{ id: "env-1", name: "production" }],
    createEnvironment: async (_slug, input) => ({
      id: "env-2",
      name: input.name,
    }),
  };
  const app = {
    get: (path: string, handler: Handler) => {
      routes.set(`GET ${path}`, handler);
      return app;
    },
    post: (path: string, handler: Handler) => {
      routes.set(`POST ${path}`, handler);
      return app;
    },
  };

  mountProjectApiRoutes(app, {
    store,
    authorize: async (_request, input) => {
      authorizations.push(input);
    },
    filterAccessibleProjects: async (_request, slugs) =>
      slugs.filter((slug) => accessible.includes(slug)),
  });

  const request = new Request("http://localhost/api/v1/projects");

  return { routes, authorizations, created, request };
}

test("project list returns only the projects the caller can access", async () => {
  const harness = createHarness(["beta"]);

  const payload = (await harness.routes.get("GET /api/v1/projects")!({
    request: harness.request,
  })) as { data: Array<{ slug: string }> };

  assert.deepEqual(
    payload.data.map((project) => project.slug),
    ["beta"],
  );
  assert.deepEqual(harness.authorizations, [{ scope: "projects:read" }]);
});

test("project creation is authorized for the slug being created", async () => {
  const harness = createHarness([]);

  await harness.routes.get("POST /api/v1/projects")!({
    request: harness.request,
    body: { name: "Field Notes Ada" },
  });

  assert.deepEqual(harness.authorizations, [
    { scope: "projects:write", project: "field-notes-ada" },
  ]);
  assert.deepEqual(harness.created, ["Field Notes Ada"]);
});

test("environment routes are authorized for the project in the path", async () => {
  const harness = createHarness([]);

  await harness.routes.get("GET /api/v1/projects/:slug/environments")!({
    request: harness.request,
    params: { slug: "beta" },
  });
  await harness.routes.get("POST /api/v1/projects/:slug/environments")!({
    request: harness.request,
    params: { slug: "beta" },
    body: { name: "staging" },
  });

  assert.deepEqual(harness.authorizations, [
    { scope: "projects:read", project: "beta" },
    { scope: "projects:write", project: "beta" },
  ]);
});
