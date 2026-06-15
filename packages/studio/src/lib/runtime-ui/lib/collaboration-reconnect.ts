const COLLABORATION_RECONNECT_DELAYS_MS = [0, 1000, 2000, 4000, 10_000];
const FATAL_COLLABORATION_CLOSE_CODES = new Set([4401, 4403]);

export function getCollaborationReconnectDelayMs(attempt: number): number {
  const index = Math.max(0, Math.floor(attempt));

  return (
    COLLABORATION_RECONNECT_DELAYS_MS[index] ??
    COLLABORATION_RECONNECT_DELAYS_MS[
      COLLABORATION_RECONNECT_DELAYS_MS.length - 1
    ]!
  );
}

export function isCollaborationCloseRetryable({
  code,
}: {
  code?: number;
}): boolean {
  return !FATAL_COLLABORATION_CLOSE_CODES.has(code ?? 0);
}
