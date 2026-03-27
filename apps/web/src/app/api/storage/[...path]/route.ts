import path from "node:path";
import { NextResponse } from "next/server";

import { apiError, ApiError } from "@/lib/http";
import { getStorageRouteRedirectUrl, readObject } from "@/lib/storage";

const contentTypes: Record<string, string> = {
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

type Props = {
  params: {
    path: string[];
  };
};

export async function GET(_: Request, { params }: Props) {
  try {
    if (params.path.length === 0 || params.path.some((segment) => segment === "..")) {
      throw new ApiError("Invalid path", 400);
    }

    const key = params.path.join("/");
    const redirectUrl = await getStorageRouteRedirectUrl(key);
    if (redirectUrl) {
      return NextResponse.redirect(redirectUrl, 307);
    }

    const buffer = await readObject(key);
    const extension = path.extname(key).toLowerCase();

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentTypes[extension] ?? "application/octet-stream",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function HEAD(_: Request, { params }: Props) {
  try {
    if (params.path.length === 0 || params.path.some((segment) => segment === "..")) {
      throw new ApiError("Invalid path", 400);
    }

    const key = params.path.join("/");
    const redirectUrl = await getStorageRouteRedirectUrl(key);
    if (redirectUrl) {
      return NextResponse.redirect(redirectUrl, 307);
    }

    const buffer = await readObject(key);
    const extension = path.extname(key).toLowerCase();

    return new NextResponse(null, {
      headers: {
        "Content-Type": contentTypes[extension] ?? "application/octet-stream",
        "Content-Length": String(buffer.length),
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
