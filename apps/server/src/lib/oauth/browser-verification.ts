import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserContext } from "@playwright/test";

/** Optional real-browser checks against the mounted OAuth handler. */
export async function verifyConsentBrowser(input: {
  executablePath: string;
  handler: (request: Request) => Promise<Response>;
  authorizeUrl: string;
  cookie: string;
}) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({
    executablePath: input.executablePath,
    headless: true,
  });
  const callbacks: IncomingMessage[] = [];
  const callbackServer = createServer((request, response) => {
    callbacks.push(request);
    response.end("Callback received");
  });
  await new Promise<void>((resolve) =>
    callbackServer.listen(0, "127.0.0.1", resolve),
  );
  const authorizeUrl = new URL(input.authorizeUrl);
  const callback = new URL(
    `http://127.0.0.1:${(callbackServer.address() as AddressInfo).port}/callback`,
  );
  authorizeUrl.searchParams.set("redirect_uri", callback.href);
  const origin = authorizeUrl.origin;
  const mount = async (context: BrowserContext, cookie?: string) => {
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (new URL(request.url()).origin === callback.origin) {
        await route.continue();
        return;
      }
      assert.equal(new URL(request.url()).origin, origin);
      const headers = {
        ...(await request.allHeaders()),
        ...(cookie ? { cookie } : {}),
      };
      const response = await input.handler(
        new Request(request.url(), {
          method: request.method(),
          headers,
          ...(request.postData() !== null ? { body: request.postData()! } : {}),
        }),
      );
      const outgoing: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        outgoing[key] = value;
      });
      delete outgoing["set-cookie"];
      await route.fulfill({
        status: response.status,
        headers: outgoing,
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
  };
  try {
    const anonymous = await browser.newContext({
      javaScriptEnabled: false,
      userAgent: "research-client/1.0",
    });
    await mount(anonymous);
    const login = await anonymous.newPage();
    const urls: string[] = [];
    login.on("request", (request) => urls.push(request.url()));
    await login.goto(authorizeUrl.href);
    await login.getByLabel("Email").fill("browser-fixture@example.invalid");
    await login.getByLabel("Password").fill("browser-fixture-password");
    const submitted = login.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/v1/auth/login",
    );
    await login.getByRole("button", { name: "Sign in" }).click();
    const loginRequest = await submitted;
    assert.equal(loginRequest.method(), "POST");
    assert.match(
      loginRequest.postData() ?? "",
      /password=browser-fixture-password/,
    );
    assert.equal(
      urls.some((url) => /browser-fixture|password=|email=/.test(url)),
      false,
    );
    await anonymous.close();

    for (const decision of ["Allow", "Deny"]) {
      const context = await browser.newContext({
        userAgent: "research-client/1.0",
      });
      await mount(context, input.cookie);
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(5000);
      const violations: string[] = [];
      page.on("console", (message) => {
        if (message.text().includes("form-action"))
          violations.push(message.text());
      });
      await page.goto(authorizeUrl.href);
      await Promise.all([
        page.waitForURL((url) => url.origin === callback.origin),
        page
          .getByRole("button", { name: decision, exact: true })
          .first()
          .click(),
      ]);
      const result = new URL(page.url());
      if (decision === "Allow") assert.ok(result.searchParams.get("code"));
      else assert.equal(result.searchParams.get("error"), "access_denied");
      assert.deepEqual(violations, []);
      await context.close();
    }
    assert.equal(callbacks.length, 2);
    assert.ok(
      callbacks.every((request) => request.headers.referer === undefined),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      callbackServer.close((error) => (error ? reject(error) : resolve())),
    );
    await browser.close();
  }
}
