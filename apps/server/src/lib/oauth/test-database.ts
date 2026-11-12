import { test } from "bun:test";

// Opt-in only: unit discovery must never probe or mutate the development database.
export function oauthTestDatabase(env: NodeJS.ProcessEnv = process.env) {
  const url = env.MDCMS_TEST_DATABASE_URL;
  if (!url) {
    if (env.MDCMS_OAUTH_INTEGRATION === "1")
      throw new Error(
        "MDCMS_TEST_DATABASE_URL is required for OAuth integration",
      );
    return { url: undefined, test: test.skip };
  }
  const parsed = new URL(url);
  if (
    !/^postgres(?:ql)?:$/.test(parsed.protocol) ||
    !/(?:^|[_-])(test|verify)(?:[_-]|$)/i.test(parsed.pathname.slice(1))
  )
    throw new Error(
      "OAuth integration requires an explicitly named test or verify database",
    );
  // An explicitly configured database is mandatory: connection failures fail tests.
  return { url, test };
}
