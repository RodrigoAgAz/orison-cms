// S3 branch of storage.ts against a stubbed S3 client (there is no S3 in development).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

const dir = mkdtempSync(path.join(os.tmpdir(), "orison-s3-test-"));
const originalSend = S3Client.prototype.send;
const sent: unknown[] = [];
let storage: typeof import("../src/lib/storage");

before(async () => {
  process.env.S3_BUCKET = "test-bucket";
  process.env.S3_REGION = "eu-west-2";
  process.env.AWS_ACCESS_KEY_ID = "AKIATEST";
  process.env.AWS_SECRET_ACCESS_KEY = "secret";
  // Stub: GetObject returns a body that arrives in chunks, like the SDK's IncomingMessage.
  S3Client.prototype.send = async function send(command: unknown) {
    sent.push(command);
    if (command instanceof GetObjectCommand) {
      const chunks = Array.from({ length: 64 }, (_, index) => Buffer.alloc(64 * 1024, index));
      return { Body: Readable.from(chunks) } as never;
    }
    throw new Error("unexpected command");
  } as typeof S3Client.prototype.send;
  storage = await import("../src/lib/storage");
});

after(() => {
  S3Client.prototype.send = originalSend;
  rmSync(dir, { recursive: true, force: true });
});

describe("storage on S3 (stubbed client)", () => {
  it("downloadObjectToFile streams GetObject's body to disk", async () => {
    assert.equal(storage.hasRemoteObjectStorage(), true);
    const target = path.join(dir, "deep", "loop.mp4");
    await storage.downloadObjectToFile("loops/abc/loop.mp4", target);
    const written = readFileSync(target);
    assert.equal(written.length, 64 * 64 * 1024);
    assert.equal(written[64 * 1024 * 10], 10);
    const command = sent.at(-1) as GetObjectCommand;
    assert.equal(command.input.Bucket, "test-bucket");
    assert.equal(command.input.Key, "loops/abc/loop.mp4");
  });

  it("getObjectReadLocation gives ffmpeg a signed URL instead of downloading", async () => {
    const source = await storage.getObjectReadLocation("loops/abc/loop.mp4");
    assert.equal(source.kind, "url");
    assert.match(source.location, /^https:\/\/.*test-bucket.*loops\/abc\/loop\.mp4\?.*X-Amz-Signature=/);
  });
});
