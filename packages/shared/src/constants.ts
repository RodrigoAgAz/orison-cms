export const assetCategories = [
  "ADVERTISEMENT",
  "FILLER_WEATHER",
  "FILLER_NEWS",
  "FILLER_BRANDED",
  "FILLER_OTHER",
] as const;

export const assetStatuses = ["PROCESSING", "READY", "FAILED"] as const;

export const loopStatuses = ["DRAFT", "REVIEW", "PUBLISHED", "ARCHIVED"] as const;

export const userRoles = ["ADMIN", "EDITOR"] as const;

export const slotContentTypes = ["ADVERTISEMENT", "FILLER"] as const;

export const activityEventTypes = [
  "LOOP_CREATED",
  "LOOP_PUBLISHED",
  "ASSET_UPLOADED",
  "ASSET_READY",
  "DEVICE_REGISTERED",
  "DEVICE_SYNCED",
  "DEVICE_OFFLINE",
  "SYNC_FAILED",
] as const;

export const queueNames = {
  assetProcessing: "asset-processing",
  loopPublish: "loop-publish",
  weatherGeneration: "weather-generation",
  newsGeneration: "news-generation",
} as const;

export const defaultFillerTemplate = [
  {
    category: "FILLER_WEATHER",
    durationMs: 15000,
  },
  {
    category: "FILLER_NEWS",
    durationMs: 15000,
  },
  {
    category: "FILLER_BRANDED",
    durationMs: 18000,
  },
] as const;

export const slotDurationMs = 60_000;
export const loopDurationMs = 600_000;
export const advertisementDurationMs = 12_000;
export const directLoopUploadMaxBytes = 500 * 1024 * 1024;
export const directLoopUploadMaxDurationMs = 14 * 60 * 1000;
export const defaultSyncIntervalSeconds = 1800;
export const defaultHeartbeatIntervalSeconds = 300;
export const playbackLogFlushThreshold = 500;

export type AssetCategory = (typeof assetCategories)[number];
export type AssetStatus = (typeof assetStatuses)[number];
export type LoopStatus = (typeof loopStatuses)[number];
export type UserRole = (typeof userRoles)[number];
export type SlotContentType = (typeof slotContentTypes)[number];
export type ActivityEventType = (typeof activityEventTypes)[number];
