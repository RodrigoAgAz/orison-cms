import { prisma } from "@orison/db";
import { defaultFillerTemplate, type SettingsInput } from "@orison/shared";

export async function getCmsSettings(): Promise<SettingsInput> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: "cms" },
  });

  if (!row) {
    return {
      defaultFillerTemplate: [...defaultFillerTemplate],
      syncIntervalSeconds: 1800,
      heartbeatIntervalSeconds: 300,
      notificationEmails: [],
      safetyVideoAssetId: null,
    };
  }

  const value = row.value as Partial<SettingsInput>;
  return {
    defaultFillerTemplate:
      value.defaultFillerTemplate && value.defaultFillerTemplate.length > 0
        ? value.defaultFillerTemplate
        : [...defaultFillerTemplate],
    syncIntervalSeconds: value.syncIntervalSeconds ?? 1800,
    heartbeatIntervalSeconds: value.heartbeatIntervalSeconds ?? 300,
    notificationEmails: value.notificationEmails ?? [],
    safetyVideoAssetId: value.safetyVideoAssetId ?? null,
  };
}

export async function updateCmsSettings(settings: SettingsInput) {
  return prisma.systemSetting.upsert({
    where: { key: "cms" },
    update: {
      value: settings,
    },
    create: {
      key: "cms",
      value: settings,
    },
  });
}
