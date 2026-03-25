import { NextResponse } from "next/server";
import type { ZodSchema } from "zod";

export class ApiError extends Error {
  constructor(
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function apiResponse<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function apiError(error: unknown) {
  if (error instanceof ApiError) {
    return NextResponse.json(
      {
        error: error.message,
        details: error.details,
      },
      { status: error.status },
    );
  }

  console.error(error);
  return NextResponse.json(
    {
      error: "Internal server error",
    },
    { status: 500 },
  );
}

export async function parseJsonBody<T>(request: Request, schema: ZodSchema<T>) {
  const body = await request.json();
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiError("Invalid request body", 400, result.error.flatten());
  }
  return result.data;
}

