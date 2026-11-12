"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { OAuthConnection } from "@mdcms/shared";
import { createOAuthConnectionsApi } from "../../lib/oauth-connections-api.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../components/ui/dialog.js";
import { Button } from "../../components/ui/button.js";
import { useStudioMountInfo } from "./mount-info-context.js";
import { useStudioSession } from "./session-context.js";

export function SettingsConnectedAppsPanel() {
  const mount = useStudioMountInfo();
  const session = useStudioSession();
  const identity = JSON.stringify([
    mount.apiBaseUrl,
    mount.project,
    mount.environment,
    mount.auth.mode,
    session.status === "authenticated" ? session.session.id : session.status,
  ]);
  return <ConnectedAppsTarget key={identity} />;
}
function ConnectedAppsTarget() {
  const mount = useStudioMountInfo();
  const session = useStudioSession();
  const client = useQueryClient();
  const [selected, setSelected] = useState<OAuthConnection | null>(null);
  const authenticated =
    mount.auth.mode !== "token" && session.status === "authenticated";
  const queryKey = [
    "studio",
    "oauth-connections",
    mount.apiBaseUrl,
    mount.project,
    authenticated ? session.session.userId : null,
    authenticated ? session.session.id : null,
  ];
  const api = createOAuthConnectionsApi(
    { serverUrl: mount.apiBaseUrl, project: mount.project ?? "" },
    {
      auth: mount.auth,
      ...(authenticated ? { csrfToken: session.csrfToken } : {}),
    },
  );
  const query = useQuery({
    queryKey,
    enabled: authenticated && Boolean(mount.project),
    queryFn: () => api.list(),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revoke(id),
    onSuccess: async () => {
      setSelected(null);
      await client.invalidateQueries({ queryKey, exact: true });
    },
  });
  return (
    <section className="space-y-5">
      <div>
        <h2 className="font-heading text-[30px] font-semibold text-foreground">
          Connected apps
        </h2>
        <p className="mt-1 text-sm text-foreground-muted">
          Review and revoke access to this project. Client names are reported by
          apps and are unverified.
        </p>
      </div>
      {mount.auth.mode === "token" || session.status === "unauthenticated" ? (
        <p>Sign in with a session to manage connected apps.</p>
      ) : session.status === "error" || session.status === "token-error" ? (
        <p role="alert">Session unavailable. Sign in again.</p>
      ) : !mount.project ? (
        <p>Select a project to view connected apps.</p>
      ) : !authenticated || query.isPending ? (
        <p role="status">Loading connected apps…</p>
      ) : (
        <>
          {query.error && (
            <div role="alert">
              Unable to refresh connected apps. {query.error.message}{" "}
              <Button variant="secondary" onClick={() => void query.refetch()}>
                Retry
              </Button>
            </div>
          )}
          {query.data?.length === 0 && <p>No connected apps.</p>}
          <div className="space-y-3">
            {query.data?.map((connection) => (
              <article
                key={connection.id}
                className="space-y-3 rounded-lg border border-card-border bg-card p-5 break-words"
              >
                <h3 className="font-semibold">
                  {connection.clientName}{" "}
                  <span className="text-xs text-foreground-muted">
                    (unverified)
                  </span>
                </h3>
                <dl className="grid gap-2 text-sm sm:grid-cols-[120px_minmax(0,1fr)]">
                  <dt>User</dt>
                  <dd>{connection.userId}</dd>
                  <dt>Target</dt>
                  <dd>
                    {connection.project} / {connection.environment}
                  </dd>
                  <dt>Scopes</dt>
                  <dd>{connection.scopes.join(", ")}</dd>
                  <dt>Created</dt>
                  <dd>{connection.createdAt}</dd>
                  <dt>Last used</dt>
                  <dd>{connection.lastUsedAt ?? "Never used"}</dd>
                </dl>
                <Button
                  variant="secondary"
                  disabled={revoke.isPending}
                  onClick={() => {
                    revoke.reset();
                    setSelected(connection);
                  }}
                >
                  Revoke access
                </Button>
              </article>
            ))}
          </div>
          {selected && (
            <Dialog
              open
              onOpenChange={(open) => {
                if (!open && !revoke.isPending) setSelected(null);
              }}
            >
              <DialogContent showCloseButton={!revoke.isPending}>
                <DialogHeader>
                  <DialogTitle>Revoke app access</DialogTitle>
                  <DialogDescription>
                    Revoke {selected.clientName} (unverified) for{" "}
                    {selected.userId} in {selected.project} /{" "}
                    {selected.environment}?
                  </DialogDescription>
                </DialogHeader>
                <p className="text-sm text-foreground-muted">
                  This ends this connection’s access. The app must connect again
                  to regain access.
                </p>
                {revoke.error && (
                  <p role="alert">
                    {revoke.error.message} Access has not been confirmed
                    revoked. Try again.
                  </p>
                )}
                <DialogFooter>
                  <Button
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(selected.id)}
                  >
                    {revoke.isPending ? "Revoking…" : "Confirm revoke"}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={revoke.isPending}
                    onClick={() => setSelected(null)}
                  >
                    Cancel
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </>
      )}
    </section>
  );
}
