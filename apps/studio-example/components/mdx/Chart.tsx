type ChartProps = {
  data: number[];
  type: "bar" | "line" | "pie";
  title?: string;
  color?: string;
};

const DEFAULT_COLOR = "#2563eb";

export function Chart({ data, type, title, color }: ChartProps) {
  const values = data?.length ? data : [24, 48, 72];
  const peak = Math.max(...values, 1);
  const accent = color?.trim() || DEFAULT_COLOR;
  const kind = type ?? "bar";
  const typeBadgeStyle = {
    borderRadius: "999px",
    border: `1px solid ${accent}33`,
    background: `${accent}1a`,
    padding: "6px 10px",
    fontSize: "12px",
    fontWeight: 700,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "#1e3a8a",
  } as const;

  return (
    <section
      style={{
        border: "1px solid rgba(37, 99, 235, 0.18)",
        borderRadius: "18px",
        padding: "18px",
        background:
          "linear-gradient(180deg, rgba(248, 250, 252, 0.98), rgba(239, 246, 255, 0.95))",
        boxShadow: "0 16px 40px rgba(15, 23, 42, 0.08)",
        color: "#0f172a",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "12px",
          alignItems: "flex-start",
          marginBottom: "16px",
        }}
      >
        <div>
          <p
            style={{
              margin: 0,
              fontSize: "12px",
              fontWeight: 700,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "#64748b",
            }}
          >
            Embedded chart
          </p>
          <h3
            style={{
              margin: "6px 0 0",
              fontSize: "18px",
              lineHeight: 1.2,
            }}
          >
            {title?.trim() || "Quarterly momentum"}
          </h3>
        </div>
        <span style={typeBadgeStyle}>{kind}</span>
      </div>

      <div
        aria-label="Chart preview"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${values.length}, minmax(0, 1fr))`,
          gap: "10px",
          alignItems: "end",
          minHeight: "140px",
        }}
      >
        {values.map((value, index) => {
          const barHeight = `${Math.max((value / peak) * 100, 12)}%`;

          return (
            <div
              key={`${value}-${index}`}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                alignItems: "center",
              }}
            >
              <div
                style={{
                  width: "100%",
                  minHeight: "24px",
                  height: barHeight,
                  borderRadius: "14px 14px 6px 6px",
                  background: `linear-gradient(180deg, ${accent}, #0f172a)`,
                  boxShadow: `0 12px 24px ${accent}33`,
                }}
              />
              <span
                style={{
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "#334155",
                }}
              >
                {value}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
