// Desktop and phone uploads share lib/chunked-upload.ts and lib/piece-sender.ts: a session belongs
// to the family of routes that opened it, and the sender speaks to whichever base URL it is given.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  cancelUploadSession,
  finishUploadSession,
  getUploadSession,
  openUploadSession,
  putUploadPiece,
} from "../src/lib/chunked-upload";
import { ApiError } from "../src/lib/http";
import { sendFileInPieces } from "../src/lib/piece-sender";

let root: string;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "orison-scope-test-"));
});
after(() => rm(root, { recursive: true, force: true }));

const notFound = (error: unknown) => error instanceof ApiError && error.status === 404;
const body = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

describe("upload scopes", () => {
  it("keeps the same file opened from the phone and the desktop apart", async () => {
    const common = { fingerprint: "v1:samefile0001", fileName: "a.mp4", size: 10, maxBytes: 100, tooLargeMessage: "too big", root };
    const phone = await openUploadSession({ ...common, data: { from: "phone" } });
    const desktop = await openUploadSession({ ...common, data: { from: "desktop" }, scope: "desktop" });
    assert.notEqual(phone.session.id, desktop.session.id);
    assert.equal(desktop.isNew, true);
    const again = await openUploadSession({ ...common, data: { from: "desktop again" }, scope: "desktop" });
    assert.equal(again.session.id, desktop.session.id, "reopening in the same scope carries on");
    assert.equal((await getUploadSession<{ from: string }>(phone.session.id, root)).data.from, "phone", "the phone's data is untouched");
  });

  it("refuses a session through another scope's routes", async () => {
    const { session } = await openUploadSession({
      fingerprint: "v1:desktoponly1",
      fileName: "b.mp4",
      size: 4,
      maxBytes: 100,
      tooLargeMessage: "too big",
      data: {},
      root,
      scope: "desktop",
    });
    await assert.rejects(getUploadSession(session.id, root), notFound);
    await assert.rejects(putUploadPiece({ id: session.id, index: 0, body: body(new Uint8Array(4)), root }), notFound);
    await assert.rejects(
      finishUploadSession({ id: session.id, root, tempPrefix: "orison-scope-", consume: async () => 1, storeResult: (d) => d, readResult: () => null }),
      notFound,
    );
    await assert.rejects(cancelUploadSession(session.id, root), notFound);
    await putUploadPiece({ id: session.id, index: 0, body: body(new Uint8Array(4)), root, scope: "desktop" });
    assert.deepEqual((await getUploadSession(session.id, root, "desktop")).received, [0]);
    await cancelUploadSession(session.id, root, "desktop");
    await assert.rejects(getUploadSession(session.id, root, "desktop"), notFound);
  });
});

describe("sendFileInPieces", () => {
  it("speaks to the base URL it is given and returns the route's answer", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const file = new Blob([new Uint8Array(10)]);
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ method: String(init.method), url, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
      const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
      if (url === "/api/uploads") return json(201, { uploadId: "u1", size: 10, pieceBytes: 4, pieceCount: 3, received: [1], receivedBytes: 4, status: "open" });
      if (url.includes("/pieces/")) return json(200, {});
      if (url.endsWith("/complete")) return json(202, { kind: "asset", assetId: "a1", filename: "x.png" });
      return json(404, { error: "no" });
    }) as typeof fetch;
    const result = await sendFileInPieces({
      baseUrl: "/api/uploads/",
      open: { kind: "asset", category: "ADVERTISEMENT" },
      file,
      fileName: "x.png",
      fingerprint: "v1:abcdefgh",
      signal: new AbortController().signal,
      fetchImpl,
      sha256: async () => null,
    });
    assert.deepEqual(result, { kind: "asset", assetId: "a1", filename: "x.png" });
    assert.deepEqual(calls[0].body, { kind: "asset", category: "ADVERTISEMENT", fileName: "x.png", size: 10, fingerprint: "v1:abcdefgh" });
    assert.deepEqual(
      calls.slice(1).map((call) => `${call.method} ${call.url}`),
      ["PUT /api/uploads/u1/pieces/0", "PUT /api/uploads/u1/pieces/2", "POST /api/uploads/u1/complete"],
      "only the pieces the server does not have, then complete",
    );
  });
});
