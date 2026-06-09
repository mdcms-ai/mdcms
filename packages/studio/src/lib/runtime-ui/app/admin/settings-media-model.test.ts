import assert from "node:assert/strict";
import { test } from "bun:test";
import type { MediaSettings } from "@mdcms/shared";

import {
  buildMediaSettingsUpdateInput,
  createMediaSettingsFormState,
  createMediaSettingsDraft,
  formatMediaLimitLabel,
  getMediaSettingsDraftError,
  isMediaSettingsDraftDirty,
  reconcileMediaSettingsFormState,
  type MediaSettingsDraft,
} from "./settings-media-model.js";

const unlimited: MediaSettings = {
  media: { image: { maxUploadSizeBytes: null } },
};
const limited: MediaSettings = {
  media: { image: { maxUploadSizeBytes: 10485760 } },
};

test("createMediaSettingsDraft maps null to unlimited mode", () => {
  assert.deepEqual(createMediaSettingsDraft(unlimited), {
    mode: "unlimited",
    explicitBytes: "",
  });
});

test("createMediaSettingsDraft maps positive values to explicit mode", () => {
  assert.deepEqual(createMediaSettingsDraft(limited), {
    mode: "explicit",
    explicitBytes: "10485760",
  });
});

test("buildMediaSettingsUpdateInput emits null for unlimited mode", () => {
  const draft: MediaSettingsDraft = {
    mode: "unlimited",
    explicitBytes: "2048",
  };
  assert.deepEqual(buildMediaSettingsUpdateInput(draft), unlimited);
});

test("buildMediaSettingsUpdateInput emits a positive safe integer for explicit mode", () => {
  const draft: MediaSettingsDraft = { mode: "explicit", explicitBytes: "2048" };
  assert.deepEqual(buildMediaSettingsUpdateInput(draft), {
    media: { image: { maxUploadSizeBytes: 2048 } },
  });
});

test("getMediaSettingsDraftError rejects invalid explicit byte values", () => {
  for (const explicitBytes of [
    "",
    "0",
    "-1",
    "1.5",
    "abc",
    String(Number.MAX_SAFE_INTEGER + 1),
  ]) {
    assert.equal(
      getMediaSettingsDraftError({ mode: "explicit", explicitBytes }),
      "Enter a positive whole number of bytes.",
    );
  }
  assert.equal(
    getMediaSettingsDraftError({ mode: "explicit", explicitBytes: "1" }),
    null,
  );
});

test("isMediaSettingsDraftDirty compares payloads against the saved settings", () => {
  assert.equal(
    isMediaSettingsDraftDirty(createMediaSettingsDraft(limited), limited),
    false,
  );
  assert.equal(
    isMediaSettingsDraftDirty(
      { mode: "unlimited", explicitBytes: "10485760" },
      limited,
    ),
    true,
  );
});

test("formatMediaLimitLabel describes unlimited and explicit limits", () => {
  assert.equal(formatMediaLimitLabel(null), "Unlimited");
  assert.equal(formatMediaLimitLabel(10485760), "10,485,760 bytes");
});

test("reconcileMediaSettingsFormState preserves dirty drafts during background refreshes", () => {
  const state = createMediaSettingsFormState(limited);
  const refreshed: MediaSettings = {
    media: { image: { maxUploadSizeBytes: 20971520 } },
  };

  assert.deepEqual(
    reconcileMediaSettingsFormState(
      {
        ...state,
        draft: { mode: "explicit", explicitBytes: "12345" },
      },
      refreshed,
    ),
    {
      baseline: refreshed,
      draft: { mode: "explicit", explicitBytes: "12345" },
      saved: false,
    },
  );
});

test("reconcileMediaSettingsFormState preserves saved state when a refetch returns the saved setting", () => {
  const state = {
    baseline: limited,
    draft: createMediaSettingsDraft(limited),
    saved: true,
  };
  const sameLimitNewObject: MediaSettings = {
    media: { image: { maxUploadSizeBytes: 10485760 } },
  };

  assert.deepEqual(
    reconcileMediaSettingsFormState(state, sameLimitNewObject),
    state,
  );
});
