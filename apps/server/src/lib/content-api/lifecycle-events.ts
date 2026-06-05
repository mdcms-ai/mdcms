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
  authorization: AuthorizedRequest,
  mutate: () => Promise<ContentDocument>,
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
  authorization: AuthorizedRequest;
  mutate: () => Promise<ContentDocument>;
}): Promise<ContentDocument> {
  const document = await input.mutate();

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
  return (event, scope, authorization, mutate) =>
    commitContentMutationWithLifecycleEvent({
      sink,
      event,
      scope,
      authorization,
      mutate,
    });
}
