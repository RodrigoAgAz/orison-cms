import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

import { apiError, ApiError } from "@/lib/http";
import { parseRangeHeader } from "@/lib/http-range";
import { getStorageRouteRedirectUrl, statLocalObject } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const contentTypes: Record<string, string> = {
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

type Props = {
  params: {
    path: string[];
  };
};

async function serve(request: Request, { params }: Props, includeBody: boolean) {
  try {
    if (params.path.length === 0 || params.path.some((segment) => segment === ".." || segment === ".")) {
      throw new ApiError("Invalid path", 400);
    }

    const key = params.path.join("/");
    const redirectUrl = await getStorageRouteRedirectUrl(key);
    if (redirectUrl) {
      return NextResponse.redirect(redirectUrl, 307);
    }

    const file = await statLocalObject(key);
    if (!file) {
      throw new ApiError("Not found", 404);
    }

    const extension = path.extname(key).toLowerCase();
    const baseHeaders: Record<string, string> = {
      "Content-Type": contentTypes[extension] ?? "application/octet-stream",
      "Cache-Control": "public, max-age=3600",
      "Accept-Ranges": "bytes",
      "Last-Modified": file.mtime.toUTCString(),
      ETag: `"${file.size.toString(16)}-${Math.floor(file.mtime.getTime() / 1000).toString(16)}"`,
    };

    // If-Range with a validator that no longer matches -> send the whole file.
    const ifRange = request.headers.get("if-range");
    const rangeHeader =
      ifRange && ifRange !== baseHeaders.ETag && ifRange !== baseHeaders["Last-Modified"]
        ? null
        : request.headers.get("range");
    const range = parseRangeHeader(rangeHeader, file.size);

    if (range === "unsatisfiable") {
      return new NextResponse(null, {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${file.size}` },
      });
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : file.size - 1;
    const length = file.size === 0 ? 0 : end - start + 1;
    const headers: Record<string, string> = { ...baseHeaders, "Content-Length": String(length) };
    if (range) {
      headers["Content-Range"] = `bytes ${start}-${end}/${file.size}`;
    }

    const body =
      includeBody && length > 0
        ? (Readable.toWeb(createReadStream(file.filePath, { start, end })) as unknown as ReadableStream)
        : null;

    return new NextResponse(body, { status: range ? 206 : 200, headers });
  } catch (error) {
    return apiError(error);
  }
}

export async function GET(request: Request, props: Props) {
  return serve(request, props, true);
}

export async function HEAD(request: Request, props: Props) {
  return serve(request, props, false);
}
