import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { DrizzleDatabase } from "../db.js";
import {
  authUsers,
  oauthClients,
  oauthCodes,
  oauthConsents,
  oauthFamilies,
  oauthGrants,
  oauthTokens,
} from "../db/schema.js";

export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
    public readonly retryAfter?: number,
  ) {
    super(code);
  }
}
export type OAuthGrant = typeof oauthGrants.$inferSelect;
export type GrantCheck = (
  grant: OAuthGrant,
  scopes: string[],
  transaction: Transaction,
) => Promise<boolean>;
export const hashCredential = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const credential = (prefix: string) =>
  prefix + randomBytes(32).toString("base64url");
type Transaction = Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0];

export function createOAuthStore(
  db: DrizzleDatabase,
  now: () => Date = () => new Date(),
) {
  async function issue(
    tx: Transaction,
    familyId: string,
    expiry: Date,
    scopes: string[],
    parentHash?: string,
  ) {
    const issuedAt = now().getTime();
    const expiresIn = Math.min(
      3600,
      Math.floor((expiry.getTime() - issuedAt) / 1000),
    );
    if (expiresIn < 1) throw new OAuthError("invalid_grant");
    const access = credential("mdcms_oat_");
    const refresh = credential("mdcms_ort_");
    await tx.insert(oauthTokens).values([
      {
        hash: hashCredential(access),
        familyId,
        kind: "access",
        scopes,
        expiresAt: new Date(issuedAt + expiresIn * 1000),
      },
      {
        hash: hashCredential(refresh),
        familyId,
        kind: "refresh",
        scopes,
        expiresAt: expiry,
        parentHash,
      },
    ]);
    return {
      access_token: access,
      token_type: "Bearer" as const,
      expires_in: expiresIn,
      refresh_token: refresh,
      scope: scopes.join(" "),
    };
  }
  return {
    async revokeGrant(id: string) {
      await db
        .update(oauthGrants)
        .set({ revokedAt: now() })
        .where(and(eq(oauthGrants.id, id), isNull(oauthGrants.revokedAt)));
    },
    async revokeToken(clientId: string, raw: string) {
      const [row] = await db
        .select({ id: oauthGrants.id })
        .from(oauthTokens)
        .innerJoin(oauthFamilies, eq(oauthFamilies.id, oauthTokens.familyId))
        .innerJoin(oauthGrants, eq(oauthGrants.id, oauthFamilies.grantId))
        .where(
          and(
            eq(oauthTokens.hash, hashCredential(raw)),
            eq(oauthGrants.clientId, clientId),
          ),
        );
      if (row)
        await db
          .update(oauthGrants)
          .set({ revokedAt: now() })
          .where(
            and(eq(oauthGrants.id, row.id), isNull(oauthGrants.revokedAt)),
          );
    },
    async bindConsent(
      handle: string,
      identity: { userId: string; sessionId: string },
    ) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(oauthConsents)
          .where(eq(oauthConsents.hash, hashCredential(handle)))
          .for("update");
        if (!row) throw new OAuthError("invalid_request");
        if (row.expiresAt <= now())
          throw new OAuthError("invalid_request", 410);
        if (row.consumedAt) throw new OAuthError("invalid_request");
        if (
          row.userId !== null &&
          (row.userId !== identity.userId ||
            row.sessionId !== identity.sessionId)
        )
          throw new OAuthError("FORBIDDEN", 403);
        await tx
          .update(oauthConsents)
          .set(identity)
          .where(eq(oauthConsents.hash, row.hash));
        return { ...row, ...identity };
      });
    },
    async createConsent(
      clientId: string,
      payload: NonNullable<typeof oauthConsents.$inferSelect.payload>,
      identity?: { userId: string; sessionId: string },
    ) {
      const handle = credential("");
      const createdAt = now();
      await db.insert(oauthConsents).values({
        hash: hashCredential(handle),
        clientId,
        payload,
        userId: identity?.userId,
        sessionId: identity?.sessionId,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + 600000),
      });
      return handle;
    },
    async readConsent(handle: string) {
      const [row] = await db
        .select()
        .from(oauthConsents)
        .where(eq(oauthConsents.hash, hashCredential(handle)));
      if (!row) throw new OAuthError("invalid_request");
      if (row.expiresAt <= now()) throw new OAuthError("invalid_request", 410);
      if (row.consumedAt) throw new OAuthError("invalid_request");
      return row;
    },
    async consumeConsent(
      handle: string,
      identity: { userId: string; sessionId: string },
      onConsume?: (
        tx: Transaction,
        consent: typeof oauthConsents.$inferSelect,
      ) => Promise<void>,
    ) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(oauthConsents)
          .where(eq(oauthConsents.hash, hashCredential(handle)))
          .for("update");
        if (!row) throw new OAuthError("invalid_request");
        if (row.expiresAt <= now())
          throw new OAuthError("invalid_request", 410);
        if (row.consumedAt) throw new OAuthError("invalid_request");
        if (!row.payload) throw new OAuthError("invalid_request");
        if (
          row.userId !== identity.userId ||
          row.sessionId !== identity.sessionId
        )
          throw new OAuthError("FORBIDDEN", 403);
        await onConsume?.(tx, row);
        await tx
          .update(oauthConsents)
          .set({ consumedAt: now() })
          .where(eq(oauthConsents.hash, row.hash));
        return row;
      });
    },
    async cleanup() {
      const time = now();
      const expiredCodes = await db
        .select({ hash: oauthCodes.hash })
        .from(oauthCodes)
        .where(lte(oauthCodes.expiresAt, time))
        .orderBy(oauthCodes.expiresAt)
        .limit(500);
      if (expiredCodes.length)
        await db.delete(oauthCodes).where(
          inArray(
            oauthCodes.hash,
            expiredCodes.map((row) => row.hash),
          ),
        );
      // Refresh expiry is always the family's absolute expiry, preserving replay evidence.
      const expiredTokens = await db
        .select({ hash: oauthTokens.hash })
        .from(oauthTokens)
        .where(lte(oauthTokens.expiresAt, time))
        .orderBy(oauthTokens.expiresAt)
        .limit(500);
      if (expiredTokens.length)
        await db.delete(oauthTokens).where(
          inArray(
            oauthTokens.hash,
            expiredTokens.map((row) => row.hash),
          ),
        );
      const payloads = await db
        .select({ hash: oauthConsents.hash })
        .from(oauthConsents)
        .where(
          and(
            lte(oauthConsents.expiresAt, time),
            isNotNull(oauthConsents.payload),
          ),
        )
        .orderBy(oauthConsents.expiresAt)
        .limit(500);
      if (payloads.length)
        await db
          .update(oauthConsents)
          .set({ payload: null })
          .where(
            inArray(
              oauthConsents.hash,
              payloads.map((row) => row.hash),
            ),
          );
      const expiredConsents = await db
        .select({ hash: oauthConsents.hash })
        .from(oauthConsents)
        .where(
          lte(oauthConsents.expiresAt, new Date(time.getTime() - 86400000)),
        )
        .orderBy(oauthConsents.expiresAt)
        .limit(500);
      if (expiredConsents.length)
        await db.delete(oauthConsents).where(
          inArray(
            oauthConsents.hash,
            expiredConsents.map((row) => row.hash),
          ),
        );
    },
    async register(name: string, redirectUris: string[]) {
      return db.transaction(async (tx) => {
        // A transaction-scoped lock serializes admission across server instances.
        await tx.execute(sql`select pg_advisory_xact_lock(172938, 1)`);
        const [count] = await tx
          .select({ value: sql<number>`count(*)::int` })
          .from(oauthClients);
        if (count!.value >= 10000)
          throw new OAuthError("temporarily_unavailable", 503, 60);
        const [client] = await tx
          .insert(oauthClients)
          .values({ id: randomUUID(), name, redirectUris, createdAt: now() })
          .returning();
        return client!;
      });
    },
    async exchangeCode(
      input: {
        clientId: string;
        code: string;
        verifier: string;
        redirectUri: string;
        resource: string;
      },
      check: GrantCheck,
    ) {
      return db.transaction(async (tx) => {
        const [code] = await tx
          .select()
          .from(oauthCodes)
          .where(eq(oauthCodes.hash, hashCredential(input.code)))
          .for("update");
        if (!code || code.consumedAt || code.expiresAt <= now())
          throw new OAuthError("invalid_grant");
        const [grant] = await tx
          .select()
          .from(oauthGrants)
          .where(eq(oauthGrants.id, code.grantId))
          .for("update");
        if (
          !grant ||
          grant.revokedAt ||
          grant.clientId !== input.clientId ||
          code.redirectUri !== input.redirectUri ||
          createHash("sha256").update(input.verifier).digest("base64url") !==
            code.challenge
        )
          throw new OAuthError("invalid_grant");
        if (grant.resource !== input.resource)
          throw new OAuthError("invalid_target");
        if (!(await check(grant, grant.scopes, tx)))
          throw new OAuthError("invalid_grant");
        const expiry = new Date(now().getTime() + 30 * 86400000);
        const [family] = await tx
          .insert(oauthFamilies)
          .values({ grantId: grant.id, expiresAt: expiry })
          .returning();
        await tx
          .update(oauthCodes)
          .set({ consumedAt: now() })
          .where(eq(oauthCodes.hash, code.hash));
        return issue(tx, family!.id, expiry, grant.scopes);
      });
    },
    async refresh(
      input: {
        clientId: string;
        token: string;
        resource: string;
        scopes?: string[];
      },
      check: GrantCheck,
    ) {
      const outcome = await db.transaction(async (tx) => {
        const [initial] = await tx
          .select()
          .from(oauthTokens)
          .where(
            and(
              eq(oauthTokens.hash, hashCredential(input.token)),
              eq(oauthTokens.kind, "refresh"),
            ),
          );
        if (!initial) throw new OAuthError("invalid_grant");
        const [family] = await tx
          .select()
          .from(oauthFamilies)
          .where(eq(oauthFamilies.id, initial.familyId))
          .for("update");
        if (!family || family.revokedAt || family.expiresAt <= now())
          throw new OAuthError("invalid_grant");
        const [grant] = await tx
          .select()
          .from(oauthGrants)
          .where(eq(oauthGrants.id, family.grantId))
          .for("update");
        if (!grant || grant.revokedAt || grant.clientId !== input.clientId)
          throw new OAuthError("invalid_grant");
        if (grant.resource !== input.resource)
          throw new OAuthError("invalid_target");
        const [token] = await tx
          .select()
          .from(oauthTokens)
          .where(eq(oauthTokens.hash, initial.hash));
        if (!token || token.expiresAt <= now())
          throw new OAuthError("invalid_grant");
        if (token.consumedAt) {
          await tx
            .update(oauthFamilies)
            .set({ revokedAt: now() })
            .where(eq(oauthFamilies.id, family.id));
          // Return, rather than throw, so replay revocation commits.
          return undefined;
        }
        const scopes = input.scopes ?? token.scopes;
        if (scopes.some((scope) => !token.scopes.includes(scope)))
          throw new OAuthError("invalid_scope");
        if (!(await check(grant, scopes, tx)))
          throw new OAuthError("invalid_grant");
        await tx
          .update(oauthTokens)
          .set({ consumedAt: now() })
          .where(eq(oauthTokens.hash, token.hash));
        return issue(tx, family.id, family.expiresAt, scopes, token.hash);
      });
      if (!outcome) throw new OAuthError("invalid_grant");
      return outcome;
    },
    async authenticate(raw: string, resource: string) {
      if (!raw.startsWith("mdcms_oat_")) return undefined;
      const [row] = await db
        .select({
          grant: oauthGrants,
          scopes: oauthTokens.scopes,
          email: authUsers.email,
        })
        .from(oauthTokens)
        .innerJoin(oauthFamilies, eq(oauthFamilies.id, oauthTokens.familyId))
        .innerJoin(oauthGrants, eq(oauthGrants.id, oauthFamilies.grantId))
        .innerJoin(authUsers, eq(authUsers.id, oauthGrants.userId))
        .where(
          and(
            eq(oauthTokens.hash, hashCredential(raw)),
            eq(oauthTokens.kind, "access"),
            gt(oauthTokens.expiresAt, now()),
            gt(oauthFamilies.expiresAt, now()),
            isNull(oauthFamilies.revokedAt),
            isNull(oauthGrants.revokedAt),
            eq(oauthGrants.resource, resource),
          ),
        );
      if (row)
        await db
          .update(oauthGrants)
          .set({ lastUsedAt: now() })
          .where(eq(oauthGrants.id, row.grant.id));
      return row;
    },
  };
}
export type OAuthStore = ReturnType<typeof createOAuthStore>;
