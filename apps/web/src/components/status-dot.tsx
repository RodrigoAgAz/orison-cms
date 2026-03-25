import clsx from "clsx";

type Props = {
  status: "online" | "outdated" | "offline" | "inactive";
  label?: string;
};

const toneMap: Record<Props["status"], string> = {
  online: "dot dot-green",
  outdated: "dot dot-amber",
  offline: "dot dot-red",
  inactive: "dot dot-grey",
};

export function StatusDot({ status, label }: Props) {
  return (
    <span className="status-inline">
      <span className={clsx(toneMap[status])} />
      {label ? <span>{label}</span> : null}
    </span>
  );
}
