import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

/**
 * Write an object body to disk without holding it in memory. Accepts what the AWS SDK v3 returns
 * for `GetObjectCommand` `Body` in Node (an `IncomingMessage`, i.e. a Node Readable with the SDK's
 * stream mixin), a web ReadableStream, anything with `transformToWebStream()`, or raw bytes.
 * Removes the partial file if the stream fails.
 */
export async function writeBodyToFile(body: unknown, filePath: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const source = toNodeReadable(body);
  try {
    await pipeline(source, createWriteStream(filePath));
  } catch (error) {
    await rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
  return filePath;
}

function toNodeReadable(body: unknown): Readable {
  if (!body) {
    throw new Error("Object has no body");
  }
  if (body instanceof Readable) {
    return body;
  }
  if (typeof body === "string" || body instanceof Uint8Array) {
    return Readable.from([typeof body === "string" ? Buffer.from(body) : Buffer.from(body)]);
  }
  const candidate = body as {
    getReader?: unknown;
    transformToWebStream?: () => unknown;
    pipe?: unknown;
    [Symbol.asyncIterator]?: unknown;
  };
  if (typeof candidate.getReader === "function") {
    return Readable.fromWeb(body as WebReadableStream);
  }
  if (typeof candidate.transformToWebStream === "function") {
    return Readable.fromWeb(candidate.transformToWebStream() as WebReadableStream);
  }
  if (typeof candidate[Symbol.asyncIterator] === "function") {
    return Readable.from(body as AsyncIterable<Uint8Array>);
  }
  throw new Error("Unsupported object body type");
}
