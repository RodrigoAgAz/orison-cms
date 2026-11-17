import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  cancelUploadSession,
  finishUploadSession,
  getUploadSession,
  openUploadSession,
  PIECE_BYTES,
  pieceCountFor,
  pieceLength,
  putUploadPiece,
  sweepAbandonedUploads,
} from "../src/lib/chunked-upload";
import { ApiError } from "../src/lib/http";
import { sendInPieces, UploadRefused } from "../src/mobile/lib/piece-sender";

let root: string;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "chunked-test-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const MAX = 500 * 1024 * 1024;
function stream(bytes: Uint8Array) {
  return new Blob([bytes as Uint8Array<ArrayBuffer>]).stream() as ReadableStream<Uint8Array>;
}
function sha(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function open(fingerprint: string, size: number, data: unknown = { name: "x" }) {
  return openUploadSession({ fingerprint, fileName: "clip.mov", size, maxBytes: MAX, tooLargeMessage: "too big", data, root });
}
function piece(file: Uint8Array, index: number) {
  return file.subarray(index * PIECE_BYTES, Math.min(file.length, (index + 1) * PIECE_BYTES));
}

describe("piece arithmetic", () => {
  it("splits a file into pieces of PIECE_BYTES with a shorter last one", () => {
    assert.equal(pieceCountFor(1), 1);
    assert.equal(pieceCountFor(PIECE_BYTES), 1);
    assert.equal(pieceCountFor(PIECE_BYTES + 1), 2);
    assert.equal(pieceLength(1, PIECE_BYTES + 10), 10);
    assert.equal(pieceLength(0, PIECE_BYTES + 10), PIECE_BYTES);
    assert.equal(pieceLength(2, PIECE_BYTES + 10), -1);
    assert.equal(pieceCountFor(300 * 1024 * 1024), 75);
  });
});

describe("server side: sessions, pieces, joining", () => {
  it("refuses a file over the limit before anything is stored", async () => {
    await assert.rejects(open("fp-too-big-0001", MAX + 1), (error: unknown) => error instanceof ApiError && error.status === 413);
    await assert.rejects(open("fp-empty-00001", 0), (error: unknown) => error instanceof ApiError && error.status === 400);
  });

  it("joins pieces sent out of order and retried, exactly once", async () => {
    const file = randomBytes(PIECE_BYTES * 2 + 1234);
    const { session, isNew } = await open("fp-join-000001", file.length);
    assert.equal(isNew, true);
    assert.equal(session.pieceCount, 3);
    await putUploadPiece({ id: session.id, index: 2, body: stream(piece(file, 2)), sha256: sha(piece(file, 2)), root });
    await putUploadPiece({ id: session.id, index: 0, body: stream(piece(file, 0)), root });
    // A retry of a piece already here (its answer was lost) is harmless.
    await putUploadPiece({ id: session.id, index: 0, body: stream(piece(file, 0)), root });
    await assert.rejects(
      finishUploadSession({ id: session.id, tempPrefix: "chunked-test-join-", root, consume: async () => "x", storeResult: (d) => d, readResult: () => null }),
      (error: unknown) => error instanceof ApiError && error.status === 409,
      "not all pieces yet",
    );
    await putUploadPiece({ id: session.id, index: 1, body: stream(piece(file, 1)), root });
    let joined: Buffer | null = null;
    let calls = 0;
    const finish = () =>
      finishUploadSession<{ name: string; result?: string }, string>({
        id: session.id,
        tempPrefix: "chunked-test-join-",
        root,
        consume: async ({ filePath, tempDir }) => {
          calls += 1;
          joined = await readFile(filePath);
          await rm(tempDir, { recursive: true, force: true });
          return "loop-1";
        },
        storeResult: (data, result) => ({ ...data, result }),
        readResult: (data) => data.result ?? null,
      });
    assert.equal(await finish(), "loop-1");
    assert.ok(joined && Buffer.compare(joined, file) === 0, "the joined file is the original");
    // The client missed the answer and asks again: same result, nothing processed twice.
    assert.equal(await finish(), "loop-1");
    assert.equal(calls, 1);
    const names = await readdir(path.join(root, session.id));
    assert.deepEqual(names, ["meta.json"], "pieces deleted once joined");
  });

  it("refuses pieces that are too long, short, damaged or not part of the file", async () => {
    const file = randomBytes(PIECE_BYTES + 100);
    const { session } = await open("fp-bad-piece-01", file.length);
    const tooLong = new Uint8Array(PIECE_BYTES + 1);
    await assert.rejects(putUploadPiece({ id: session.id, index: 0, body: stream(tooLong), root }), (e: unknown) => e instanceof ApiError && e.status === 413);
    await assert.rejects(putUploadPiece({ id: session.id, index: 1, body: stream(new Uint8Array(10)), root }), (e: unknown) => e instanceof ApiError && e.status === 400);
    await assert.rejects(
      putUploadPiece({ id: session.id, index: 1, body: stream(piece(file, 1)), sha256: "0".repeat(64), root }),
      (e: unknown) => e instanceof ApiError && /damaged/.test(e.message),
    );
    await assert.rejects(putUploadPiece({ id: session.id, index: 5, body: stream(new Uint8Array(1)), root }), (e: unknown) => e instanceof ApiError && e.status === 400);
    const state = await getUploadSession(session.id, root);
    assert.deepEqual(state.received, [], "nothing refused counts");
    const leftovers = (await readdir(path.join(root, session.id))).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "no temp files left");
  });

  it("a check on the first piece can refuse the file early", async () => {
    const file = randomBytes(1000);
    const { session } = await open("fp-check-00001", file.length);
    await assert.rejects(
      putUploadPiece({
        id: session.id,
        index: 0,
        body: stream(file),
        root,
        check: async () => {
          throw new ApiError("not a video", 415);
        },
      }),
      (e: unknown) => e instanceof ApiError && e.status === 415,
    );
    assert.deepEqual((await getUploadSession(session.id, root)).received, []);
  });

  it("the same file opened again carries on from the pieces already here (and is not new)", async () => {
    const file = randomBytes(PIECE_BYTES * 2 + 5);
    const first = await open("fp-resume-0001", file.length, { name: "first" });
    await putUploadPiece({ id: first.session.id, index: 0, body: stream(piece(file, 0)), root });
    const again = await open("fp-resume-0001", file.length, { name: "renamed" });
    assert.equal(again.isNew, false);
    assert.equal(again.session.id, first.session.id);
    assert.deepEqual(again.session.received, [0]);
    assert.equal(again.session.receivedBytes, PIECE_BYTES);
    assert.deepEqual(again.session.data, { name: "renamed" });
    // A different file (other size) is a new upload.
    const other = await open("fp-resume-0001", file.length + 1);
    assert.equal(other.isNew, true);
  });

  it("an unknown or cancelled upload is a 404 (what the app reads as 'start again')", async () => {
    await assert.rejects(getUploadSession("0".repeat(32), root), (e: unknown) => e instanceof ApiError && e.status === 404);
    await assert.rejects(getUploadSession("../../etc", root), (e: unknown) => e instanceof ApiError && e.status === 404);
    const { session } = await open("fp-cancel-0001", 10);
    await cancelUploadSession(session.id, root);
    await assert.rejects(putUploadPiece({ id: session.id, index: 0, body: stream(new Uint8Array(10)), root }), (e: unknown) => e instanceof ApiError && e.status === 404);
  });

  it("abandoned uploads are swept, recent ones kept", async () => {
    const old = await open("fp-sweep-old-01", 10);
    const fresh = await open("fp-sweep-new-01", 10);
    const metaPath = path.join(root, old.session.id, "meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    meta.updatedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
    await writeFile(metaPath, JSON.stringify(meta));
    await utimes(path.join(root, old.session.id), new Date(0), new Date(0));
    const removed = await sweepAbandonedUploads({ root, force: true });
    assert.ok(removed.includes(old.session.id));
    assert.ok(!removed.includes(fresh.session.id));
  });
});

// ------------------------------------------------------------------------------- client sender

type Piece = Uint8Array;
/** An in-memory server speaking the /api/m/uploads protocol, with switches to misbehave. */
function fakeServer(pieceBytes = 8) {
  const sessions = new Map<string, { size: number; fingerprint: string; pieces: Map<number, Piece>; done?: string }>();
  const log: string[] = [];
  let next = 1;
  const state = { failNext: 0, lose: false, opened: 0, maxBody: 0 };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const view = (id: string) => {
    const session = sessions.get(id)!;
    const received = [...session.pieces.keys()].sort((a, b) => a - b);
    return {
      uploadId: id,
      size: session.size,
      pieceBytes,
      pieceCount: Math.max(1, Math.ceil(session.size / pieceBytes)),
      received,
      receivedBytes: received.reduce((sum, index) => sum + session.pieces.get(index)!.length, 0),
      status: session.done ? "finished" : "open",
      loopId: session.done ?? null,
    };
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    log.push(`${init.method} ${url}`);
    if (state.failNext > 0) {
      state.failNext -= 1;
      throw new TypeError("network down");
    }
    if (state.lose) {
      sessions.clear();
      state.lose = false;
    }
    if (url === "/api/m/uploads") {
      const body = JSON.parse(String(init.body));
      state.opened += 1;
      for (const [id, session] of sessions) {
        if (session.fingerprint === body.fingerprint && !session.done) return json(200, { ...view(id), resumed: true });
      }
      const id = `u${next++}`;
      sessions.set(id, { size: body.size, fingerprint: body.fingerprint, pieces: new Map() });
      return json(201, view(id));
    }
    const pieceMatch = /^\/api\/m\/uploads\/(\w+)\/pieces\/(\d+)$/.exec(url);
    if (pieceMatch) {
      const session = sessions.get(pieceMatch[1]);
      if (!session) return json(404, { error: "Upload not found" });
      const bytes = new Uint8Array(init.body as ArrayBuffer);
      state.maxBody = Math.max(state.maxBody, bytes.length);
      session.pieces.set(Number(pieceMatch[2]), bytes);
      return json(200, { received: session.pieces.size });
    }
    const completeMatch = /^\/api\/m\/uploads\/(\w+)\/complete$/.exec(url);
    if (completeMatch) {
      const session = sessions.get(completeMatch[1]);
      if (!session) return json(404, { error: "Upload not found" });
      const parts = [...session.pieces.entries()].sort((a, b) => a[0] - b[0]).map(([, bytes]) => bytes);
      const joined = Buffer.concat(parts);
      if (joined.length !== session.size) return json(409, { error: "missing", details: { received: [...session.pieces.keys()] } });
      session.done ??= `loop-${completeMatch[1]}`;
      (state as { joined?: Buffer }).joined = joined;
      return json(202, { loopId: session.done });
    }
    return json(404, { error: "?" });
  }) as unknown as typeof fetch;
  return { fetchImpl, log, state, sessions };
}

const noWait = async () => undefined;

describe("client: sending in pieces", () => {
  const file = new Blob([new Uint8Array(Array.from({ length: 30 }, (_, i) => i))]);
  const base = { fileName: "clip.mov", name: "Clip", target: null, fingerprint: "fp-client-1", sleep: noWait, waitForConnection: noWait, sha256: async () => null };

  it("sends every piece once, confirms progress per piece and joins", async () => {
    const server = fakeServer(8);
    const progress: number[] = [];
    const result = await sendInPieces({ ...base, file, fetchImpl: server.fetchImpl, signal: new AbortController().signal, events: { onProgress: (p) => progress.push(p.confirmedBytes) } });
    assert.match(result.loopId, /^loop-/);
    assert.deepEqual(progress, [8, 16, 24, 30]);
    assert.equal(server.log.filter((line) => line.includes("/pieces/")).length, 4);
    assert.equal(server.state.maxBody, 8, "no request carries more than one piece");
  });

  it("a dropped connection only pauses it: the failed piece is sent again, nothing else", async () => {
    const server = fakeServer(8);
    const connection: string[] = [];
    let armed = true;
    const result = await sendInPieces({
      ...base,
      file,
      fetchImpl: server.fetchImpl,
      signal: new AbortController().signal,
      events: {
        onProgress: (p) => {
          if (armed && p.piecesDone === 2) {
            armed = false;
            server.state.failNext = 3; // the next three requests fail
          }
        },
        onConnection: (state) => connection.push(state),
      },
    });
    assert.match(result.loopId, /^loop-/);
    const pieceCalls = server.log.filter((line) => line.includes("/pieces/"));
    assert.deepEqual(pieceCalls.map((line) => line.split("/").pop()), ["0", "1", "2", "2", "2", "2", "3"]);
    assert.deepEqual(connection, ["waiting", "sending"]);
  });

  it("opening the same file again carries on from the pieces the server has", async () => {
    const server = fakeServer(8);
    const controller = new AbortController();
    await assert.rejects(
      sendInPieces({
        ...base,
        file,
        fetchImpl: server.fetchImpl,
        signal: controller.signal,
        events: { onProgress: (p) => p.piecesDone === 2 && controller.abort() },
      }),
    );
    server.log.length = 0;
    const result = await sendInPieces({ ...base, file, fetchImpl: server.fetchImpl, signal: new AbortController().signal });
    assert.match(result.loopId, /^loop-/);
    assert.deepEqual(
      server.log.filter((line) => line.includes("/pieces/")).map((line) => line.split("/").pop()),
      ["2", "3"],
      "only the missing pieces",
    );
  });

  it("if the server loses the upload (restart on a fresh disk) it starts again by itself", async () => {
    const server = fakeServer(8);
    const restarts: number[] = [];
    let armed = true;
    const result = await sendInPieces({
      ...base,
      file,
      fetchImpl: server.fetchImpl,
      signal: new AbortController().signal,
      events: {
        onProgress: (p) => {
          if (armed && p.piecesDone === 3) {
            armed = false;
            server.state.lose = true;
          }
        },
        onRestart: (count) => restarts.push(count),
      },
    });
    assert.match(result.loopId, /^loop-/);
    assert.deepEqual(restarts, [1]);
    assert.equal(server.state.opened, 2);
    assert.equal(Buffer.compare((server.state as unknown as { joined: Buffer }).joined, Buffer.from(Array.from({ length: 30 }, (_, i) => i))), 0);
  });

  it("a refusal (too big, not a video, limit reached) stops it with the server's words", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "Videos must be up to 500MB" }), { status: 413 })) as unknown as typeof fetch;
    await assert.rejects(
      sendInPieces({ ...base, file, fetchImpl, signal: new AbortController().signal }),
      (error: unknown) => error instanceof UploadRefused && error.status === 413 && /500MB/.test(error.message),
    );
  });
});
