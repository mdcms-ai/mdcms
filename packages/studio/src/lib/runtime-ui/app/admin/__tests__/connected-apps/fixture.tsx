import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StudioMountInfoProvider } from "../../mount-info-context.js";
import { StudioSessionProvider } from "../../session-context.js";
import { SettingsConnectedAppsPanel } from "../../settings-connected-apps-panel.js";

declare global {
  interface Window {
    connectedAppsFixture: {
      setProject: (project: string) => void;
      setUser: (user: string) => void;
      setToken: (token: boolean) => void;
      invalidate: () => Promise<void>;
      pendingMutations: () => number;
    };
  }
}
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
function Fixture() {
  const [project, setProject] = useState("demo");
  const [user, setUser] = useState("member");
  const [token, setToken] = useState(false);
  window.connectedAppsFixture = {
    setProject,
    setUser,
    setToken,
    pendingMutations: () => client.isMutating(),
    invalidate: () =>
      client.invalidateQueries({ queryKey: ["studio", "oauth-connections"] }),
  };
  return (
    <QueryClientProvider client={client}>
      <StudioMountInfoProvider
        value={{
          project,
          environment: "draft",
          apiBaseUrl: location.origin,
          auth: token
            ? { mode: "token", token: "fixture-key" }
            : { mode: "cookie" },
          environments: [],
          hostBridge: null,
          setEnvironment: () => {},
        }}
      >
        <StudioSessionProvider
          value={{
            status: "authenticated",
            csrfToken: "fixture-csrf",
            session: {
              id: `session-${user}`,
              userId: user,
              email: `${user}@example.com`,
              issuedAt: "2026-01-01",
              expiresAt: "2027-01-01",
            },
          }}
        >
          <SettingsConnectedAppsPanel />
        </StudioSessionProvider>
      </StudioMountInfoProvider>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
