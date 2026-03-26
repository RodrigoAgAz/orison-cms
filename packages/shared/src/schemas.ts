import { z } from "zod";

import {
  activityEventTypes,
  assetCategories,
  assetStatuses,
  defaultHeartbeatIntervalSeconds,
  defaultSyncIntervalSeconds,
  loopStatuses,
  playbackModes,
  playerStates,
  queueNames,
  slotContentTypes,
  userRoles,
} from "./constants";

export const assetCategorySchema = z.enum(assetCategories);
export const assetStatusSchema = z.enum(assetStatuses);
export const loopStatusSchema = z.enum(loopStatuses);
export const slotContentTypeSchema = z.enum(slotContentTypes);
export const userRoleSchema = z.enum(userRoles);
export const activityEventTypeSchema = z.enum(activityEventTypes);
export const playbackModeSchema = z.enum(playbackModes);
export const playerStateSchema = z.enum(playerStates);

export const jsonObjectSchema = z.record(z.any());

export const slotContentInputSchema = z.object({
  assetId: z.string().min(1),
  orderInSlot: z.number().int().min(0),
  startTimeMs: z.number().int().min(0),
  durationMs: z.number().int().positive(),
  contentType: slotContentTypeSchema,
});

export const updateSlotSchema = z.object({
  contents: z.array(slotContentInputSchema).min(1),
  staticCreativeId: z.string().min(1).nullable().optional(),
});

export const createLoopSchema = z.object({
  name: z.string().min(2).max(120),
});

export const updateLoopSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  status: loopStatusSchema.optional(),
  targetGroupId: z.string().min(1).nullable().optional(),
});

export const assetListQuerySchema = z.object({
  category: assetCategorySchema.optional(),
  search: z.string().trim().min(1).optional(),
  status: assetStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});

export const uploadAssetFormSchema = z.object({
  category: assetCategorySchema,
  metadata: z.string().optional(),
});

export const deviceRegistrationSchema = z.object({
  serialNumber: z.string().min(3).max(64),
  cabLicenseNumber: z.string().max(64).optional().nullable(),
  driverName: z.string().max(128).optional().nullable(),
  hpTaxiCabId: z.string().max(64).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});

export const deviceUpdateSchema = deviceRegistrationSchema.partial().extend({
  groupId: z.string().min(1).nullable().optional(),
  isActive: z.boolean().optional(),
  isDisabled: z.boolean().optional(),
  disabledReason: z.string().max(500).optional().nullable(),
  firmwareVersion: z.string().max(32).optional().nullable(),
});

export const deviceGroupInputSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional().nullable(),
});

export const heartbeatSchema = z.object({
  serialNumber: z.string().min(3).max(64),
  ipAddress: z.string().max(128).optional().nullable(),
  firmwareVersion: z.string().max(32).optional().nullable(),
  storageFreeMb: z.number().int().min(0).optional().nullable(),
  currentLoopId: z.string().optional().nullable(),
  cpuTemp: z.number().min(0).optional().nullable(),
  uptimeSeconds: z.number().int().min(0).optional().nullable(),
  memoryUsedPercent: z.number().min(0).max(100).optional().nullable(),
  playerStatus: z.enum(["playing", "silent", "disabled", "idle", "fallback", "error"]).optional().nullable(),
  networkType: z.enum(["4g", "ethernet", "wifi", "unknown"]).optional().nullable(),
  signalStrength: z.number().int().optional().nullable(),
  location: jsonObjectSchema.nullable().optional(),
});

export const playbackLogEntrySchema = z.object({
  slotPosition: z.number().int().min(0).max(9).nullable().optional(),
  contentType: slotContentTypeSchema.nullable().optional(),
  type: z.string().max(64).nullable().optional(),
  event: z.string().max(64).nullable().optional(),
  assetId: z.string().optional().nullable(),
  playedAt: z.string().datetime(),
  completedFull: z.boolean().default(true),
  mode: playbackModeSchema.nullable().optional(),
  state: playerStateSchema.nullable().optional(),
  durationMs: z.number().int().min(0).nullable().optional(),
  journeyId: z.string().max(128).nullable().optional(),
  location: jsonObjectSchema.nullable().optional(),
  deviceSerial: z.string().max(64).nullable().optional(),
});

export const playbackLogBatchSchema = z.object({
  serialNumber: z.string().min(3).max(64),
  logs: z.array(playbackLogEntrySchema).min(1).max(500),
});

export const settingsSchema = z.object({
  defaultFillerTemplate: z
    .array(
      z.object({
        category: assetCategorySchema,
        durationMs: z.number().int().positive(),
      }),
    )
    .default([]),
  syncIntervalSeconds: z.number().int().min(60).default(defaultSyncIntervalSeconds),
  heartbeatIntervalSeconds: z.number().int().min(60).default(defaultHeartbeatIntervalSeconds),
  notificationEmails: z.array(z.string().email()).default([]),
  safetyVideoAssetId: z.string().nullable().default(null),
  safetyMessageDurationSeconds: z.number().int().min(1).max(300).default(8),
});

export const assetProcessingJobSchema = z.object({
  assetId: z.string(),
  tempFilePath: z.string(),
});

export const publishLoopJobSchema = z.object({
  loopId: z.string(),
  publishedByUserId: z.string(),
});

export const queueNameSchema = z.enum([
  queueNames.assetProcessing,
  queueNames.loopPublish,
  queueNames.weatherGeneration,
  queueNames.newsGeneration,
]);

export const deviceManifestResponseSchema = z.object({
  loopId: z.string(),
  manifestUrl: z.string().url(),
  version: z.number().int().positive(),
  checksum: z.string(),
  compiledVideoUrl: z.string().url().nullable(),
  disabled: z.boolean().default(false),
  disabledReason: z.string().nullable().optional(),
});

export type SlotContentInput = z.infer<typeof slotContentInputSchema>;
export type UpdateSlotInput = z.infer<typeof updateSlotSchema>;
export type CreateLoopInput = z.infer<typeof createLoopSchema>;
export type UpdateLoopInput = z.infer<typeof updateLoopSchema>;
export type DeviceRegistrationInput = z.infer<typeof deviceRegistrationSchema>;
export type DeviceUpdateInput = z.infer<typeof deviceUpdateSchema>;
export type DeviceGroupInput = z.infer<typeof deviceGroupInputSchema>;
export type DeviceHeartbeatInput = z.infer<typeof heartbeatSchema>;
export type PlaybackLogBatchInput = z.infer<typeof playbackLogBatchSchema>;
export type SettingsInput = z.infer<typeof settingsSchema>;
export type AssetProcessingJob = z.infer<typeof assetProcessingJobSchema>;
export type PublishLoopJob = z.infer<typeof publishLoopJobSchema>;
export type DeviceManifestResponse = z.infer<typeof deviceManifestResponseSchema>;
