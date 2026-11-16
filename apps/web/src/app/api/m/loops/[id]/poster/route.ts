import { NextResponse } from "next/server";

import { requirePhoneAppActor } from "@/lib/auth";
import { apiError, ApiError } from "@/lib/http";
import { ensureLoopPoster } from "@/lib/loops";
import { getStorageRouteRedirectUrl, readObject } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** JPEG still of a loop, generated lazily from the compiled video and cached in storage. */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    await requirePhoneAppActor();
    const posterKey = await ensureLoopPoster(params.id);
    if (!posterKey) {
      throw new ApiError("This loop has no video yet", 404);
    }
    const etag = `"${posterKey.split("/").pop()}"`;
    if (request.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag } });
    }
    const redirectUrl = await getStorageRouteRedirectUrl(posterKey);
    if (redirectUrl) {
      return NextResponse.redirect(redirectUrl, 307);
    }
    const body = await readObject(posterKey);
    return new NextResponse(body, {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(body.length),
        // The URL is stable per loop but the poster changes if the loop is republished.
        "Cache-Control": "private, max-age=300",
        ETag: etag,
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
