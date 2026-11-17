import { z } from "zod";

import { prisma } from "@orison/db";
import { assetCategorySchema, settingsSchema, type SettingsInput } from "@orison/shared";

import { DEFAULT_LOOP_FRAME } from "./media-format";
import { fillerTemplateProblems } from "./slot-rules";

/** A filler template row: a filler category, or any filler at all. */
export const ANY_FILLER = "ANY_FILLER" as const;
export type FillerTemplateEntry = { category: z.infer<typeof assetCategorySchema> | typeof ANY_FILLER; durationMs: number };

/**
 * Default filler template: one filler for the rest of the minute, chosen from any filler in the
 * library. (The old default asked for a weather clip and a news clip, which nothing generates.)
 * When the template does not add up to the time an advert leaves, its last row is adjusted.
 */
export const DEFAULT_FILLER_TEMPLATE: FillerTemplateEntry[] = [{ category: ANY_FILLER, durationMs: 48_000 }];

export type CmsSettings = Omit<SettingsInput, "defaultFillerTemplate"> & {
  defaultFillerTemplate: FillerTemplateEntry[];
  /** The picture size loops are compiled to (one definition: lib/loop-publish.ts reads it). */
  loopFrameWidth: number;
  loopFrameHeight: number;
};

const frameDimension = z.number().int().min(320).max(3840).refine((value) => value % 2 === 0, "must be an even number");

/** What the settings page may save (the shared schema plus this page's own fields). */
export const cmsSettingsInputSchema = settingsSchema
  .omit({ defaultFillerTemplate: true, notificationEmails: true })
  .extend({
    defaultFillerTemplate: z
      .array(
        z.object({
          category: z.union([assetCategorySchema, z.literal(ANY_FILLER)]),
          durationMs: z.number().int().positive(),
        }),
      )
      .superRefine((template, context) => {
        for (const problem of fillerTemplateProblems(template)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: problem });
        }
      }),
    loopFrameWidth: frameDimension.default(DEFAULT_LOOP_FRAME.width),
    loopFrameHeight: frameDimension.default(DEFAULT_LOOP_FRAME.height),
  });

export type CmsSettingsInput = z.infer<typeof cmsSettingsInputSchema>;

function defaults(): CmsSettings {
  return {
    defaultFillerTemplate: DEFAULT_FILLER_TEMPLATE.map((item) => ({ ...item })),
    syncIntervalSeconds: 1800,
    heartbeatIntervalSeconds: 300,
    notificationEmails: [],
    safetyVideoAssetId: null,
    safetyMessageDurationSeconds: 8,
    loopFrameWidth: DEFAULT_LOOP_FRAME.width,
    loopFrameHeight: DEFAULT_LOOP_FRAME.height,
  };
}

export async function getCmsSettings(): Promise<CmsSettings> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: "cms" },
  });

  const base = defaults();
  if (!row) {
    return base;
  }

  const value = row.value as Partial<CmsSettings>;
  return {
    // A saved empty template stays empty (Auto-fill is then unavailable); only a template that was
    // never saved falls back to the default.
    defaultFillerTemplate: Array.isArray(value.defaultFillerTemplate) ? value.defaultFillerTemplate : base.defaultFillerTemplate,
    syncIntervalSeconds: value.syncIntervalSeconds ?? base.syncIntervalSeconds,
    heartbeatIntervalSeconds: value.heartbeatIntervalSeconds ?? base.heartbeatIntervalSeconds,
    notificationEmails: value.notificationEmails ?? [],
    safetyVideoAssetId: value.safetyVideoAssetId ?? null,
    safetyMessageDurationSeconds: value.safetyMessageDurationSeconds ?? base.safetyMessageDurationSeconds,
    loopFrameWidth: value.loopFrameWidth ?? base.loopFrameWidth,
    loopFrameHeight: value.loopFrameHeight ?? base.loopFrameHeight,
  };
}

/** Save what the settings page sends; keeps stored fields the page no longer edits. */
export async function updateCmsSettings(settings: CmsSettingsInput) {
  const current = await getCmsSettings();
  const value = { ...current, ...settings };
  return prisma.systemSetting.upsert({
    where: { key: "cms" },
    update: { value },
    create: { key: "cms", value },
  });
}

export function loopFrameFrom(settings: Pick<CmsSettings, "loopFrameWidth" | "loopFrameHeight">) {
  return { width: settings.loopFrameWidth, height: settings.loopFrameHeight };
}
