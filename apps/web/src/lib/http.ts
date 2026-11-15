import { NextResponse } from "next/server";
import type { ZodTypeAny, output } from "zod";

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

// Typed by the schema's output: a schema with .catch()/.default() has a wider input type, and
// inferring T from ZodSchema<T> would pick that input (e.g. unknown) instead of the parsed type.
export async function parseJsonBody<S extends ZodTypeAny>(request: Request, schema: S): Promise<output<S>> {
  const body = await request.json();
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiError("Invalid request body", 400, result.error.flatten());
  }
  return result.data;
}

