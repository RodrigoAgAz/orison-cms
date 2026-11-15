import { requireApiUser } from "@/lib/auth";
import { apiError, apiResponse } from "@/lib/http";
import { getMobileOverview } from "@/lib/mobile";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireApiUser();
    return apiResponse(await getMobileOverview(user));
  } catch (error) {
    return apiError(error);
  }
}
