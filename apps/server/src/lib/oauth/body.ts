import { OAuthError } from "./database-store.js";
const MAX_BYTES = 64 * 1024;
export async function readOAuthBody(request: Request): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) {
    await request.body?.cancel().catch(() => undefined);
    throw new OAuthError("invalid_request", /^\d+$/.test(declared) ? 413 : 400);
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new OAuthError("invalid_request", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new OAuthError("invalid_request");
  }
}
