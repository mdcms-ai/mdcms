import { z } from "zod";

/** Request header a client uses to report its name and version. */
export const MDCMS_CLIENT_HEADER = "x-mdcms-client";

export const DECLARED_CLIENT_MAX_LENGTH = 120;

export const CONTENT_CHANGE_CHANNELS = [
  "studio",
  "studio_ai",
  "mcp",
  "api",
  "system",
] as const;

export type ContentChangeChannel = (typeof CONTENT_CHANGE_CHANNELS)[number];

export const CONTENT_CHANGE_CREDENTIALS = [
  "session",
  "api_key",
  "oauth",
  "system",
] as const;

export type ContentChangeCredential =
  (typeof CONTENT_CHANGE_CREDENTIALS)[number];

const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

export const ContentChangeOriginSchema = z.object({
  channel: z.enum(CONTENT_CHANGE_CHANNELS),
  credential: z.enum(CONTENT_CHANGE_CREDENTIALS),
  apiKeyId: z.string().min(1).optional(),
  oauthClientId: z.string().min(1).optional(),
  declared: z
    .string()
    .min(1)
    .max(DECLARED_CLIENT_MAX_LENGTH)
    .regex(PRINTABLE_ASCII)
    .optional(),
});

/**
 * How a content change reached the server. `channel` and `credential` are
 * set by the server; `declared` is whatever the client reported about
 * itself and is shown as reported, never trusted.
 */
export type ContentChangeOrigin = z.infer<typeof ContentChangeOriginSchema>;

/** The actor and origin a content write is recorded with. */
export type ContentWriteAttribution = {
  actorId: string;
  origin: ContentChangeOrigin;
};

/**
 * Normalizes a client-reported name. Invalid values are dropped rather than
 * rejected so a malformed header never fails the request it rides on.
 */
export function parseDeclaredClient(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  if (
    trimmed.length === 0 ||
    trimmed.length > DECLARED_CLIENT_MAX_LENGTH ||
    !PRINTABLE_ASCII.test(trimmed)
  ) {
    return undefined;
  }

  return trimmed;
}

export function parseContentChangeOrigin(
  value: unknown,
): ContentChangeOrigin | undefined {
  const parsed = ContentChangeOriginSchema.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}

const CHANNEL_LABELS: Record<ContentChangeChannel, string> = {
  studio: "Studio",
  studio_ai: "Studio AI",
  mcp: "MCP",
  api: "API",
  system: "System",
};

export function formatContentChangeOrigin(origin: ContentChangeOrigin): string {
  const label = CHANNEL_LABELS[origin.channel];

  return origin.declared ? `${label} (${origin.declared})` : label;
}
