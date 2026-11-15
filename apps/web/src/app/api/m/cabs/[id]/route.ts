import { requireApiUser } from "@/lib/auth";
import { apiError, apiResponse } from "@/lib/http";
import { getCabDetail } from "@/lib/mobile";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: { id: string } }) {
  try {
    await requireApiUser();
    return apiResponse(await getCabDetail(params.id));
  } catch (error) {
    return apiError(error);
  }
}
