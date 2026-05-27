type PricingTier = {
  name: string;
  price: string;
  description?: string;
};

export type PricingTableProps = {
  title?: string;
  tiers?: PricingTier[];
};

const DEFAULT_TIERS: PricingTier[] = [
  {
    name: "Starter",
    price: "$19",
    description: "Lean launch plan for small teams.",
  },
  {
    name: "Scale",
    price: "$79",
    description: "Shared workflow controls and richer analytics.",
  },
];

export function PricingTable({ title, tiers }: PricingTableProps) {
  const normalizedTiers = tiers === undefined ? DEFAULT_TIERS : tiers;

  return (
    <section
      style={{
        borderRadius: "24px",
        padding: "20px",
        background:
          "linear-gradient(135deg, rgba(15, 23, 42, 0.98), rgba(30, 41, 59, 0.94))",
        color: "#f8fafc",
        boxShadow: "0 18px 48px rgba(15, 23, 42, 0.24)",
      }}
    >
      <div style={{ marginBottom: "18px" }}>
        <p
          style={{
            margin: 0,
            fontSize: "12px",
            fontWeight: 700,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "#94a3b8",
          }}
        >
          Pricing
        </p>
        <h3 style={{ margin: "6px 0 0", fontSize: "22px", lineHeight: 1.2 }}>
          {title?.trim() || "Pick a launch lane"}
        </h3>
      </div>

      {normalizedTiers.length === 0 ? (
        <div
          style={{
            borderRadius: "18px",
            border: "1px dashed rgba(148, 163, 184, 0.32)",
            padding: "22px 16px",
            textAlign: "center",
            color: "#cbd5e1",
            fontSize: "14px",
          }}
        >
          No tiers configured yet.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gap: "14px",
            gridTemplateColumns: `repeat(${normalizedTiers.length}, minmax(0, 1fr))`,
          }}
        >
          {normalizedTiers.map((tier, index) => (
            <article
              key={`${tier.name}-${index}`}
              style={{
                borderRadius: "18px",
                border: "1px solid rgba(148, 163, 184, 0.22)",
                background: "rgba(15, 23, 42, 0.52)",
                padding: "16px",
              }}
            >
              <h4 style={{ margin: 0, fontSize: "16px" }}>{tier.name}</h4>
              <p
                style={{
                  margin: "10px 0 8px",
                  fontSize: "28px",
                  fontWeight: 700,
                  letterSpacing: "-0.04em",
                }}
              >
                {tier.price}
              </p>
              <p
                style={{
                  margin: 0,
                  fontSize: "13px",
                  lineHeight: 1.6,
                  color: "#cbd5e1",
                }}
              >
                {tier.description?.trim() || "Customizable demo tier."}
              </p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
