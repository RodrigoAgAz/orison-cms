import { createWriteStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { finished } from "node:stream/promises";

import { ApiError } from "./http";

export function sanitizeUploadFilename(filename: string, fallback = "loop.mp4") {
  const base = path.basename(filename).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return base.length > 0 ? base : fallback;
}

/**
 * Stream a raw request body to a fresh temp directory, enforcing `maxBytes` both from
 * Content-Length (before reading) and while streaming. The caller owns `tempDir` on success;
 * on failure it is removed here.
 */
export async function streamRequestBodyToTempFile(
  request: Request,
  options: { filename: string; maxBytes: number; tooLargeMessage: string; missingMessage: string; prefix?: string },
) {
  if (!request.body) {
    throw new ApiError(options.missingMessage);
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declaredBytes) && declaredBytes > options.maxBytes) {
      throw new ApiError(options.tooLargeMessage, 413);
    }
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), options.prefix ?? "orison-direct-upload-"));
  const tempFilePath = path.join(tempDir, sanitizeUploadFilename(options.filename));
  let uploadedBytes = 0;
  let tooLarge = false;
  const file = createWriteStream(tempFilePath);
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();

  try {
    // Read the body ourselves rather than piping Readable.fromWeb(): cancelling the web stream
    // part-way (when the limit is hit) makes undici throw an uncaught ERR_INVALID_STATE later.
    // Instead, once over the limit we stop writing and drain (bounded) before answering 413.
    const drainLimit = options.maxBytes + 64 * 1024 * 1024;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      uploadedBytes += value.byteLength;
      if (uploadedBytes > options.maxBytes) {
        tooLarge = true;
        if (uploadedBytes > drainLimit) {
          await reader.cancel().catch(() => undefined);
          break;
        }
        continue;
      }
      if (!file.write(value)) {
        await once(file, "drain");
      }
    }
    file.end();
    await finished(file);
    if (tooLarge) {
      throw new ApiError(options.tooLargeMessage, 413);
    }
  } catch (error) {
    file.destroy();
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return { tempDir, tempFilePath, sizeBytes: uploadedBytes };
}

// ISO-BMFF / QuickTime top-level atom types that can start an mp4/mov/m4v file.
const leadingAtoms = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot", "uuid"]);

/** Cheap sniff: does the file look like an MP4/MOV container? */
export async function looksLikeIsoMediaFile(filePath: string) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, 12, 0);
    if (bytesRead < 8) {
      return false;
    }
    return leadingAtoms.has(buffer.subarray(4, 8).toString("latin1"));
  } finally {
    await handle.close();
  }
}
