import { actorFromAuthorizedRequest, type AuthorizedRequest } from "../auth.js";

import type {
  ContentDocument,
  ContentLifecycleEvent,
  ContentLifecycleEventSink,
  ContentScope,
} from "./types.js";

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
