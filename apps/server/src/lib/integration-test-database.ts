// Database fixtures are opt-in; application configuration cannot select their target.
export function integrationTestDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env.MDCMS_TEST_DATABASE_URL;
  if (!value) {
    if (env.MDCMS_REQUIRE_TEST_DATABASE === "1")
      throw new Error(
        "MDCMS_TEST_DATABASE_URL is required for integration tests",
      );
    return undefined;
  }
  const url = new URL(value);
  if (
    !/^postgres(?:ql)?:$/.test(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/(?:^|[_-])(test|verify)(?:[_-]|$)/i.test(url.pathname.slice(1))
  ) {
    throw new Error(
      "Integration tests require an explicit loopback test or verify database",
    );
  }
  return value;
}
