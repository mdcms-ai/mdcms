import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.browser.mjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: "list",
  outputDir:
    process.env.MDCMS_BROWSER_TEST_OUTPUT ??
    join(tmpdir(), "mdcms-connected-apps-test-results"),
  use: {
    browserName: "chromium",
    headless: true,
    userAgent: "research-client/1.0",
    launchOptions: process.env.MDCMS_TEST_CHROMIUM
      ? { executablePath: process.env.MDCMS_TEST_CHROMIUM }
      : {},
  },
});
