import type { ChangeEvent } from "react";

import type { PropsEditorComponent } from "@mdcms/studio";

import type { PricingTableProps } from "./PricingTable";
import { getPricingTableEditorTiers } from "./PricingTable.editor-state";

type PricingTier = NonNullable<PricingTableProps["tiers"]>[number];

const controlLabelStyles = {
  display: "grid",
  gap: "6px",
  fontSize: "12px",
  fontWeight: 600,
  color: "#334155",
} as const;

const controlStyles = {
  width: "100%",
  borderRadius: "10px",
  border: "1px solid #cbd5e1",
  padding: "10px 12px",
  fontSize: "14px",
  color: "#0f172a",
  background: "#fff",
} as const;

const buttonStyles = {
  borderRadius: "999px",
  border: "1px solid #cbd5e1",
  background: "#f8fafc",
  color: "#0f172a",
  padding: "8px 12px",
  fontSize: "12px",
  fontWeight: 600,
} as const;

const PricingTableEditor: PropsEditorComponent<PricingTableProps> = ({
  value,
  onChange,
  readOnly,
}) => {
  const tiers = getPricingTableEditorTiers(value);

  function handleTitleChange(event: ChangeEvent<HTMLInputElement>) {
    onChange({
      ...value,
      title: event.currentTarget.value,
    });
  }

  function updateTier(
    index: number,
    key: keyof PricingTier,
    nextValue: string,
  ) {
    const nextTiers = tiers.map((tier, tierIndex) =>
      tierIndex === index ? { ...tier, [key]: nextValue } : tier,
    );

    onChange({
      ...value,
      tiers: nextTiers,
    });
  }

  function addTier() {
    onChange({
      ...value,
      tiers: [
        ...tiers,
        {
          name: "",
          price: "",
          description: "",
        },
      ],
    });
  }

  function removeTier(index: number) {
    const nextTiers = tiers.filter((_, tierIndex) => tierIndex !== index);

    onChange({
      ...value,
      tiers: nextTiers,
    });
  }

  return (
    <div
      style={{
        display: "grid",
        gap: "16px",
      }}
    >
      <label style={controlLabelStyles}>
        Headline
        <input
          aria-label="Pricing table headline"
          type="text"
          value={value.title ?? ""}
          onChange={handleTitleChange}
          readOnly={readOnly}
          style={controlStyles}
        />
      </label>

      <div style={{ display: "grid", gap: "12px" }}>
        {tiers.map((tier, index) => (
          <fieldset
            key={`${tier.name}:${tier.price}:${tier.description ?? ""}`}
            style={{
              margin: 0,
              borderRadius: "14px",
              border: "1px solid #e2e8f0",
              padding: "14px",
              display: "grid",
              gap: "10px",
            }}
          >
            <legend
              style={{
                padding: "0 6px",
                fontSize: "12px",
                fontWeight: 700,
                color: "#475569",
              }}
            >
              Tier {index + 1}
            </legend>

            <label style={controlLabelStyles}>
              Name
              <input
                aria-label={`Tier ${index + 1} name`}
                type="text"
                value={tier.name}
                onChange={(event) =>
                  updateTier(index, "name", event.currentTarget.value)
                }
                readOnly={readOnly}
                style={controlStyles}
              />
            </label>

            <label style={controlLabelStyles}>
              Price
              <input
                aria-label={`Tier ${index + 1} price`}
                type="text"
                value={tier.price}
                onChange={(event) =>
                  updateTier(index, "price", event.currentTarget.value)
                }
                readOnly={readOnly}
                style={controlStyles}
              />
            </label>

            <label style={controlLabelStyles}>
              Description
              <textarea
                aria-label={`Tier ${index + 1} description`}
                value={tier.description ?? ""}
                onChange={(event) =>
                  updateTier(index, "description", event.currentTarget.value)
                }
                readOnly={readOnly}
                rows={3}
                style={controlStyles}
              />
            </label>

            <button
              type="button"
              onClick={() => removeTier(index)}
              disabled={readOnly}
              style={buttonStyles}
            >
              Remove tier
            </button>
          </fieldset>
        ))}
      </div>

      <button
        type="button"
        onClick={addTier}
        disabled={readOnly}
        style={buttonStyles}
      >
        Add tier
      </button>
    </div>
  );
};

export default PricingTableEditor;
