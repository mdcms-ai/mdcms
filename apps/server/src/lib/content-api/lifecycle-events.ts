import type { ContentWriteAttribution } from "@mdcms/shared";
import { attributionFromAuthorizedRequest } from "./attribution.js";
import { actorFromAuthorizedRequest, type AuthorizedRequest } from "../auth.js";

import type {
  ContentDocument,
  ContentLifecycleEvent,
  ContentLifecycleEventSink,
  ContentScope,
} from "./types.js";

export type ContentLifecycleMutationCommitter = (
  event: ContentLifecycleEvent,
  scope: ContentScope,
  request: Request,
  authorization: AuthorizedRequest,
  mutate: (attribution: ContentWriteAttribution) => Promise<ContentDocument>,
) => Promise<ContentDocument>;

export function emitContentLifecycleEvent(input: {
  sink?: ContentLifecycleEventSink;
  event: ContentLifecycleEvent;
  scope: ContentScope;
  document: ContentDocument;
  authorization: AuthorizedRequest;
}): void {
  if (!input.sink) {
    return;
  }

  void input.sink
    .emitContentEvent({
      event: input.event,
      scope: input.scope,
      document: input.document,
      actor: actorFromAuthorizedRequest(input.authorization),
    })
    .catch(() => {
      // Side effects are fire-and-forget from the mutation caller's
      // perspective; sink failures must not fail the committed write.
    });
}

export async function commitContentMutationWithLifecycleEvent(input: {
  sink?: ContentLifecycleEventSink;
  event: ContentLifecycleEvent;
  scope: ContentScope;
  request: Request;
  authorization: AuthorizedRequest;
  mutate: (attribution: ContentWriteAttribution) => Promise<ContentDocument>;
}): Promise<ContentDocument> {
  const document = await input.mutate(attributionFromAuthorizedRequest(input));

  emitContentLifecycleEvent({
    sink: input.sink,
    event: input.event,
    scope: input.scope,
    document,
    authorization: input.authorization,
  });

  return document;
}

export function createContentLifecycleMutationCommitter(
  sink?: ContentLifecycleEventSink,
): ContentLifecycleMutationCommitter {
  return (event, scope, request, authorization, mutate) =>
    commitContentMutationWithLifecycleEvent({
      sink,
      event,
      scope,
      request,
      authorization,
      mutate,
    });
}
