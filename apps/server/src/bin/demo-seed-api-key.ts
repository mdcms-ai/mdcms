import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, isNull } from "drizzle-orm";
import { RuntimeError } from "@mdcms/shared";
import { createAuthService } from "../lib/auth.js";
import { createDatabaseContentStore } from "../lib/content-api.js";
import { createDatabaseConnection } from "../lib/db.js";
import { apiKeys, authUsers, rbacGrants } from "../lib/db/schema.js";
import { ensureDemoSchemaSynced } from "../lib/demo-seed.js";

const API_KEY_PREFIX = "mdcms_key_";
const DEFAULT_DEMO_API_KEY = "mdcms_key_demo_local_compose_seed_2026_read";
const DEFAULT_DEMO_USER_EMAIL = "demo@mdcms.local";
const DEFAULT_DEMO_USER_NAME = "Demo User";
const DEFAULT_DEMO_USER_PASSWORD = "Demo12345!";
const DEFAULT_DEMO_PROJECT = "marketing-site";
const DEFAULT_DEMO_ENVIRONMENT = "staging";
const DEFAULT_DEMO_CONTENT_ACTOR_ID = "00000000-0000-0000-0000-000000000001";
const DEMO_KEY_LABEL = "compose-dev-demo";
const DEMO_KEY_SCOPES = [
  "content:read",
  "content:read:draft",
  "content:write",
  "content:delete",
  "schema:read",
  "schema:write",
] as const;
const LOCAL_AUTH_ORIGIN = "http://localhost";
const DEMO_CONTENT_CHANGE_SUMMARY = "compose demo seed";

type DemoSeedDocument = {
  key: string;
  type: string;
  path: string;
  locale: string;
  format: "md" | "mdx";
  frontmatter: Record<string, unknown>;
  body: string;
  publish: boolean;
  sourceKey?: string;
};

const DEMO_CONTENT_DOCUMENTS: readonly DemoSeedDocument[] = [
  {
    key: "post:hello-mdcms:en",
    type: "post",
    path: "content/posts/hello-mdcms",
    locale: "en",
    format: "md",
    frontmatter: {
      title: "Hello MDCMS",
      slug: "hello-mdcms",
      excerpt: "Seeded demo post generated for compose runs.",
    },
    body: [
      "# Hello MDCMS",
      "",
      "This is seeded demo content for local pull/push verification.",
      "",
      "- created by `demo:seed`",
      "- project: marketing-site",
      "- environment: staging",
      "",
      "Edit this file locally, run `mdcms push`, and refresh `/demo/content`.",
    ].join("\n"),
    publish: true,
  },
  {
    key: "post:pull-push-demo:en",
    type: "post",
    path: "content/posts/pull-push-demo",
    locale: "en",
    format: "md",
    frontmatter: {
      title: "Pull Push Demo",
      slug: "pull-push-demo",
      excerpt: "Second seeded post used by demo workflow.",
      tags: ["demo", "cli"],
    },
    body: [
      "# Pull Push Demo",
      "",
      "This document exists to prove draft sync with CLI commands.",
      "",
      "1. `mdcms pull`",
      "2. edit local markdown",
      "3. `mdcms push`",
      "4. open `/demo/content`",
    ].join("\n"),
    publish: true,
  },
  {
    key: "page:home:en",
    type: "page",
    path: "content/pages/home",
    locale: "en",
    format: "mdx",
    frontmatter: {
      title: "MDCMS Demo Home",
      slug: "home",
      seoTitle: "MDCMS Demo",
    },
    body: [
      '<HomeHero eyebrow="MDCMS demo" title="Content operations without giving up local files" summary="MDCMS keeps editorial work, local Markdown workflows, and application previews on the same content contract." primaryHref="/pages" primaryLabel="Browse pages" secondaryHref="/admin" secondaryLabel="Open Studio">',
      "  <HomeFeatureGrid>",
      '    <HomeFeature title="Draft pages">Render the same page document in the consumer app, preview route, and SDK demo.</HomeFeature>',
      '    <HomeFeature title="Local files">Pull the document into Markdown, edit locally, and push it back into the draft history.</HomeFeature>',
      '    <HomeFeature title="Studio editing">Open the same document in Studio when an editor needs a visual workflow.</HomeFeature>',
      "  </HomeFeatureGrid>",
      "</HomeHero>",
      "",
      '<HomeSection eyebrow="One content layer" title="Use the same documents across every surface." summary="The homepage route is only a renderer. The sections, actions, and supporting copy below all live in this page body.">',
      "  <HomeFeatureGrid>",
      '    <HomeFeature title="Pages first">Browse page documents before posts so the site hierarchy is easy to scan.</HomeFeature>',
      '    <HomeFeature title="Rendered previews">Cards render Markdown and MDX components instead of dumping raw body text.</HomeFeature>',
      '    <HomeFeature title="Shared history">Agents, editors, and CLI users all write to the same versioned document.</HomeFeature>',
      "  </HomeFeatureGrid>",
      "</HomeSection>",
      "",
      '<HomeSection eyebrow="Agent-ready" title="AI edits should behave like product edits." summary="The demo keeps AI proposals grounded in the current document and routes every accepted change through validation before it becomes draft content.">',
      "  <HomeFeatureGrid>",
      '    <HomeFeature title="Structured proposals">Suggested edits are validated before the editor can accept them.</HomeFeature>',
      '    <HomeFeature title="Retry on errors">Invalid proposals are rejected automatically and get one correction attempt.</HomeFeature>',
      '    <HomeFeature title="Visible progress">The assistant can stream model progress and tool-cost signals while work is pending.</HomeFeature>',
      "  </HomeFeatureGrid>",
      "</HomeSection>",
      "",
      '<HomeCta title="Inspect the same body through the SDK." href="/demo/sdk-content" label="Open SDK library">The SDK route renders pages, posts, and campaigns from the same draft scope used by this homepage.</HomeCta>',
    ].join("\n"),
    publish: true,
  },
  {
    key: "page:about:en",
    type: "page",
    path: "content/pages/about",
    locale: "en",
    format: "mdx",
    frontmatter: {
      title: "About Demo",
      slug: "about",
      seoTitle: "MDCMS Demo About",
    },
    body: [
      "# About this demo",
      "",
      "The sample stack seeds:",
      "",
      "- one demo user",
      "- one fixed demo API key",
      "- sample content documents",
    ].join("\n"),
    publish: true,
  },
  {
    key: "campaign:global-launch:en",
    type: "campaign",
    path: "content/campaigns/global-launch",
    locale: "en",
    format: "md",
    frontmatter: {
      title: "Global Launch",
      slug: "global-launch",
      summary: "English launch copy seeded for localized overview testing.",
    },
    body: [
      "# Global Launch",
      "",
      "This localized demo document is the default English campaign source.",
      "",
      "- locale: en",
      "- translation group: global-launch",
      "- created by `demo:seed`",
    ].join("\n"),
    publish: true,
  },
  {
    key: "campaign:global-launch:fr",
    sourceKey: "campaign:global-launch:en",
    type: "campaign",
    path: "content/campaigns/global-launch",
    locale: "fr",
    format: "md",
    frontmatter: {
      title: "Lancement mondial",
      slug: "lancement-mondial",
      summary: "Copie francaise generee pour tester les variantes localisees.",
    },
    body: [
      "# Lancement mondial",
      "",
      "Cette variante partage le meme groupe de traduction que la campagne anglaise.",
      "",
      "- langue: fr",
      "- groupe de traduction: global-launch",
      "- cree par `demo:seed`",
    ].join("\n"),
    publish: true,
  },
];

function resolveEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function hashApiKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toKeyPrefix(apiKey: string): string {
  const visible = API_KEY_PREFIX.length + 8;
  return `${apiKey.slice(0, visible)}...`;
}

function assertDemoApiKeyFormat(apiKey: string): void {
  if (!apiKey.startsWith(API_KEY_PREFIX)) {
    throw new Error(
      `MDCMS_DEMO_API_KEY must start with "${API_KEY_PREFIX}" prefix.`,
    );
  }
}

function assertUuid(value: string, field: string): string {
  const normalized = value.trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      normalized,
    )
  ) {
    throw new Error(`${field} must be a valid UUID.`);
  }

  return normalized;
}

function toErrorText(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }

  if (!input || typeof input !== "object") {
    return String(input);
  }

  const record = input as Record<string, unknown>;
  const message = record.message;
  const code = record.code;
  return `${typeof code === "string" ? `${code}: ` : ""}${typeof message === "string" ? message : JSON.stringify(input)}`;
}

async function parseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined);
}

async function ensureDemoUser(input: {
  db: ReturnType<typeof createDatabaseConnection>["db"];
  authService: ReturnType<typeof createAuthService>;
  email: string;
  name: string;
  password: string;
}): Promise<string> {
  const existing = await input.db.query.authUsers.findFirst({
    where: eq(authUsers.email, input.email),
  });

  const signUp = async (): Promise<string> => {
    const response = await input.authService.handleAuthRequest(
      new Request(`${LOCAL_AUTH_ORIGIN}/api/v1/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: input.email,
          password: input.password,
          name: input.name,
        }),
      }),
    );

    if (!response.ok) {
      const payload = await parseJson(response);
      throw new Error(
        `failed to create demo login user (${response.status}): ${toErrorText(payload)}`,
      );
    }

    const created = await input.db.query.authUsers.findFirst({
      where: eq(authUsers.email, input.email),
    });

    if (!created) {
      throw new Error("Demo login user was not persisted after sign-up.");
    }

    return created.id;
  };

  const canLogin = async (): Promise<boolean> => {
    try {
      await input.authService.login(
        new Request(`${LOCAL_AUTH_ORIGIN}/api/v1/auth/login`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
        }),
        input.email,
        input.password,
      );
      return true;
    } catch (error) {
      if (
        error instanceof RuntimeError &&
        error.code === "AUTH_INVALID_CREDENTIALS"
      ) {
        return false;
      }

      throw error;
    }
  };

  if (!existing) {
    return signUp();
  }

  if (await canLogin()) {
    return existing.id;
  }

  await input.db
    .delete(apiKeys)
    .where(eq(apiKeys.createdByUserId, existing.id));
  await input.db.delete(rbacGrants).where(eq(rbacGrants.userId, existing.id));
  await input.db.delete(authUsers).where(eq(authUsers.id, existing.id));

  return signUp();
}

async function ensureDemoApiKey(input: {
  db: ReturnType<typeof createDatabaseConnection>["db"];
  userId: string;
  apiKey: string;
  project: string;
  environment: string;
}): Promise<void> {
  const keyHash = hashApiKey(input.apiKey);
  const existing = await input.db.query.apiKeys.findFirst({
    where: eq(apiKeys.keyHash, keyHash),
  });

  if (existing) {
    const currentAllowlist = Array.isArray(existing.contextAllowlist)
      ? (existing.contextAllowlist as Array<{
          project: string;
          environment: string;
        }>)
      : [];
    const alreadyPresent = currentAllowlist.some(
      (entry) =>
        entry.project === input.project &&
        entry.environment === input.environment,
    );
    const mergedAllowlist = alreadyPresent
      ? currentAllowlist
      : [
          ...currentAllowlist,
          { project: input.project, environment: input.environment },
        ];

    await input.db
      .update(apiKeys)
      .set({
        label: DEMO_KEY_LABEL,
        keyPrefix: toKeyPrefix(input.apiKey),
        scopes: [...DEMO_KEY_SCOPES],
        contextAllowlist: mergedAllowlist,
        expiresAt: null,
        revokedAt: null,
        createdByUserId: input.userId,
      })
      .where(eq(apiKeys.id, existing.id));

    return;
  }

  await input.db.insert(apiKeys).values({
    label: DEMO_KEY_LABEL,
    keyPrefix: toKeyPrefix(input.apiKey),
    keyHash,
    scopes: [...DEMO_KEY_SCOPES],
    contextAllowlist: [
      {
        project: input.project,
        environment: input.environment,
      },
    ],
    expiresAt: null,
    createdByUserId: input.userId,
  });
}

async function ensureDemoRbacGrant(input: {
  db: ReturnType<typeof createDatabaseConnection>["db"];
  userId: string;
  project: string;
}): Promise<void> {
  const existing = await input.db.query.rbacGrants.findFirst({
    where: and(
      eq(rbacGrants.userId, input.userId),
      eq(rbacGrants.scopeKind, "project"),
      eq(rbacGrants.project, input.project),
      isNull(rbacGrants.revokedAt),
    ),
  });

  // admin/owner roles require global scope per RBAC rules.
  // A global admin grant covers all projects including the demo one.
  if (existing) {
    if (existing.role !== "admin" || existing.scopeKind !== "global") {
      await input.db
        .update(rbacGrants)
        .set({ role: "admin", scopeKind: "global", project: null })
        .where(eq(rbacGrants.id, existing.id));
    }
    return;
  }

  await input.db.insert(rbacGrants).values({
    userId: input.userId,
    role: "admin",
    scopeKind: "global",
    source: "demo-seed",
    createdByUserId: input.userId,
  });
}

async function ensureDemoContent(input: {
  db: ReturnType<typeof createDatabaseConnection>["db"];
  actorId: string;
  project: string;
  environment: string;
}): Promise<number> {
  const store = createDatabaseContentStore({ db: input.db });
  const seededDocuments = new Map<string, { documentId: string }>();
  let seededCount = 0;

  for (const template of DEMO_CONTENT_DOCUMENTS) {
    const listed = await store.list(
      {
        project: input.project,
        environment: input.environment,
      },
      {
        draft: "true",
        type: template.type,
        path: template.path,
        locale: template.locale,
        limit: "100",
        offset: "0",
      },
    );

    const existing = listed.rows.find(
      (row) =>
        row.type === template.type &&
        row.path === template.path &&
        row.locale === template.locale &&
        row.isDeleted === false,
    );

    if (existing) {
      const bodyChanged = existing.body !== template.body;
      // Postgres JSONB does not guarantee key-insertion order on read, so a
      // string compare against the seed template would flag spurious changes
      // whenever the driver/database returned the same keys in a different
      // order. Compare structurally instead.
      const frontmatterChanged = !isDeepStrictEqual(
        existing.frontmatter ?? {},
        template.frontmatter ?? {},
      );

      if (bodyChanged || frontmatterChanged) {
        await store.update(
          {
            project: input.project,
            environment: input.environment,
          },
          existing.documentId,
          {
            frontmatter: template.frontmatter,
            body: template.body,
            updatedBy: input.actorId,
          },
        );
      }

      const needsPublish =
        template.publish &&
        (existing.publishedVersion === null ||
          bodyChanged ||
          frontmatterChanged);

      if (needsPublish) {
        await store.publish(
          {
            project: input.project,
            environment: input.environment,
          },
          existing.documentId,
          {
            actorId: input.actorId,
            changeSummary: DEMO_CONTENT_CHANGE_SUMMARY,
          },
        );
      }

      seededDocuments.set(template.key, {
        documentId: existing.documentId,
      });
      seededCount += 1;
      continue;
    }

    const sourceDocumentId = template.sourceKey
      ? seededDocuments.get(template.sourceKey)?.documentId
      : undefined;

    if (template.sourceKey && !sourceDocumentId) {
      throw new Error(
        `Demo seed source document ${template.sourceKey} was not available before creating ${template.key}.`,
      );
    }

    const created = await store.create(
      {
        project: input.project,
        environment: input.environment,
      },
      {
        type: template.type,
        path: template.path,
        locale: template.locale,
        format: template.format,
        frontmatter: template.frontmatter,
        body: template.body,
        createdBy: input.actorId,
        updatedBy: input.actorId,
        ...(sourceDocumentId ? { sourceDocumentId } : {}),
      },
    );

    if (template.publish) {
      await store.publish(
        {
          project: input.project,
          environment: input.environment,
        },
        created.documentId,
        {
          actorId: input.actorId,
          changeSummary: DEMO_CONTENT_CHANGE_SUMMARY,
        },
      );
    }

    seededDocuments.set(template.key, {
      documentId: created.documentId,
    });
    seededCount += 1;
  }

  return seededCount;
}

async function main(): Promise<void> {
  const apiKey = resolveEnv("MDCMS_DEMO_API_KEY", DEFAULT_DEMO_API_KEY);
  const demoUserEmail = resolveEnv(
    "MDCMS_DEMO_SEED_USER_EMAIL",
    DEFAULT_DEMO_USER_EMAIL,
  );
  const demoUserName = resolveEnv(
    "MDCMS_DEMO_SEED_USER_NAME",
    DEFAULT_DEMO_USER_NAME,
  );
  const demoUserPassword = resolveEnv(
    "MDCMS_DEMO_SEED_USER_PASSWORD",
    DEFAULT_DEMO_USER_PASSWORD,
  );
  const project = resolveEnv("MDCMS_DEMO_PROJECT", DEFAULT_DEMO_PROJECT);
  const environment = resolveEnv(
    "MDCMS_DEMO_ENVIRONMENT",
    DEFAULT_DEMO_ENVIRONMENT,
  );
  const contentActorId = assertUuid(
    resolveEnv("MDCMS_DEMO_CONTENT_ACTOR_ID", DEFAULT_DEMO_CONTENT_ACTOR_ID),
    "MDCMS_DEMO_CONTENT_ACTOR_ID",
  );

  assertDemoApiKeyFormat(apiKey);

  const connection = createDatabaseConnection({ env: process.env });
  const authService = createAuthService({
    db: connection.db,
    env: process.env,
  });

  try {
    await ensureDemoSchemaSynced({
      db: connection.db,
      project,
      environment,
    });

    const userId = await ensureDemoUser({
      db: connection.db,
      authService,
      email: demoUserEmail,
      name: demoUserName,
      password: demoUserPassword,
    });

    await ensureDemoApiKey({
      db: connection.db,
      userId,
      apiKey,
      project,
      environment,
    });

    await ensureDemoRbacGrant({
      db: connection.db,
      userId,
      project,
    });

    const seededDocuments = await ensureDemoContent({
      db: connection.db,
      actorId: contentActorId,
      project,
      environment,
    });

    console.info(
      `[demo-seed] ensured demo login user ${demoUserEmail}, demo API key, and ${seededDocuments} seeded documents for ${project}/${environment} (${toKeyPrefix(apiKey)})`,
    );
  } finally {
    await connection.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[demo-seed] failed: ${message}`);
  process.exitCode = 1;
});
