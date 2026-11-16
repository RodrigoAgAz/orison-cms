import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, describe, it } from "node:test";

import { writeBodyToFile } from "../src/lib/stream-to-file";

const dir = mkdtempSync(path.join(os.tmpdir(), "orison-stream-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stub of an S3 GetObject body (Node Readable, like the SDK's IncomingMessage) that refuses to
 * send its second half until the first half is on disk. A buffering implementation never
 * writes anything before the stream ends, so it would time out here.
 */
function streamingProbe(filePath: string, chunk: Buffer) {
  let sent = 0;
  return new Readable({
    async read() {
      if (sent === 0) {
        sent += 1;
        this.push(chunk);
        return;
      }
      if (sent === 1) {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          if (existsSync(filePath) && statSync(filePath).size >= chunk.length) break;
          await sleep(10);
        }
        if (!existsSync(filePath) || statSync(filePath).size < chunk.length) {
          this.destroy(new Error("nothing was written before the body ended: the object is being buffered"));
          return;
        }
        sent += 1;
        this.push(chunk);
        return;
      }
      this.push(null);
    },
  });
}

describe("writeBodyToFile (S3 download to disk)", () => {
  it("streams a Node Readable body to disk while it is still arriving", async () => {
    const target = path.join(dir, "nested", "loop.mp4");
    const chunk = Buffer.alloc(256 * 1024, 1);
    await writeBodyToFile(streamingProbe(target, chunk), target);
    assert.equal(statSync(target).size, chunk.length * 2);
  });

  it("accepts an SDK body exposing transformToWebStream()", async () => {
    const target = path.join(dir, "web.bin");
    const body = {
      transformToWebStream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("hello "));
            controller.enqueue(new TextEncoder().encode("world"));
            controller.close();
          },
        }),
    };
    await writeBodyToFile(body, target);
    assert.equal(readFileSync(target, "utf8"), "hello world");
  });

  it("accepts a web ReadableStream and raw bytes", async () => {
    const a = path.join(dir, "a.bin");
    await writeBodyToFile(new Blob(["abc"]).stream(), a);
    assert.equal(readFileSync(a, "utf8"), "abc");
    const b = path.join(dir, "b.bin");
    await writeBodyToFile(new Uint8Array([1, 2, 3]), b);
    assert.deepEqual([...readFileSync(b)], [1, 2, 3]);
  });

  it("removes the partial file when the stream fails", async () => {
    const target = path.join(dir, "broken.bin");
    const body = new Readable({
      read() {
        this.push(Buffer.alloc(1024));
        this.destroy(new Error("connection reset"));
      },
    });
    await assert.rejects(writeBodyToFile(body, target), /connection reset/);
    assert.equal(existsSync(target), false);
  });

  it("rejects a missing body", async () => {
    await assert.rejects(writeBodyToFile(undefined, path.join(dir, "none.bin")), /no body/);
  });
});
