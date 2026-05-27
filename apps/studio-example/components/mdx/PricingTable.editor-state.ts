import type { PricingTableProps } from "./PricingTable";

type PricingTier = NonNullable<PricingTableProps["tiers"]>[number];

export function getPricingTableEditorTiers(
  value: Partial<PricingTableProps>,
): PricingTier[] {
  if (value.tiers === undefined) {
    return [{ name: "", price: "", description: "" }];
  }

  return [...value.tiers];
}
