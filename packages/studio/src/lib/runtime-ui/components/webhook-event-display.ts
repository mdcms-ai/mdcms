import type { WebhookEvent } from "@mdcms/shared";

export type WebhookEventDisplay = {
  label: string;
  description: string;
  scope: "Content" | "Media";
};

const webhookEventDisplayByEvent = {
  "content.created": {
    label: "New content",
    description: "Notify when a document is first created",
    scope: "Content",
  },
  "content.updated": {
    label: "Content changed",
    description: "Notify when a draft or metadata changes",
    scope: "Content",
  },
  "content.published": {
    label: "Published content",
    description: "Notify when content becomes visible to readers",
    scope: "Content",
  },
  "content.unpublished": {
    label: "Unpublished content",
    description: "Notify when published content is withdrawn",
    scope: "Content",
  },
  "content.deleted": {
    label: "Deleted content",
    description: "Notify when content is moved out of circulation",
    scope: "Content",
  },
  "content.restored": {
    label: "Restored content",
    description: "Notify when deleted content is brought back",
    scope: "Content",
  },
  "media.uploaded": {
    label: "Media uploaded",
    description: "Notify when an asset is added to media storage",
    scope: "Media",
  },
} satisfies Record<WebhookEvent, WebhookEventDisplay>;

export function getWebhookEventDisplay(
  event: WebhookEvent,
): WebhookEventDisplay {
  return webhookEventDisplayByEvent[event];
}
