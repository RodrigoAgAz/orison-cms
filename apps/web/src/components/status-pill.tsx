import clsx from "clsx";

type Props = {
  value: string;
};

const toneMap: Record<string, string> = {
  PUBLISHED: "pill pill-success",
  DRAFT: "pill pill-muted",
  REVIEW: "pill pill-warning",
  ARCHIVED: "pill pill-muted",
  READY: "pill pill-success",
  PROCESSING: "pill pill-warning",
  FAILED: "pill pill-danger",
  online: "pill pill-success",
  outdated: "pill pill-warning",
  offline: "pill pill-danger",
  inactive: "pill pill-muted",
};

export function StatusPill({ value }: Props) {
  return <span className={clsx(toneMap[value] ?? "pill pill-muted")}>{value}</span>;
}

