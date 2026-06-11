import { parseServerEnv } from "../lib/env.js";
import { prepareServerRequestHandlerWithModules } from "../lib/runtime-with-modules.js";
import type {
  BunUpgradeServer,
  CollaborationWebSocketHandler,
} from "../lib/collaboration/transport.js";

type BunServer = BunUpgradeServer & {
  stop: (closeActiveConnections?: boolean) => void;
};

type BunRuntime = {
  serve: (options: {
    port: number;
    fetch: (
      request: Request,
      server: BunServer,
    ) => Response | Promise<Response | undefined> | undefined;
    websocket?: CollaborationWebSocketHandler;
    /** Per-connection idle timeout in seconds. Bun defaults to 10s, which
     * is far too short for SSE chat streams that sit awaiting the next
     * token from the LLM — we set it to Bun's maximum (255s) so any
     * realistic generation completes before the socket gets closed. */
    idleTimeout?: number;
  }) => BunServer;
};

declare const Bun: BunRuntime;

const env = parseServerEnv(process.env);
const {
  handleRequest,
  collaborationWebSocket,
  shutdown: shutdownRuntime,
} = await prepareServerRequestHandlerWithModules({
  env: process.env,
});

const server = Bun.serve({
  port: env.PORT,
  fetch: handleRequest,
  ...(collaborationWebSocket ? { websocket: collaborationWebSocket } : {}),
  idleTimeout: 255,
});

let isShuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.info(`[server] received ${signal}, shutting down`);
  try {
    server.stop(false);
    await shutdownRuntime();
  } finally {
    server.stop(true);
  }
}

function registerSignalHandler(signal: NodeJS.Signals): void {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

registerSignalHandler("SIGINT");
registerSignalHandler("SIGTERM");

console.info(
  `[server] listening on port ${env.PORT} as ${env.SERVICE_NAME} (${env.NODE_ENV})`,
);
