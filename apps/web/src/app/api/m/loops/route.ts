import { requireApiUser } from "@/lib/auth";
import { apiError, apiResponse } from "@/lib/http";
import { listMobileLoops } from "@/lib/mobile";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireApiUser();
    return apiResponse({ items: await listMobileLoops() });
  } catch (error) {
    return apiError(error);
  }
}
