import assert from "node:assert/strict";
import { test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StudioMountInfoProvider } from "./mount-info-context.js";
import { StudioSessionProvider } from "./session-context.js";
import { SettingsConnectedAppsPanel } from "./settings-connected-apps-panel.js";

function render(token = false, rows?: unknown[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (rows)
    client.setQueryData(
      [
        "studio",
        "oauth-connections",
        "https://cms.example.com",
        "demo",
        "member",
        "session",
      ],
      rows,
    );
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <StudioMountInfoProvider
        value={{
          apiBaseUrl: "https://cms.example.com",
          project: "demo",
          environment: "draft",
          auth: token
            ? { mode: "token", token: "fixture" }
            : { mode: "cookie" },
          environments: [],
          hostBridge: null,
          setEnvironment: () => {},
        }}
      >
        <StudioSessionProvider
          value={{
            status: "authenticated",
            csrfToken: "fixture",
            session: {
              id: "session",
              userId: "member",
              email: "member@example.com",
              issuedAt: "2026-01-01",
              expiresAt: "2027-01-01",
            },
          }}
        >
          <SettingsConnectedAppsPanel />
        </StudioSessionProvider>
      </StudioMountInfoProvider>
    </QueryClientProvider>,
  );
}
test("token mode shows session sign-in requirement even with cached data", () => {
  const html = render(true, []);
  assert.match(html, /Sign in with a session/);
  assert.doesNotMatch(html, /No connected apps/);
});
test("pending and empty lists have distinct states", () => {
  assert.match(render(), /Loading connected apps/);
  assert.match(render(false, []), /No connected apps/);
});
test("renders server authorized member or admin rows and escapes reported names", () => {
  const rows = ["member", "other-user"].map((userId) => ({
    id: userId,
    clientId: "client",
    clientName: "<img src=x onerror=alert(1)>",
    userId,
    project: "demo",
    environment: "draft",
    scopes: ["content:read:draft"],
    createdAt: "2026-01-01",
    lastUsedAt: null,
  }));
  const html = render(false, rows);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /unverified/);
  assert.match(html, /other-user/);
  assert.match(html, /Never used/);
  assert.match(html, /content:read:draft/);
});

test("labels the granting user and formats dates with exact timestamps available", () => {
  const stamp = "2026-11-01T10:00:00Z";
  const html = render(false, [
    {
      id: "grant",
      clientId: "client",
      clientName: "Research assistant",
      userId: "member",
      project: "demo",
      environment: "draft",
      scopes: [],
      createdAt: stamp,
      lastUsedAt: stamp,
    },
  ]);
  assert.match(html, /<dd>You<\/dd>/);
  assert.ok(
    html.includes(`dateTime="${stamp}"`) ||
      html.includes(`datetime="${stamp}"`),
  );
  assert.ok(html.includes(`title="${stamp}"`));
  assert.ok(html.includes(new Date(stamp).toLocaleString()));
  assert.ok(!html.includes(`>${stamp}</time>`));
});
