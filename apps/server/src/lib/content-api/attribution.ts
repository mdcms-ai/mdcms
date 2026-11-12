import {
  MDCMS_CLIENT_HEADER,
  parseDeclaredClient,
  type ContentChangeChannel,
  type ContentWriteAttribution,
} from "@mdcms/shared";

import type { AuthorizedRequest } from "../auth.js";
import { DEFAULT_ACTOR } from "./types.js";

/**
 * Derives who made a content change and how it reached the server. The
 * actor always comes from the authenticated principal; request bodies cannot
 * influence it. `channel` defaults to `studio` for sessions and `api` for API
 * keys; callers that know better (the Assistant, the MCP endpoint) pass it.
 */
export function attributionFromAuthorizedRequest(input: {
  request: Request;
  authorization: AuthorizedRequest;
  channel?: ContentChangeChannel;
  declared?: string;
}): ContentWriteAttribution {
  const declared = parseDeclaredClient(
    input.declared ?? input.request.headers.get(MDCMS_CLIENT_HEADER),
  );
  const declaredField = declared ? { declared } : {};
  const { principal } = input.authorization;

  if (principal.type === "session") {
    return {
      actorId: principal.session.userId,
      origin: {
        channel:
          input.channel ?? input.authorization.internalChannel ?? "studio",
        credential: "session",
        ...declaredField,
      },
    };
  }

  if (principal.type === "oauth")
    return {
      actorId: principal.userId,
      origin: {
        channel: "mcp",
        credential: "oauth",
        oauthClientId: principal.clientId,
        ...declaredField,
      },
    };

  return {
    actorId: principal.createdByUserId,
    origin: {
      channel: input.channel ?? input.authorization.internalChannel ?? "api",
      credential: "api_key",
      apiKeyId: principal.keyId,
      ...declaredField,
    },
  };
}

/** Attribution for writes the server makes on its own, such as seeding. */
export function systemAttribution(
  actorId: string = DEFAULT_ACTOR,
): ContentWriteAttribution {
  return { actorId, origin: { channel: "system", credential: "system" } };
}
