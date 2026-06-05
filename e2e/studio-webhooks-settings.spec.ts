import { expect, test, type Page, type Route } from "@playwright/test";

const LOGIN_EMAIL = process.env.E2E_LOGIN_EMAIL ?? "demo@mdcms.local";
const LOGIN_PASSWORD = process.env.E2E_LOGIN_PASSWORD ?? "Demo12345!";

type WebhookConfig = {
  id: string;
  project: string;
  environment: string;
  url: string;
  events: string[];
  active: boolean;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

const webhookConfig: WebhookConfig = {
  id: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
  project: "test-project",
  environment: "production",
  url: "https://example.com/hooks/mdcms",
  events: ["content.published"],
  active: true,
  createdBy: "user-1",
  updatedBy: "user-1",
  createdAt: "2026-06-03T00:00:00.000Z",
  updatedAt: "2026-06-04T00:00:00.000Z",
};

async function json(route: Route, data: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(data),
  });
}

async function loginAndOpenWebhooks(page: Page): Promise<void> {
  const settingsPath = "/admin/settings";
  const loginPath = `/admin/login?returnTo=${encodeURIComponent(settingsPath)}`;

  await page.goto(loginPath);
  await page.getByRole("textbox", { name: "Email" }).fill(LOGIN_EMAIL);
  await page.getByRole("textbox", { name: "Password" }).fill(LOGIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname.endsWith(settingsPath));
  await page.getByRole("link", { name: "Webhooks" }).click();
  await page.waitForURL((url) =>
    url.pathname.endsWith("/admin/settings/webhooks"),
  );
}

test.describe("Studio Settings Webhooks", () => {
  test("admins can open create edit and delete controls with routed webhook data", async ({
    page,
  }) => {
    await page.route("**/api/v1/webhooks/deliveries**", async (route) => {
      await json(route, { data: [] });
    });
    await page.route("**/api/v1/webhooks", async (route) => {
      if (route.request().method() === "GET") {
        await json(route, { data: [webhookConfig] });
        return;
      }

      await json(route, {
        data: {
          ...webhookConfig,
          url: "https://example.com/hooks/new",
          events: ["content.published", "media.uploaded"],
        },
      });
    });
    await page.route("**/api/v1/webhooks/*", async (route) => {
      if (route.request().method() === "DELETE") {
        await json(route, { data: { deleted: true, id: webhookConfig.id } });
        return;
      }

      await json(route, { data: webhookConfig });
    });

    await loginAndOpenWebhooks(page);

    await expect(page.getByRole("heading", { name: "Webhooks" })).toBeVisible();
    await expect(page.getByText("Webhook configurations")).toBeVisible();
    await expect(page.getByText(webhookConfig.url)).toBeVisible();

    await page.getByRole("link", { name: "Create webhook" }).click();
    await page.waitForURL((url) =>
      url.pathname.endsWith("/admin/settings/webhooks/new"),
    );
    await expect(
      page.getByRole("heading", { name: "Create webhook" }),
    ).toBeVisible();
    await page.getByLabel("URL").fill("https://example.com/hooks/new");
    await page.getByRole("button", { name: /Published content:/ }).click();
    await page.getByRole("button", { name: /Media uploaded:/ }).click();
    await expect(page.getByLabel("Signing secret")).toHaveValue(/^whsec_/);
    await page.getByRole("button", { name: "Create webhook" }).click();
    await page.waitForURL((url) =>
      url.pathname.endsWith("/admin/settings/webhooks"),
    );

    await page
      .getByRole("link", { name: `Edit webhook ${webhookConfig.id}` })
      .click();
    await page.waitForURL((url) =>
      url.pathname.endsWith(`/admin/settings/webhooks/${webhookConfig.id}`),
    );
    await expect(
      page.getByRole("heading", { name: "Edit webhook" }),
    ).toBeVisible();
    await expect(page.getByLabel("Rotate signing secret")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.waitForURL((url) =>
      url.pathname.endsWith("/admin/settings/webhooks"),
    );

    await page
      .getByRole("button", { name: `Delete webhook ${webhookConfig.id}` })
      .click();
    await expect(
      page.getByRole("dialog").getByRole("heading", {
        name: "Delete webhook",
      }),
    ).toBeVisible();
  });
});
