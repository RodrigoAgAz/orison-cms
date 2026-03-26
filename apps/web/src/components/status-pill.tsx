import clsx from "clsx";

type Props = {
  value: string;
};

const toneMap: Record<string, string> = {
  PUBLISHED: "pill pill-success",
  DRAFT: "pill pill-muted",
  REVIEW: "pill pill-warning",
  PUBLISHING: "pill pill-warning",
  ARCHIVED: "pill pill-muted",
  READY: "pill pill-success",
  PROCESSING: "pill pill-warning",
  FAILED: "pill pill-danger",
  online: "pill pill-success",
  outdated: "pill pill-warning",
  offline: "pill pill-danger",
  inactive: "pill pill-muted",
};

function formatLabel(value: string) {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join(" ");
}

export function StatusPill({ value }: Props) {
  return <span className={clsx(toneMap[value] ?? "pill pill-muted")}>{formatLabel(value)}</span>;
}
