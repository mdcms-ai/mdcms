import {
  RuntimeError,
  parseWebhookDeliveryHistoryQuery,
  parseWebhookCreateInput,
  parseWebhookUpdateInput,
  resolveRequestTargetRouting,
} from "@mdcms/shared";

import { actorFromAuthorizedRequest } from "../auth.js";
import { executeWithRuntimeErrorsHandled } from "../http-utils.js";

import { parseWebhookId } from "./ids.js";
import { assertWebhookTargetAllowed } from "./target-url.js";
import type {
  MountWebhookApiRoutesOptions,
  WebhookRouteApp,
  WebhookScope,
} from "./types.js";

function pickWebhookScope(request: Request): WebhookScope {
  const scope = resolveRequestTargetRouting(request);

  if (!scope.project || !scope.environment) {
    throw new RuntimeError({
      code: "MISSING_TARGET_ROUTING",
      message:
        "Both project and environment are required for webhook endpoints.",
      statusCode: 400,
      details: {
        project: scope.project ?? null,
        environment: scope.environment ?? null,
      },
    });
  }

  return {
    project: scope.project,
    environment: scope.environment,
  };
}

function pickDeliveryHistoryFilter(request: Request) {
  const url = new URL(request.url);

  return parseWebhookDeliveryHistoryQuery(
    Object.fromEntries(url.searchParams.entries()),
  );
}

async function parseCreateBody(
  body: unknown,
  options: MountWebhookApiRoutesOptions,
) {
  const input = parseWebhookCreateInput(body ?? {});
  await assertWebhookTargetAllowed(input.url, {
    resolveAddresses: options.resolveTargetAddresses,
  });
  return input;
}

async function parseUpdateBody(
  body: unknown,
  options: MountWebhookApiRoutesOptions,
) {
  const input = parseWebhookUpdateInput(body ?? {});

  if (input.url !== undefined) {
    await assertWebhookTargetAllowed(input.url, {
      resolveAddresses: options.resolveTargetAddresses,
    });
  }

  return input;
}

export function mountWebhookApiRoutes(
  app: unknown,
  options: MountWebhookApiRoutesOptions,
): void {
  const webhookApp = app as WebhookRouteApp;

  webhookApp.get?.("/api/v1/webhooks/deliveries", ({ request }: any) => {
    return executeWithRuntimeErrorsHandled(request, async () => {
      const scope = pickWebhookScope(request);
      await options.authorize(request, {
        requiredScope: "webhooks:read",
        project: scope.project,
        environment: scope.environment,
      });
      const filter = pickDeliveryHistoryFilter(request);

      return { data: await options.store.listDeliveryHistory(scope, filter) };
    });
  });

  webhookApp.get?.("/api/v1/webhooks", ({ request }: any) => {
    return executeWithRuntimeErrorsHandled(request, async () => {
      const scope = pickWebhookScope(request);
      await options.authorize(request, {
        requiredScope: "webhooks:read",
        project: scope.project,
        environment: scope.environment,
      });

      return { data: await options.store.list(scope) };
    });
  });

  webhookApp.post?.("/api/v1/webhooks", ({ request, body }: any) => {
    return executeWithRuntimeErrorsHandled(request, async () => {
      const scope = pickWebhookScope(request);
      await options.requireCsrf(request);
      const authorized = await options.authorize(request, {
        requiredScope: "webhooks:write",
        project: scope.project,
        environment: scope.environment,
      });
      const input = await parseCreateBody(body, options);

      return {
        data: await options.store.create(scope, input, {
          actorId: actorFromAuthorizedRequest(authorized).id,
        }),
      };
    });
  });

  webhookApp.put?.("/api/v1/webhooks/:id", ({ request, params, body }: any) => {
    return executeWithRuntimeErrorsHandled(request, async () => {
      const scope = pickWebhookScope(request);
      const webhookId = parseWebhookId(params.id);
      await options.requireCsrf(request);
      const authorized = await options.authorize(request, {
        requiredScope: "webhooks:write",
        project: scope.project,
        environment: scope.environment,
      });
      const input = await parseUpdateBody(body, options);

      return {
        data: await options.store.update(scope, webhookId, input, {
          actorId: actorFromAuthorizedRequest(authorized).id,
        }),
      };
    });
  });

  webhookApp.delete?.("/api/v1/webhooks/:id", ({ request, params }: any) => {
    return executeWithRuntimeErrorsHandled(request, async () => {
      const scope = pickWebhookScope(request);
      const webhookId = parseWebhookId(params.id);
      await options.requireCsrf(request);
      await options.authorize(request, {
        requiredScope: "webhooks:write",
        project: scope.project,
        environment: scope.environment,
      });

      return {
        data: await options.store.delete(scope, webhookId),
      };
    });
  });
}
