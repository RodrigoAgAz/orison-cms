import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

import { apiError, ApiError } from "@/lib/http";

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
    const storageRoot = path.join(process.cwd(), "tmp", "storage");
    const targetPath = path.join(storageRoot, ...params.path);

    if (!targetPath.startsWith(storageRoot)) {
      throw new ApiError("Invalid path", 400);
    }

    const buffer = await readFile(targetPath);
    const extension = path.extname(targetPath).toLowerCase();

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
