import { oauthTestDatabase } from "./test-database.js";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { createDatabaseConnection } from "../db.js";
import { oauthCounters } from "../db/schema.js";
import { createOAuthRateLimiter } from "./rate-limit.js";

const { url: url, test: databaseTest } = oauthTestDatabase();

databaseTest(
  "PostgreSQL fixed-window throttle atomically limits concurrent requests and expires",
  async () => {
    const connection = createDatabaseConnection({ env: { DATABASE_URL: url } });
    const namespace = randomUUID();
    let time = 180000;
    const limiter = createOAuthRateLimiter(
      connection.db,
      () => new Date(time),
      namespace,
    );
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, () => limiter.consume("token", 5)),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 5);
      const rejection = results.find((r) => r.status === "rejected");
      assert.equal(
        rejection?.status === "rejected" && rejection.reason.status,
        429,
      );
      time = 240000;
      await limiter.consume("token", 5);
    } finally {
      await connection.db
        .delete(oauthCounters)
        .where(like(oauthCounters.key, `${namespace}:%`));
      await connection.close();
    }
  },
);

test("throttle storage outage is a sanitized retryable failure", async () => {
  const db = {
    transaction: async () => {
      throw new Error("private database details");
    },
  } as unknown as Parameters<typeof createOAuthRateLimiter>[0];
  await assert.rejects(
    createOAuthRateLimiter(db).consume("token", 5),
    (error: any) =>
      error.status === 503 &&
      error.retryAfter === 60 &&
      error.message === "temporarily_unavailable",
  );
});

databaseTest(
  "active bucket capacity fails closed without evicting live buckets",
  async () => {
    const connection = createDatabaseConnection({ env: { DATABASE_URL: url } });
    const namespace = randomUUID();
    const time = new Date();
    const { gt, sql } = await import("drizzle-orm");
    try {
      const [existing] = await connection.db
        .select({ count: sql<number>`count(*)::int` })
        .from(oauthCounters)
        .where(gt(oauthCounters.expiresAt, time));
      const count = 10000 - existing!.count;
      for (let i = 0; i < count; i += 500)
        await connection.db.insert(oauthCounters).values(
          Array.from({ length: Math.min(500, count - i) }, (_, j) => ({
            key: `${namespace}:capacity:${i + j}`,
            count: 1,
            expiresAt: new Date(time.getTime() + 120000),
          })),
        );
      await assert.rejects(
        createOAuthRateLimiter(connection.db, () => time, namespace).consume(
          "register",
          10,
        ),
        (error: any) => error.status === 503 && error.retryAfter === 60,
      );
      const owned = await connection.db
        .select()
        .from(oauthCounters)
        .where(like(oauthCounters.key, `${namespace}:%`));
      assert.equal(owned.length, count);
    } finally {
      await connection.db
        .delete(oauthCounters)
        .where(like(oauthCounters.key, `${namespace}:%`));
      await connection.close();
    }
  },
);
