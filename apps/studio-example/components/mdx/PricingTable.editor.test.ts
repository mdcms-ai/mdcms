import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getPricingTableEditorTierKey,
  getPricingTableEditorTiers,
} from "./PricingTable.editor-state";

test("getPricingTableEditorTiers preserves an explicit empty tier list", () => {
  assert.deepEqual(getPricingTableEditorTiers({ tiers: [] }), []);
});

test("getPricingTableEditorTiers seeds a blank tier only for undefined values", () => {
  assert.deepEqual(getPricingTableEditorTiers({}), [
    {
      name: "",
      price: "",
      description: "",
    },
  ]);
});

test("getPricingTableEditorTierKey stays stable when tier values change", () => {
  assert.equal(getPricingTableEditorTierKey(1), "tier:1");
  assert.equal(getPricingTableEditorTierKey(1), "tier:1");
});
