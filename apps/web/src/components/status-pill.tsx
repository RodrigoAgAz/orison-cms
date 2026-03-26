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
  LOOP_PUBLISHED: "pill pill-success",
  ASSET_UPLOADED: "pill pill-muted",
  ASSET_READY: "pill pill-success",
  DEVICE_REGISTERED: "pill pill-success",
  DEVICE_SYNCED: "pill pill-success",
  DEVICE_OFFLINE: "pill pill-danger",
  DEVICE_DISABLED: "pill pill-danger",
  DEVICE_ENABLED: "pill pill-success",
  SYNC_FAILED: "pill pill-danger",
  DEVICE_GROUP_CREATED: "pill pill-success",
  DEVICE_GROUP_UPDATED: "pill pill-warning",
  DEVICE_GROUP_DELETED: "pill pill-muted",
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
