import assert from "node:assert/strict";

import {
  createDatabaseTestContext,
  resetDatabaseTestScope,
  seedSchemaRegistryScope,
  stableFixtureName,
  testWithDatabase,
} from "./content-api-test-support.js";
import { createDatabaseWebhookStore } from "./webhooks-api.js";
import { createPayload } from "./webhooks/test-support.js";

const validSecret = "0123456789abcdef0123456789abcdef";

testWithDatabase(
  "database webhook store persists scoped configs and active delivery target lookup",
  async () => {
    const { dbConnection, userId } = await createDatabaseTestContext(
      "test:webhooks-db-store",
    );
    const scope = {
      project: stableFixtureName("webhooks-db-store"),
      environment: "production",
    };
    const store = createDatabaseWebhookStore({
      db: dbConnection.db,
      now: () => new Date("2026-06-03T12:00:00.000Z"),
    });

    try {
      await resetDatabaseTestScope(dbConnection.db, scope);
      await seedSchemaRegistryScope(dbConnection.db, {
        scope,
        entries: [],
      });

      const created = await store.create(
        scope,
        {
          url: "https://example.com/hooks/mdcms",
          events: ["content.published", "content.updated"],
          secret: validSecret,
          active: true,
        },
        { actorId: userId },
      );

      assert.equal(created.project, scope.project);
      assert.equal(created.environment, scope.environment);
      assert.equal("secret" in created, false);
      assert.equal(created.createdBy, userId);
      assert.equal(created.updatedBy, userId);

      const listed = await store.list(scope);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.id, created.id);

      const activeDeliveryTargets = await store.listActiveTargetsByEvent(
        scope,
        "content.published",
      );
      assert.deepEqual(
        activeDeliveryTargets.map((webhook) => webhook.id),
        [created.id],
      );
      assert.equal(activeDeliveryTargets[0]?.secret, validSecret);
      assert.equal(
        (await store.listActiveTargetsByEvent(scope, "content.deleted")).length,
        0,
      );

      const updated = await store.update(
        scope,
        created.id,
        {
          url: "https://example.com/hooks/updated",
          active: false,
        },
        { actorId: userId },
      );
      assert.equal(updated.url, "https://example.com/hooks/updated");
      assert.equal(updated.active, false);
      assert.equal(updated.updatedBy, userId);
      assert.equal(
        (await store.listActiveTargetsByEvent(scope, "content.published"))
          .length,
        0,
      );

      assert.deepEqual(await store.delete(scope, created.id), {
        deleted: true,
        id: created.id,
      });
      assert.equal((await store.list(scope)).length, 0);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "database webhook store persists and filters delivery history",
  async () => {
    const { dbConnection, userId } = await createDatabaseTestContext(
      "test:webhooks-history-store",
    );
    const scope = {
      project: stableFixtureName("webhooks-history-store"),
      environment: "production",
    };
    const store = createDatabaseWebhookStore({
      db: dbConnection.db,
      now: () => new Date("2026-06-03T12:00:00.000Z"),
    });

    try {
      await resetDatabaseTestScope(dbConnection.db, scope);
      await seedSchemaRegistryScope(dbConnection.db, {
        scope,
        entries: [],
      });

      const created = await store.create(
        scope,
        {
          url: "https://example.com/hooks/mdcms",
          events: ["content.published"],
          secret: validSecret,
          active: true,
        },
        { actorId: userId },
      );
      const payload = createPayload();
      const delivery = {
        scope,
        webhook: {
          ...created,
          secret: validSecret,
        },
        payload,
        eventId: "018f0c6d-98da-7f25-89fe-7c7ef5e85980",
        deliveryId: "018f0c6d-98da-7f25-89fe-7c7ef5e85981",
        attempt: 1,
        maxAttempts: 3,
      };

      await store.recordDeliveryAttempt({
        delivery,
        outcome: "failed",
        statusCode: 503,
        error: new Error("Webhook delivery failed with status 503."),
      });
      await store.recordDeliveryAttempt({
        delivery: {
          ...delivery,
          deliveryId: "018f0c6d-98da-7f25-89fe-7c7ef5e85982",
          attempt: 2,
        },
        outcome: "succeeded",
        statusCode: 202,
      });

      const failed = await store.listDeliveryHistory(scope, {
        webhookId: created.id,
        event: "content.published",
        outcome: "failed",
        limit: 10,
      });

      assert.equal(failed.length, 1);
      assert.equal(failed[0]?.webhookId, created.id);
      assert.equal(failed[0]?.project, scope.project);
      assert.equal(failed[0]?.environment, scope.environment);
      assert.equal(failed[0]?.event, "content.published");
      assert.equal(failed[0]?.deliveryId, delivery.deliveryId);
      assert.equal(failed[0]?.attempt, 1);
      assert.equal(failed[0]?.maxAttempts, 3);
      assert.equal(failed[0]?.outcome, "failed");
      assert.equal(failed[0]?.statusCode, 503);
      assert.equal(
        failed[0]?.error,
        "Webhook delivery failed with status 503.",
      );
      assert.equal(failed[0]?.url, "https://example.com/hooks/mdcms");

      const succeeded = await store.listDeliveryHistory(scope, {
        outcome: "succeeded",
        limit: 10,
      });
      assert.deepEqual(
        succeeded.map((entry) => entry.deliveryId),
        ["018f0c6d-98da-7f25-89fe-7c7ef5e85982"],
      );
    } finally {
      await dbConnection.close();
    }
  },
);
