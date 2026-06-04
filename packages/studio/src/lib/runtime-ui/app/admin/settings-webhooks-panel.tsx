"use client";

import type { SettingsPageWebhookConfigState } from "../../hooks/use-webhook-config-list.js";
import type { SettingsPageWebhookHistoryState } from "../../hooks/use-webhook-delivery-history.js";
import { WebhookConfigurationsSection } from "./settings-webhook-configurations.js";
import { WebhookDeliveryHistorySection } from "./settings-webhook-delivery-history.js";

export function SettingsWebhooksPanel({
  webhookConfigState,
  webhookHistoryState,
}: {
  webhookConfigState: SettingsPageWebhookConfigState;
  webhookHistoryState: SettingsPageWebhookHistoryState;
}) {
  return (
    <section
      data-mdcms-settings-webhooks-state={webhookHistoryState.status}
      className="space-y-5"
    >
      <div>
        <h2 className="font-heading text-[30px] font-semibold leading-tight text-foreground">
          Webhooks
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-foreground-muted">
          Manage webhook configurations and inspect delivery history for the
          active project and environment.
        </p>
      </div>

      <WebhookConfigurationsSection state={webhookConfigState} />
      <WebhookDeliveryHistorySection state={webhookHistoryState} />
    </section>
  );
}
