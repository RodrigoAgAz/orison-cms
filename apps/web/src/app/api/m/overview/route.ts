import { requirePhoneAppActor } from "@/lib/auth";
import { apiError, apiResponse } from "@/lib/http";
import { getMobileOverview } from "@/lib/mobile";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const actor = await requirePhoneAppActor();
    return apiResponse(await getMobileOverview(actor));
  } catch (error) {
    return apiError(error);
  }
}
