# Connected apps browser regressions

From the repository root, run:

```bash
bun x playwright test --config packages/studio/src/lib/runtime-ui/app/admin/__tests__/connected-apps/playwright.config.mjs
```

Install Playwright Chromium first (`bun x playwright install chromium`), or set
`MDCMS_TEST_CHROMIUM` to an existing Chromium executable. `MDCMS_TEST_BUN` can
select the Bun executable used to bundle the fixture. `MDCMS_BROWSER_TEST_OUTPUT`
can override the temporary test-results directory.

The tests mount the real panel and providers in a production browser bundle.
Every request is intercepted with fixture responses. No server, database,
container or external service is required. Deferred responses exercise confirmation,
repeat-submission protection, failure retention, successful refetch, and target or
session switches during revocation. These tests do not establish backend OAuth
behavior or compatibility with an agent host.
