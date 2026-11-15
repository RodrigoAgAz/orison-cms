import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildIchnaeaRequest,
  createIchnaeaProvider,
  createOpenCellIdProvider,
  ERROR_RETRY_MS,
  NOT_FOUND_RETRY_MS,
  parseIchnaeaResponse,
  parseOpenCellIdResponse,
  resolveCellLocation,
  type CachedCell,
  type CellCacheStore,
  type CellKey,
  type FetchLike,
} from "../src/lib/cell-lookup";

const cell: CellKey = { radio: "lte", mcc: 234, mnc: 10, lac: 12345, cellId: 27447555 };
const now = new Date("2026-11-15T12:00:00Z");
const quiet = { warn: () => undefined };

function memoryStore() {
  const map = new Map<string, CachedCell>();
  const key = (c: CellKey) => `${c.radio}/${c.mcc}/${c.mnc}/${c.lac}/${c.cellId}`;
  const store: CellCacheStore = {
    async get(c) { return map.get(key(c)) ?? null; },
    async put(c, entry) { map.set(key(c), entry); },
  };
  return { store, map };
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetch, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("provider parsing", () => {
  it("OpenCelliD", () => {
    assert.deepEqual(parseOpenCellIdResponse(200, JSON.stringify({ lat: 51.5, lon: -0.12, range: 800, mcc: 234 })), {
      status: "found", lat: 51.5, lng: -0.12, accuracyM: 800,
    });
    assert.deepEqual(parseOpenCellIdResponse(200, JSON.stringify({ error: "Cell not found", code: 1 })), { status: "not_found" });
    assert.equal(parseOpenCellIdResponse(200, JSON.stringify({ error: "Invalid API key", code: 2 })).status, "error");
    assert.equal(parseOpenCellIdResponse(500, "oops").status, "error");
  });
  it("Ichnaea / beaconDB", () => {
    assert.deepEqual(parseIchnaeaResponse(200, JSON.stringify({ location: { lat: 51.5, lng: -0.1 }, accuracy: 1200 })), {
      status: "found", lat: 51.5, lng: -0.1, accuracyM: 1200,
    });
    assert.deepEqual(parseIchnaeaResponse(404, JSON.stringify({ error: { code: 404, message: "Not found" } })), { status: "not_found" });
    assert.equal(parseIchnaeaResponse(429, "").status, "error");
  });
  it("Ichnaea request carries only tower identifiers and disables IP fallback", () => {
    assert.deepEqual(buildIchnaeaRequest(cell), {
      considerIp: false,
      fallbacks: { ipf: false, lacf: true },
      cellTowers: [{ radioType: "lte", mobileCountryCode: 234, mobileNetworkCode: 10, locationAreaCode: 12345, cellId: 27447555 }],
    });
  });
  it("OpenCelliD request URL", async () => {
    const { fetch, calls } = stubFetch(() => json(200, { lat: 1, lon: 2 }));
    await createOpenCellIdProvider({ apiKey: "k" }).lookup(cell, { fetch, signal: new AbortController().signal });
    const url = new URL(calls[0].url);
    assert.equal(url.origin + url.pathname, "https://opencellid.org/cell/get");
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      key: "k", mcc: "234", mnc: "10", lac: "12345", cellid: "27447555", radio: "LTE", format: "json",
    });
  });
});

describe("resolveCellLocation", () => {
  it("caches a hit and does not call providers again", async () => {
    const { store } = memoryStore();
    const { fetch, calls } = stubFetch(() => json(200, { location: { lat: 51.5, lng: -0.1 }, accuracy: 900 }));
    const providers = [createIchnaeaProvider({})];
    const first = await resolveCellLocation(cell, { store, providers, fetch, now, logger: quiet });
    const second = await resolveCellLocation(cell, { store, providers, fetch, now, logger: quiet });
    assert.deepEqual(first, { lat: 51.5, lng: -0.1, accuracyM: 900, provider: "beacondb" });
    assert.equal(second?.lat, 51.5);
    assert.equal(calls.length, 1);
  });

  it("falls through providers in order", async () => {
    const { store } = memoryStore();
    const { fetch, calls } = stubFetch((url) =>
      url.includes("opencellid") ? json(200, { error: "Cell not found", code: 1 }) : json(200, { location: { lat: 1.5, lng: 2.5 }, accuracy: 10 }),
    );
    const result = await resolveCellLocation(cell, {
      store, fetch, now, logger: quiet,
      providers: [createOpenCellIdProvider({ apiKey: "k" }), createIchnaeaProvider({})],
    });
    assert.equal(result?.provider, "beacondb");
    assert.equal(calls.length, 2);
  });

  it("negative-caches a miss with a long retry-after", async () => {
    const { store, map } = memoryStore();
    const { fetch, calls } = stubFetch(() => json(404, {}));
    const providers = [createIchnaeaProvider({})];
    assert.equal(await resolveCellLocation(cell, { store, providers, fetch, now, logger: quiet }), null);
    assert.equal(await resolveCellLocation(cell, { store, providers, fetch, now: new Date(now.getTime() + 3600_000), logger: quiet }), null);
    assert.equal(calls.length, 1);
    const entry = [...map.values()][0];
    assert.equal(entry.found, false);
    assert.equal(entry.retryAfter?.getTime(), now.getTime() + NOT_FOUND_RETRY_MS);
    // After retry-after it asks again.
    await resolveCellLocation(cell, { store, providers, fetch, now: new Date(now.getTime() + NOT_FOUND_RETRY_MS + 1), logger: quiet });
    assert.equal(calls.length, 2);
  });

  it("times out, never throws, and caches the error briefly", async () => {
    const { store, map } = memoryStore();
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const started = Date.now();
    const result = await resolveCellLocation(cell, {
      store, fetch, now, timeoutMs: 50, logger: quiet, providers: [createIchnaeaProvider({})],
    });
    assert.equal(result, null);
    assert.ok(Date.now() - started < 1000);
    assert.equal([...map.values()][0].retryAfter?.getTime(), now.getTime() + ERROR_RETRY_MS);
  });

  it("survives a throwing store and a throwing fetch", async () => {
    const store: CellCacheStore = {
      async get() { throw new Error("db down"); },
      async put() { throw new Error("db down"); },
    };
    const fetch: FetchLike = async () => { throw new Error("network"); };
    assert.equal(await resolveCellLocation(cell, { store, fetch, now, logger: quiet, providers: [createIchnaeaProvider({})] }), null);
  });

  it("with no providers configured it returns null without calling anything", async () => {
    const { store } = memoryStore();
    assert.equal(await resolveCellLocation(cell, { store, providers: [], now, logger: quiet }), null);
  });
});
