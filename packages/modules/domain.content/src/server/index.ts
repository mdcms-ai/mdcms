import type { ServerSurface } from "@mdcms/shared";

export const domainContentServerSurface: ServerSurface<
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

    serverApp.get?.("/api/v1/modules/domain-content/preview", ({ request }) => {
      let route = "/api/v1/modules/domain-content/preview";

      try {
        route = new URL(request.url).pathname;
      } catch {
        // keep the default route
      }

      return {
        moduleId: "domain.content",
        status: "healthy",
        route,
        generatedAt: new Date().toISOString(),
      };
    });
  },
  actions: [
    {
      id: "domain.content.preview",
      kind: "query",
      method: "GET",
      path: "/api/v1/modules/domain-content/preview",
      permissions: ["content:read"],
      studio: {
        visible: true,
        surface: "content",
        label: "Domain content preview",
      },
      cli: {
        visible: true,
        alias: "content:preview",
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
