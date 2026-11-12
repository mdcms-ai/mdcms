import { RuntimeError } from "@mdcms/shared";

import { createCredentialStore, type CredentialStore } from "./credentials.js";
import type { CliCommand, CliCommandContext } from "./framework.js";

type LogoutOptions = {
  credentialStore?: CredentialStore;
};

function parseLogoutArgs(args: string[]): { help: boolean } {
  for (const token of args) {
    if (token === "--help" || token === "-h") {
      continue;
    }

    throw new RuntimeError({
      code: "INVALID_INPUT",
      message: `Unknown logout flag "${token}".`,
      statusCode: 400,
    });
  }

  return {
    help: args.includes("--help") || args.includes("-h"),
  };
}

function renderLogoutHelp(): string {
  return [
    "Usage: mdcms logout",
    "",
    "Clear locally stored scoped credentials for the current",
    "server/project/environment tuple. Remote API key revoke is",
    "executed as best effort.",
    "",
  ].join("\n");
}

export function createLogoutCommand(options: LogoutOptions = {}): CliCommand {
  return {
    name: "logout",
    description: "Revoke current stored credential profile",
    renderHelp: renderLogoutHelp,
    requiresTarget: true,
    requiresConfig: false,
    run: async (context: CliCommandContext): Promise<number> => {
      const store =
        options.credentialStore ??
        createCredentialStore({
          env: context.env,
        });
      const parsed = parseLogoutArgs(context.args);
      if (parsed.help) {
        context.stdout.write(`${renderLogoutHelp()}\n`);
        return 0;
      }

      const tuple = {
        serverUrl: context.serverUrl,
        project: context.project,
        environment: context.environment,
      };
      const profile = await store.getProfile(tuple);

      if (!profile) {
        context.stdout.write(
          `No stored credentials for ${context.project}/${context.environment}.\n`,
        );
        return 0;
      }

      let remoteRevoked = false;
      try {
        const response = await context.fetcher(
          `${context.serverUrl}/api/v1/auth/api-keys/self/revoke`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${profile.apiKey}`,
            },
          },
        );

        remoteRevoked = response.ok;
        if (!response.ok) {
          const payload = (await response.json().catch(() => undefined)) as
            | { code?: string; message?: string }
            | undefined;
          context.stderr.write(
            `WARN: Remote revoke failed (${payload?.code ?? "REMOTE_ERROR"}: ${
              payload?.message ?? `HTTP ${response.status}`
            }). Local profile will still be cleared.\n`,
          );
        }
      } catch (error) {
        context.stderr.write(
          `WARN: Remote revoke failed (${
            error instanceof Error ? error.message : "unknown error"
          }). Local profile will still be cleared.\n`,
        );
      }

      await store.deleteProfile(tuple);
      context.stdout.write(
        `Logout complete for ${context.project}/${context.environment}. Local profile removed.${remoteRevoked ? " Remote key revoked." : ""}\n`,
      );
      return 0;
    },
  };
}
