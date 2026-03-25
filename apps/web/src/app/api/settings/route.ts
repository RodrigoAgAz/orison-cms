import { settingsSchema, type SettingsInput } from "@orison/shared";

import { apiError, apiResponse, parseJsonBody } from "@/lib/http";
import { getCmsSettings, updateCmsSettings } from "@/lib/cms-settings";

export async function GET() {
  try {
    return apiResponse(await getCmsSettings());
  } catch (error) {
    return apiError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await parseJsonBody(request, settingsSchema)) as SettingsInput;
    const settings = await updateCmsSettings(body);
    return apiResponse(settings);
  } catch (error) {
    return apiError(error);
  }
}
