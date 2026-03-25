import { z } from "zod";

import { createSession, authenticateUser } from "@/lib/auth";
import { apiError, apiResponse, ApiError, parseJsonBody } from "@/lib/http";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, loginSchema);
    const user = await authenticateUser(body.email, body.password);

    if (!user) {
      throw new ApiError("Invalid email or password", 401);
    }

    await createSession(user);

    return apiResponse({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    });
  } catch (error) {
    return apiError(error);
  }
}

