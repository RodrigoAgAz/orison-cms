type Props = {
  label: string;
  value: string | number;
  hint?: string;
};

export function StatCard({ label, value, hint }: Props) {
  const displayValue = String(value);
  const isMetric = typeof value === "number" || /^[\d,.%]+$/.test(displayValue);
  const valueClass = [
    "stat-value",
    isMetric ? "is-metric" : "is-text",
    displayValue.length > 12 ? "is-long" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="card stat-card">
      <span className="stat-label">{label}</span>
      <strong className={valueClass}>{displayValue}</strong>
      {hint ? <span className="stat-hint">{hint}</span> : null}
    </div>
  );
}
