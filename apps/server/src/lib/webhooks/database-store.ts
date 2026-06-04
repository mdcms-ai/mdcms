import {
  RuntimeError,
  type WebhookConfig,
  type WebhookDeliveryHistoryEntry,
  type WebhookDeliveryOutcome,
  type WebhookEvent,
} from "@mdcms/shared";
import { and, desc, eq, sql } from "drizzle-orm";

import { webhookDeliveryAttempts, webhooks } from "../db/schema.js";
import { resolveProjectEnvironmentScope } from "../project-provisioning.js";

import { parseWebhookId } from "./ids.js";
import type {
  CreateDatabaseWebhookStoreOptions,
  WebhookDeliveryAttemptResult,
  WebhookDeliveryTarget,
  WebhookScope,
  WebhookStore,
} from "./types.js";

type WebhookScopeIds = {
  projectId: string;
  environmentId: string;
};

function toIsoString(value: Date): string {
  return value.toISOString();
}

function createTargetNotFoundError(scope: WebhookScope): RuntimeError {
  return new RuntimeError({
    code: "NOT_FOUND",
    message: "Target project or environment not found.",
    statusCode: 404,
    details: {
      project: scope.project,
      environment: scope.environment,
    },
  });
}

function createWebhookNotFoundError(id: string): RuntimeError {
  return new RuntimeError({
    code: "NOT_FOUND",
    message: "Webhook not found.",
    statusCode: 404,
    details: { id },
  });
}

async function resolveWebhookScopeIds(
  options: CreateDatabaseWebhookStoreOptions,
  scope: WebhookScope,
): Promise<WebhookScopeIds | undefined> {
  const resolvedScope = await resolveProjectEnvironmentScope(options.db, {
    project: scope.project,
    environment: scope.environment,
  });

  if (!resolvedScope) {
    return undefined;
  }

  return {
    projectId: resolvedScope.project.id,
    environmentId: resolvedScope.environment.id,
  };
}

async function requireWebhookScopeIds(
  options: CreateDatabaseWebhookStoreOptions,
  scope: WebhookScope,
): Promise<WebhookScopeIds> {
  const scopeIds = await resolveWebhookScopeIds(options, scope);

  if (!scopeIds) {
    throw createTargetNotFoundError(scope);
  }

  return scopeIds;
}

function toWebhookConfig(
  scope: WebhookScope,
  row: typeof webhooks.$inferSelect,
): WebhookConfig {
  return {
    id: row.id,
    project: scope.project,
    environment: scope.environment,
    url: row.url,
    events: row.events as WebhookEvent[],
    active: row.active,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function toWebhookDeliveryTarget(
  scope: WebhookScope,
  row: typeof webhooks.$inferSelect,
): WebhookDeliveryTarget {
  return {
    ...toWebhookConfig(scope, row),
    secret: row.secret,
  };
}

function normalizeDeliveryError(error: unknown): string | null {
  if (error === undefined || error === null) {
    return null;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function normalizeStatusCode(
  statusCode: number | null | undefined,
): number | null {
  if (
    typeof statusCode === "number" &&
    Number.isInteger(statusCode) &&
    statusCode >= 100 &&
    statusCode <= 599
  ) {
    return statusCode;
  }

  return null;
}

function toWebhookDeliveryHistoryEntry(
  scope: WebhookScope,
  row: typeof webhookDeliveryAttempts.$inferSelect,
): WebhookDeliveryHistoryEntry {
  return {
    id: row.id,
    webhookId: row.webhookId,
    project: scope.project,
    environment: scope.environment,
    url: row.url,
    event: row.event as WebhookEvent,
    eventId: row.eventId,
    deliveryId: row.deliveryId,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    outcome: row.outcome as WebhookDeliveryOutcome,
    statusCode: row.statusCode,
    error: row.error,
    createdAt: toIsoString(row.createdAt),
  };
}

function scopeFromDeliveryAttempt(
  result: WebhookDeliveryAttemptResult,
): WebhookScope {
  return {
    project: result.delivery.payload.project,
    environment: result.delivery.payload.environment,
  };
}

export function createDatabaseWebhookStore(
  options: CreateDatabaseWebhookStoreOptions,
): WebhookStore {
  const { db } = options;
  const now = options.now ?? (() => new Date());

  return {
    async list(scope) {
      const scopeIds = await resolveWebhookScopeIds(options, scope);

      if (!scopeIds) {
        return [];
      }

      const rows = await db
        .select()
        .from(webhooks)
        .where(
          and(
            eq(webhooks.projectId, scopeIds.projectId),
            eq(webhooks.environmentId, scopeIds.environmentId),
          ),
        )
        .orderBy(desc(webhooks.createdAt), desc(webhooks.id));

      return rows.map((row) => toWebhookConfig(scope, row));
    },

    async create(scope, input, context) {
      const scopeIds = await requireWebhookScopeIds(options, scope);
      const timestamp = now();
      const [created] = await db
        .insert(webhooks)
        .values({
          projectId: scopeIds.projectId,
          environmentId: scopeIds.environmentId,
          url: input.url,
          events: input.events,
          secret: input.secret,
          active: input.active,
          createdBy: context.actorId,
          updatedBy: context.actorId,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning();

      if (!created) {
        throw new RuntimeError({
          code: "INTERNAL_ERROR",
          message: "Failed to create webhook.",
          statusCode: 500,
        });
      }

      return toWebhookConfig(scope, created);
    },

    async update(scope, id, input, context) {
      const scopeIds = await requireWebhookScopeIds(options, scope);
      const webhookId = parseWebhookId(id);
      const patch: Partial<typeof webhooks.$inferInsert> = {
        updatedBy: context.actorId,
        updatedAt: now(),
      };

      if (input.url !== undefined) {
        patch.url = input.url;
      }
      if (input.events !== undefined) {
        patch.events = input.events;
      }
      if (input.secret !== undefined) {
        patch.secret = input.secret;
      }
      if (input.active !== undefined) {
        patch.active = input.active;
      }

      const [updated] = await db
        .update(webhooks)
        .set(patch)
        .where(
          and(
            eq(webhooks.id, webhookId),
            eq(webhooks.projectId, scopeIds.projectId),
            eq(webhooks.environmentId, scopeIds.environmentId),
          ),
        )
        .returning();

      if (!updated) {
        throw createWebhookNotFoundError(webhookId);
      }

      return toWebhookConfig(scope, updated);
    },

    async delete(scope, id) {
      const scopeIds = await requireWebhookScopeIds(options, scope);
      const webhookId = parseWebhookId(id);
      const [deleted] = await db
        .delete(webhooks)
        .where(
          and(
            eq(webhooks.id, webhookId),
            eq(webhooks.projectId, scopeIds.projectId),
            eq(webhooks.environmentId, scopeIds.environmentId),
          ),
        )
        .returning({ id: webhooks.id });

      if (!deleted) {
        throw createWebhookNotFoundError(webhookId);
      }

      return { deleted: true, id: deleted.id };
    },

    async listActiveTargetsByEvent(scope, event) {
      const scopeIds = await resolveWebhookScopeIds(options, scope);

      if (!scopeIds) {
        return [];
      }

      const rows = await db
        .select()
        .from(webhooks)
        .where(
          and(
            eq(webhooks.projectId, scopeIds.projectId),
            eq(webhooks.environmentId, scopeIds.environmentId),
            eq(webhooks.active, true),
            sql`${webhooks.events} @> ${JSON.stringify([event])}::jsonb`,
          ),
        )
        .orderBy(desc(webhooks.createdAt), desc(webhooks.id));

      return rows.map((row) => toWebhookDeliveryTarget(scope, row));
    },

    async recordDeliveryAttempt(result) {
      const scope = scopeFromDeliveryAttempt(result);
      const scopeIds = await requireWebhookScopeIds(options, scope);

      await db.insert(webhookDeliveryAttempts).values({
        projectId: scopeIds.projectId,
        environmentId: scopeIds.environmentId,
        webhookId: result.delivery.webhook.id,
        event: result.delivery.payload.event,
        eventId: result.delivery.eventId,
        deliveryId: result.delivery.deliveryId,
        url: result.delivery.webhook.url,
        attempt: result.delivery.attempt,
        maxAttempts: result.delivery.maxAttempts,
        outcome: result.outcome,
        statusCode: normalizeStatusCode(result.statusCode),
        error: normalizeDeliveryError(result.error),
        createdAt: now(),
      });
    },

    async listDeliveryHistory(scope, filter) {
      const scopeIds = await resolveWebhookScopeIds(options, scope);

      if (!scopeIds) {
        return [];
      }

      const conditions = [
        eq(webhookDeliveryAttempts.projectId, scopeIds.projectId),
        eq(webhookDeliveryAttempts.environmentId, scopeIds.environmentId),
      ];

      if (filter.webhookId !== undefined) {
        conditions.push(
          eq(webhookDeliveryAttempts.webhookId, filter.webhookId),
        );
      }
      if (filter.event !== undefined) {
        conditions.push(eq(webhookDeliveryAttempts.event, filter.event));
      }
      if (filter.outcome !== undefined) {
        conditions.push(eq(webhookDeliveryAttempts.outcome, filter.outcome));
      }

      const rows = await db
        .select()
        .from(webhookDeliveryAttempts)
        .where(and(...conditions))
        .orderBy(
          desc(webhookDeliveryAttempts.createdAt),
          desc(webhookDeliveryAttempts.id),
        )
        .limit(filter.limit);

      return rows.map((row) => toWebhookDeliveryHistoryEntry(scope, row));
    },
  };
}
