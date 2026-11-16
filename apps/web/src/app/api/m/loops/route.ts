import { requirePhoneAppActor } from "@/lib/auth";
import { apiError, apiResponse } from "@/lib/http";
import { listMobileLoops } from "@/lib/mobile";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requirePhoneAppActor();
    return apiResponse({ items: await listMobileLoops() });
  } catch (error) {
    return apiError(error);
  }
}
