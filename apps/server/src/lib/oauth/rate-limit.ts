import { gt, inArray, lte, sql } from "drizzle-orm";
import type { DrizzleDatabase } from "../db.js";
import { oauthCounters } from "../db/schema.js";
import { hashCredential, OAuthError } from "./database-store.js";

export function createOAuthRateLimiter(
  db: DrizzleDatabase,
  now: () => Date = () => new Date(),
  namespace = "oauth",
) {
  return {
    // bucket is supplied only after resolving a known client or signed-in user.
    async consume(
      endpoint: "register" | "authorize" | "token" | "revoke",
      limit: number,
      bucket?: string,
      includeGlobal = true,
    ) {
      try {
        const result = await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(172938, 2)`);
          const time = now();
          const window = Math.floor(time.getTime() / 60000);
          const expired = await tx
            .select({ key: oauthCounters.key })
            .from(oauthCounters)
            .where(lte(oauthCounters.expiresAt, time))
            .orderBy(oauthCounters.expiresAt)
            .limit(1000);
          if (expired.length)
            await tx.delete(oauthCounters).where(
              inArray(
                oauthCounters.key,
                expired.map((row) => row.key),
              ),
            );
          const keys = includeGlobal
            ? [`${namespace}:${endpoint}:${window}:global`]
            : [];
          if (bucket)
            keys.push(
              `${namespace}:${endpoint}:${window}:${hashCredential(bucket)}`,
            );
          const existing = await tx
            .select()
            .from(oauthCounters)
            .where(inArray(oauthCounters.key, keys));
          const [count] = await tx
            .select({ value: sql<number>`count(*)::int` })
            .from(oauthCounters)
            .where(gt(oauthCounters.expiresAt, time));
          if (count!.value + keys.length - existing.length > 10000) return 503;
          let allowed = true;
          for (const key of keys) {
            const [row] = await tx
              .insert(oauthCounters)
              .values({
                key,
                count: 1,
                expiresAt: new Date((window + 2) * 60000),
              })
              .onConflictDoUpdate({
                target: oauthCounters.key,
                set: { count: sql`${oauthCounters.count} + 1` },
              })
              .returning();
            if (row!.count > limit) allowed = false;
          }
          return allowed ? 200 : 429;
        });
        if (result === 503)
          throw new OAuthError("temporarily_unavailable", 503, 60);
        if (result === 429)
          throw new OAuthError(
            "rate_limit_exceeded",
            429,
            Math.max(1, Math.ceil((60000 - (now().getTime() % 60000)) / 1000)),
          );
      } catch (error) {
        if (error instanceof OAuthError) throw error;
        throw new OAuthError("temporarily_unavailable", 503, 60);
      }
    },
  };
}
