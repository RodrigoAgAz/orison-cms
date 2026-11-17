import { requireApiUser } from "@/lib/auth";
import { apiError, apiResponse } from "@/lib/http";
import { cmsSettingsInputSchema, getCmsSettings, updateCmsSettings } from "@/lib/cms-settings";
import { parseBody, toApiError } from "@/lib/loop-api";

export async function GET() {
  try {
    await requireApiUser();
    return apiResponse(await getCmsSettings());
  } catch (error) {
    return apiError(toApiError(error));
  }
}

export async function PUT(request: Request) {
  try {
    await requireApiUser();
    const body = await parseBody(request, cmsSettingsInputSchema);
    await updateCmsSettings(body);
    return apiResponse(await getCmsSettings());
  } catch (error) {
    return apiError(toApiError(error));
  }
}
