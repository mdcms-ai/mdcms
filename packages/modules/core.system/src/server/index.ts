import type { ServerSurface } from "@mdcms/shared";

export const coreSystemServerSurface: ServerSurface<
  unknown,
  Record<string, unknown>
> = {
  mount: (app) => {
    const serverApp = app as {
      get?: (
        path: string,
        handler: (context: { request: Request }) => unknown,
      ) => unknown;
    };

    serverApp.get?.("/api/v1/modules/core-system/ping", ({ request }) => {
      let route = "/api/v1/modules/core-system/ping";

      try {
        route = new URL(request.url).pathname;
      } catch {
        // keep the default route
      }

      return {
        moduleId: "core.system",
        status: "healthy",
        route,
        generatedAt: new Date().toISOString(),
      };
    });
  },
  actions: [
    {
      id: "core.system.ping",
      kind: "query",
      method: "GET",
      path: "/api/v1/modules/core-system/ping",
      permissions: ["system:read"],
      studio: {
        visible: true,
        surface: "settings",
        label: "Core system ping",
      },
      cli: {
        visible: true,
        alias: "system:ping",
        inputMode: "json",
      },
      responseSchema: {
        type: "object",
        properties: {
          moduleId: { type: "string" },
          status: { type: "string" },
          route: { type: "string" },
          generatedAt: { type: "string" },
        },
        required: ["moduleId", "status", "route", "generatedAt"],
        additionalProperties: false,
      },
    },
  ],
};
