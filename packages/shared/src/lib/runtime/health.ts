/**
 * HealthzPayload is the shared shape returned by process-level health checks.
 */
export type HealthzPayload = {
  status: "ok";
  service: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
};

export type ProcessHealthPayloadInput = {
  service: string;
  version: string;
  startedAtMs: number;
  now?: Date;
};

/**
 * createProcessHealthPayload builds the process-level health response used
 * by the `/healthz` endpoint.
 */
export function createProcessHealthPayload(
  input: ProcessHealthPayloadInput,
): HealthzPayload {
  const now = input.now ?? new Date();
  const elapsedMs = Math.max(0, now.getTime() - input.startedAtMs);

  return {
    status: "ok",
    service: input.service,
    version: input.version,
    uptimeSeconds: Math.floor(elapsedMs / 1000),
    timestamp: now.toISOString(),
  };
}
