import clsx from "clsx";

type Props = {
  value: string;
};

const toneMap: Record<string, string> = {
  PUBLISHED: "pill pill-success",
  DRAFT: "pill pill-muted",
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

// One word per thing on the desktop: cab (not device), pause (not disable), loop.
const labelMap: Record<string, string> = {
  DEVICE_REGISTERED: "Cab registered",
  DEVICE_SYNCED: "Cab updated",
  DEVICE_OFFLINE: "Cab offline",
  DEVICE_DISABLED: "Cab paused",
  DEVICE_ENABLED: "Cab resumed",
  SYNC_FAILED: "Update failed",
  DEVICE_GROUP_CREATED: "Group created",
  DEVICE_GROUP_UPDATED: "Group changed",
  DEVICE_GROUP_DELETED: "Group deleted",
  outdated: "Updating",
};

function formatLabel(value: string) {
  if (labelMap[value]) {
    return labelMap[value];
  }
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join(" ");
}

export function StatusPill({ value }: Props) {
  return <span className={clsx(toneMap[value] ?? "pill pill-muted")}>{formatLabel(value)}</span>;
}
