import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

let directory;
let bundle;
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mdcms-connections-browser-"));
  const output = join(directory, "fixture.js");
  const build = spawnSync(
    process.env.MDCMS_TEST_BUN ?? "bun",
    [
      "build",
      join(dirname(fileURLToPath(import.meta.url)), "fixture.tsx"),
      "--target=browser",
      "--production",
      "--conditions=@mdcms/source",
      "--define",
      'process.env.NODE_ENV="production"',
      "--outfile",
      output,
    ],
    { encoding: "utf8", env: { ...process.env, NODE_ENV: "production" } },
  );
  expect(build.status, build.stderr).toBe(0);
  bundle = await readFile(output);
});
test.afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

const connection = (id = "grant", project = "demo", userId = "member") => ({
  id,
  clientId: "fixture-client",
  clientName: `Research assistant ${id}`,
  userId,
  project,
  environment: "draft",
  scopes: ["content:read:draft"],
  createdAt: "2026-11-01T10:00:00Z",
  lastUsedAt: null,
});
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function mount(page, handleApi) {
  page.on("pageerror", (error) => {
    console.error(error);
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://fixture.test")
      throw new Error(`Unexpected fixture origin: ${url.origin}`);
    if (url.pathname.startsWith("/api/")) return handleApi(route);
    if (url.pathname === "/fixture.js")
      return route.fulfill({ contentType: "text/javascript", body: bundle });
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<div id="root"></div><script type="module" src="/fixture.js"></script>',
      });
    return route.abort();
  });
  await page.goto("http://fixture.test/");
}

test("confirmation, pending protection, failure retention and successful refetch", async ({
  page,
}) => {
  let deletes = 0;
  let reads = 0;
  let revoked = false;
  const pending = deferred();
  await mount(page, async (route) => {
    const request = route.request();
    expect(request.headers()["x-mdcms-project"]).toBe("demo");
    if (request.method() === "GET") {
      reads++;
      return route.fulfill({ json: { data: revoked ? [] : [connection()] } });
    }
    expect(request.url()).toBe(
      "http://fixture.test/api/v1/oauth/connections/grant",
    );
    expect(request.headers()["x-mdcms-csrf-token"]).toBe("fixture-csrf");
    deletes++;
    if (deletes === 1) {
      await pending.promise;
      return route.fulfill({
        status: 503,
        json: { message: "Temporary service failure" },
      });
    }
    revoked = true;
    return route.fulfill({ json: { data: { id: "grant", revoked: true } } });
  });
  await page
    .getByRole("button", { name: "Revoke access", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Revoke app access" });
  await expect(dialog).toContainText(
    "Research assistant grant (unverified) for member in demo / draft",
  );
  expect(deletes).toBe(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(deletes).toBe(0);
  await page
    .getByRole("button", { name: "Revoke access", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Confirm revoke" }).click();
  await expect.poll(() => deletes).toBe(1);
  const submitting = dialog.getByRole("button", { name: "Revoking…" });
  await expect(submitting).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await submitting.evaluate((button) => {
    button.click();
    button.click();
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  expect(deletes).toBe(1);
  expect(reads).toBe(1);
  pending.resolve();
  await expect(dialog.getByRole("alert")).toContainText(
    "Temporary service failure",
  );
  await expect(page.locator("article")).toHaveCount(1);
  expect(reads).toBe(1);
  await dialog.getByRole("button", { name: "Confirm revoke" }).click();
  await expect(page.getByText("No connected apps.")).toBeVisible();
  await expect(dialog).toHaveCount(0);
  expect(deletes).toBe(2);
  expect(reads).toBe(2);
});

for (const dimension of ["project", "session"]) {
  test(`${dimension} switch isolates a pending revocation and its late response`, async ({
    page,
  }) => {
    const pending = deferred();
    let switched = false;
    let deletes = 0;
    let currentReads = 0;
    let completed = false;
    await mount(page, async (route) => {
      const request = route.request();
      if (request.method() === "DELETE") {
        deletes++;
        expect(request.headers()["x-mdcms-project"]).toBe("demo");
        await pending.promise;
        await route.fulfill({ json: { data: { id: "grant", revoked: true } } });
        completed = true;
        return;
      }
      const project =
        switched && dimension === "project" ? "second-project" : "demo";
      expect(request.headers()["x-mdcms-project"]).toBe(project);
      if (switched) currentReads++;
      return route.fulfill({
        json: {
          data: [
            switched
              ? connection(
                  "current",
                  project,
                  dimension === "session" ? "second-user" : "member",
                )
              : connection(),
          ],
        },
      });
    });
    await page
      .getByRole("button", { name: "Revoke access", exact: true })
      .click();
    await page.getByRole("button", { name: "Confirm revoke" }).click();
    await expect.poll(() => deletes).toBe(1);
    switched = true;
    await page.evaluate((dimension) => {
      if (dimension === "project")
        window.connectedAppsFixture.setProject("second-project");
      else window.connectedAppsFixture.setUser("second-user");
    }, dimension);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("article")).toContainText(
      "Research assistant current",
    );
    await expect(page.locator("article")).not.toContainText(
      "Research assistant grant",
    );
    expect(currentReads).toBe(1);
    // A new confirmation must survive completion of the old target's mutation.
    await page
      .getByRole("button", { name: "Revoke access", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      "Research assistant current",
    );
    pending.resolve();
    await expect.poll(() => completed).toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() => window.connectedAppsFixture.pendingMutations()),
      )
      .toBe(0);
    await page.evaluate(() => window.connectedAppsFixture.invalidate());
    await expect(page.locator("article")).toContainText(
      "Research assistant current",
    );
    await expect(page.getByRole("dialog")).toContainText(
      "Research assistant current",
    );
    expect(deletes).toBe(1);
    expect(currentReads).toBe(2);
  });
}

test("token mode makes no management fetch even after cache invalidation", async ({
  page,
}) => {
  let reads = 0;
  await mount(page, async (route) => {
    expect(route.request().method()).toBe("GET");
    reads++;
    return route.fulfill({ json: { data: [connection()] } });
  });
  await expect(page.locator("article")).toHaveCount(1);
  await page.evaluate(() => window.connectedAppsFixture.setToken(true));
  await expect(
    page.getByText("Sign in with a session to manage connected apps."),
  ).toBeVisible();
  await page.evaluate(() => window.connectedAppsFixture.invalidate());
  await expect(page.locator("article")).toHaveCount(0);
  expect(reads).toBe(1);
});
