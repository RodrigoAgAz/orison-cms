import { getSessionUser } from "@/lib/auth";
import { apiError, apiResponse, ApiError } from "@/lib/http";

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) {
      throw new ApiError("Unauthenticated", 401);
    }

    return apiResponse(user);
  } catch (error) {
    return apiError(error);
  }
}

