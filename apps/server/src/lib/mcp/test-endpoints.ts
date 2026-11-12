import { integrationTestDatabaseUrl } from "../integration-test-database.js";

export function mcpIntegrationEndpoints(
  env: NodeJS.ProcessEnv = process.env,
): { databaseUrl: string; serverUrl: string } | undefined {
  if (env.MDCMS_MCP_INTEGRATION !== "1") return undefined;
  const databaseUrl = integrationTestDatabaseUrl({
    ...env,
    MDCMS_REQUIRE_TEST_DATABASE: "1",
  })!;
  let server: URL;
  try {
    server = new URL(env.MDCMS_TEST_SERVER_URL ?? "");
  } catch {
    throw new Error("MCP integration requires an explicit loopback server URL");
  }
  if (
    server.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(server.hostname) ||
    server.username ||
    server.password ||
    server.search ||
    server.hash ||
    server.pathname !== "/"
  ) {
    throw new Error(
      "MCP integration requires a loopback HTTP origin without credentials",
    );
  }
  return { databaseUrl, serverUrl: server.origin };
}
