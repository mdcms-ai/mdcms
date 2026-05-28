import type { ReactNode } from "react";

type CalloutProps = {
  tone: "info" | "warning" | "success";
  title?: string;
  children?: ReactNode;
};

const TONE_STYLES: Record<
  CalloutProps["tone"],
  { border: string; background: string; badge: string; title: string }
> = {
  info: {
    border: "#2563eb",
    background:
      "linear-gradient(180deg, rgba(239, 246, 255, 0.96), rgba(219, 234, 254, 0.92))",
    badge: "#dbeafe",
    title: "#1d4ed8",
  },
  warning: {
    border: "#d97706",
    background:
      "linear-gradient(180deg, rgba(255, 251, 235, 0.98), rgba(254, 243, 199, 0.92))",
    badge: "#fef3c7",
    title: "#b45309",
  },
  success: {
    border: "#059669",
    background:
      "linear-gradient(180deg, rgba(236, 253, 245, 0.98), rgba(209, 250, 229, 0.92))",
    badge: "#d1fae5",
    title: "#047857",
  },
};

export function Callout({ tone, title, children }: CalloutProps) {
  const normalizedTone = tone ?? "info";
  const style = TONE_STYLES[normalizedTone] ?? TONE_STYLES.info;
  const badgeStyle = {
    borderRadius: "999px",
    background: style.badge,
    padding: "4px 10px",
    fontSize: "12px",
    fontWeight: 700,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: style.title,
  } as const;

  return (
    <aside
      style={{
        borderLeft: `6px solid ${style.border}`,
        borderRadius: "18px",
        padding: "18px 18px 18px 20px",
        background: style.background,
        color: "#0f172a",
        boxShadow: "0 14px 32px rgba(15, 23, 42, 0.06)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          marginBottom: "12px",
        }}
      >
        <span style={badgeStyle}>{normalizedTone}</span>
        <strong style={{ fontSize: "16px", color: style.title }}>
          {title?.trim() || "Important update"}
        </strong>
      </div>
      <div style={{ fontSize: "14px", lineHeight: 1.7 }}>
        {children ?? (
          <p style={{ margin: 0 }}>
            Add context here so editors can test wrapper content directly in the
            MDX canvas.
          </p>
        )}
      </div>
    </aside>
  );
}
