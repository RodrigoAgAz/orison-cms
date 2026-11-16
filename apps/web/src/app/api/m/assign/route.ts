import { revalidatePath } from "next/cache";

import { assignBodySchema, assignLoop } from "@/lib/assignment";
import { requirePhoneAppActor } from "@/lib/auth";
import { apiError, apiResponse, ApiError, parseJsonBody } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const actor = await requirePhoneAppActor();
    const body = await parseJsonBody(request, assignBodySchema).catch((error) => {
      if (error instanceof SyntaxError) throw new ApiError("Request body must be JSON", 400);
      throw error;
    });
    const result = await assignLoop(body, actor);
    revalidatePath("/");
    revalidatePath("/devices");
    return apiResponse(result);
  } catch (error) {
    return apiError(error);
  }
}
