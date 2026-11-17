import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  BUILT_IN_LOOP_ID,
  normalizePlayerStatus,
  positionReportingFrom,
  reportsJourneysFor,
  splitSignal,
} from "../src/lib/mobile";
import { api, ApiFailure } from "../src/mobile/lib/api";
import { londonYesterdayKey, preparingWords, when, whenLong } from "../src/mobile/lib/format";
import {
  changeIsInPlace,
  changesWords,
  impactOf,
  passengerLine,
  placeWords,
  signalWords,
} from "../src/mobile/lib/status";
import { fetchResource, readResource, retryDelay } from "../src/mobile/lib/store";
import type { CabSummary, Overview } from "../src/mobile/lib/types";
import { connectionKind } from "../src/mobile/screens/upload";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function cab(patch: Partial<CabSummary> & { id: string }): CabSummary {
  return {
    serialNumber: patch.id,
    label: patch.id,
    driverName: null,
    group: null,
    status: "online",
    playerStatus: "idle",
    lastSeenAt: new Date().toISOString(),
    playing: null,
    expected: null,
    expectedSource: "fleet",
    isUpToDate: false,
    uptimeSeconds: null,
    onlineSince: null,
    hoursOnlineToday: 0,
    inServiceSince: new Date().toISOString(),
    location: null,
    isPaused: false,
    pausedReason: null,
    cabPaused: false,
    fleetPaused: false,
    changeLagMinutes: 30,
    ...patch,
  };
}

const A = { id: "A", name: "DAZN 26 Oct rotation (ad in journey)", posterUrl: null };
const B = { id: "B", name: "Explore 1920x1080", posterUrl: null };

function overview(cabs: CabSummary[], groups: Overview["groups"] = [], fleetLoopId = "A"): Overview {
  return {
    generatedAt: new Date().toISOString(),
    user: { id: "x", name: "x", email: null, role: "EDITOR", signedIn: false },
    counts: { total: cabs.length, online: 0, updating: 0, offline: 0, paused: 0 },
    fleetLoop: {
      id: fleetLoopId,
      name: "fleet",
      status: "PUBLISHED",
      processing: { state: "ready", error: null, waiting: false, queuedBehind: 0 },
      durationMs: 600_000,
      posterUrl: null,
      videoUrl: null,
      publishedAt: null,
      createdAt: new Date().toISOString(),
      source: "builder",
      liveOn: { fleet: true, groups: [], cabCount: cabs.length },
    },
    fleetPaused: false,
    changeLagMinutes: 30,
    changeLag: { minMinutes: 30, maxMinutes: 30, slowCabs: cabs.length },
    groups,
    cabs,
    recentActivity: [],
  };
}

describe("when / whenLong (London days)", () => {
  it("says yesterday for the calendar day before, also the day after a clock change", () => {
    // 00:30 BST on Mon 30 March 2026 (the clocks went forward on Sun 29 March).
    const now = new Date("2026-03-29T23:30:00Z");
    assert.equal(londonYesterdayKey(now), "2026-03-29");
    assert.match(when("2026-03-29T12:00:00Z", now), /^yesterday /);
    assert.match(whenLong("2026-03-29T12:00:00Z", now), /^yesterday at /);
    // Autumn: 23:30 GMT on Mon 26 October 2026; Sunday 25th was 25 hours long.
    const autumn = new Date("2026-10-26T23:30:00Z");
    assert.equal(londonYesterdayKey(autumn), "2026-10-25");
    assert.match(when("2026-10-25T00:30:00Z", autumn), /^yesterday /);
    assert.doesNotMatch(when("2026-10-24T22:30:00Z", autumn), /^yesterday/);
  });
  it("handles month and year boundaries", () => {
    assert.equal(londonYesterdayKey(new Date("2026-03-01T10:00:00Z")), "2026-02-28");
    assert.equal(londonYesterdayKey(new Date("2027-01-01T10:00:00Z")), "2026-12-31");
  });
});

describe("signal wording", () => {
  it("reads a positive figure as a percentage (NetworkManager), a negative one as dBm", () => {
    assert.equal(signalWords(62), "Good (62%)");
    assert.equal(signalWords(-85), "Good (-85 dBm)");
    assert.equal(signalWords(-70), "Strong (-70 dBm)");
    assert.equal(signalWords(null, 80), "Strong (80%)");
    assert.equal(signalWords(-95, 30), "Weak (30%)");
    assert.equal(signalWords(null), "Unknown");
  });
  it("server splits the two shapes", () => {
    assert.deepEqual(splitSignal(62), { signalPercent: 62, signalDbm: null });
    assert.deepEqual(splitSignal(-97), { signalPercent: null, signalDbm: -97 });
    assert.deepEqual(splitSignal(-97, 40), { signalPercent: 40, signalDbm: -97 });
    assert.deepEqual(splitSignal(null), { signalPercent: null, signalDbm: null });
  });
});

describe("what a cab reports", () => {
  it("position reporting comes from the latest heartbeat's location method", () => {
    assert.equal(positionReportingFrom(null), "unknown");
    assert.equal(positionReportingFrom({ locationMethod: "gps" }), "gps");
    assert.equal(positionReportingFrom({ locationMethod: "cell_tower" }), "cell");
    assert.equal(positionReportingFrom({ locationMethod: "network_manager" }), "none");
    assert.equal(positionReportingFrom({ locationMethod: null }), "none");
  });
  it("journey wording: the trigger decides once known, else evidence", () => {
    assert.equal(reportsJourneysFor(null, false), false);
    assert.equal(reportsJourneysFor(null, true), true);
    assert.equal(reportsJourneysFor("gpio", false), true);
    assert.equal(reportsJourneysFor("keyboard", false), true);
    assert.equal(reportsJourneysFor("always", true), false);
  });
  it("player statuses, including the new ones", () => {
    assert.equal(normalizePlayerStatus("playing"), "journey");
    assert.equal(normalizePlayerStatus("fallback"), "fallback");
    assert.equal(normalizePlayerStatus("error"), "error");
    assert.equal(normalizePlayerStatus("weird"), "unknown");
    assert.equal(BUILT_IN_LOOP_ID, "fallback");
  });
  it("passenger wording only for cabs that play for journeys", () => {
    assert.equal(passengerLine({ status: "online", playerStatus: "idle", reportsJourneys: false }), "Showing a still from the video");
    assert.equal(passengerLine({ status: "online", playerStatus: "idle", reportsJourneys: true }), "Waiting for a passenger (showing a still)");
    assert.equal(passengerLine({ status: "online", playerStatus: "journey", reportsJourneys: true }), "Passenger on board");
    assert.equal(passengerLine({ status: "online", playerStatus: "journey", reportsJourneys: false }), "Playing the video");
    assert.equal(passengerLine({ status: "online", playerStatus: "fallback", reportsJourneys: false }), "Showing its built-in video");
    assert.equal(passengerLine({ status: "offline", playerStatus: "idle", reportsJourneys: true }), null);
  });
});

describe("who a change really changes", () => {
  it("does not count a cab already playing the chosen video", () => {
    const only = cab({ id: "rodrigo", playing: A, expected: A, isUpToDate: true, status: "offline" });
    const impact = impactOf(overview([only]), { type: "fleet" }, A);
    assert.equal(impact.cabs.length, 1);
    assert.equal(impact.changing.length, 0);
    assert.equal(impact.alreadyPlaying.length, 1);
    assert.equal(changesWords(impact, "No cabs yet"), "Already playing it");
    const other = impactOf(overview([only]), { type: "fleet" }, B);
    assert.equal(other.changing.length, 1);
    assert.equal(changesWords(other, "No cabs yet"), "Changes 1 cab");
  });
  it("a cab still showing the chosen video while set to switch away stays put; one already heading to it does not change", () => {
    const stays = cab({ id: "1", playing: A, expected: B });
    const heading = cab({ id: "2", playing: B, expected: A });
    const changes = cab({ id: "3", playing: B, expected: B });
    const impact = impactOf(overview([stays, heading, changes], [], "B"), { type: "fleet" }, A);
    assert.deepEqual(impact.changing.map((item) => item.id), ["3"]);
    assert.deepEqual(impact.alreadyPlaying.map((item) => item.id), ["1"]);
    assert.deepEqual(impact.alreadyHeading.map((item) => item.id), ["2"]);
  });
  it("an empty group reads as such", () => {
    const groups = [{ id: "tcr", name: "TCR", cabCount: 0, onlineCount: 0, followsFleet: true, loop: A }];
    const impact = impactOf(overview([cab({ id: "x" })], groups), { type: "group", groupId: "tcr" }, B);
    assert.equal(impact.cabs.length, 0);
    assert.equal(changesWords(impact, "No cabs in this group yet"), "No cabs in this group yet");
  });
});

describe("where a video is set", () => {
  it("a group with no cabs is set, not live", () => {
    assert.deepEqual(placeWords({ fleet: false, groups: [{ name: "TCR" }], cabCount: 0 }), {
      text: "Set for TCR · no cabs in that group yet",
      live: false,
    });
    assert.deepEqual(placeWords({ fleet: true, groups: [], cabCount: 0 }), { text: "Set for all cabs · no cab follows it right now", live: false });
    assert.deepEqual(placeWords({ fleet: true, groups: [], cabCount: 1 }), { text: "Playing on all cabs · 1 cab", live: true });
    assert.equal(placeWords({ fleet: false, groups: [], cabCount: 0 }), null);
  });
});

describe("checking a change that got no answer", () => {
  it("reads the state back", () => {
    const groups = [{ id: "tcr", name: "TCR", cabCount: 0, onlineCount: 0, followsFleet: false, loop: B }];
    const data = overview([cab({ id: "c", expectedSource: "cab", expected: B })], groups, "A");
    assert.equal(changeIsInPlace(data, { type: "fleet" }, "A"), true);
    assert.equal(changeIsInPlace(data, { type: "fleet" }, "B"), false);
    assert.equal(changeIsInPlace(data, { type: "group", groupId: "tcr" }, "B"), true);
    assert.equal(changeIsInPlace(data, { type: "group", groupId: "tcr" }, null), false);
    assert.equal(changeIsInPlace(data, { type: "cab", deviceId: "c" }, "B"), true);
    assert.equal(changeIsInPlace(data, { type: "cab", deviceId: "c" }, null), false);
  });
});

/** A fetch that never answers but stops when aborted, like a browser's. */
function hangingFetch() {
  return ((_: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
}

describe("bounded requests", () => {
  it("a read that never answers fails with timedOut", async () => {
    globalThis.fetch = hangingFetch();
    await assert.rejects(api("/api/m/overview", { timeoutMs: 30 }), (error: unknown) => {
      assert.ok(error instanceof ApiFailure);
      assert.equal(error.timedOut, true);
      assert.equal(error.uncertain, false);
      return true;
    });
  });
  it("a change that never answers is reported as uncertain, not failed", async () => {
    globalThis.fetch = hangingFetch();
    await assert.rejects(api("/api/m/assign", { method: "POST", json: {}, timeoutMs: 30 }), (error: unknown) => {
      assert.ok(error instanceof ApiFailure);
      assert.equal(error.uncertain, true);
      assert.match(error.message, /can’t tell whether/);
      return true;
    });
  });
  it("a gateway timeout on a change is uncertain too", async () => {
    globalThis.fetch = (async () => new Response("bad gateway", { status: 504 })) as typeof fetch;
    await assert.rejects(api("/api/m/assign", { method: "POST", json: {} }), (error: unknown) => error instanceof ApiFailure && error.uncertain);
  });
  it("retry backoff starts soon and is capped", () => {
    assert.equal(retryDelay(1), 3000);
    assert.equal(retryDelay(2), 6000);
    assert.equal(retryDelay(10), 30_000);
  });
  it("a forced refresh is never overwritten by an older answer", async () => {
    const pending: Array<(value: Response) => void> = [];
    globalThis.fetch = (() => new Promise<Response>((resolve) => pending.push(resolve))) as typeof fetch;
    const key = "/api/m/test-forced";
    const first = fetchResource(key);
    const second = fetchResource(key, { force: true });
    assert.equal(pending.length, 2, "the forced refresh started its own request");
    pending[1](new Response(JSON.stringify({ v: "after the change" }), { status: 200 }));
    await second;
    pending[0](new Response(JSON.stringify({ v: "before the change" }), { status: 200 }));
    await first;
    assert.deepEqual(readResource(key)?.data, { v: "after the change" });
  });
});

describe("upload helpers", () => {
  it("Safari has no navigator.connection: unknown, not mobile data", () => {
    assert.equal(connectionKind({}), "unknown");
    assert.equal(connectionKind(undefined), "unknown");
    assert.equal(connectionKind({ connection: { type: "wifi" } }), "wifi");
    assert.equal(connectionKind({ connection: { type: "cellular" } }), "cellular");
  });
  it("preparing time is honest about long videos", () => {
    assert.match(preparingWords(60_000), /minute or two/);
    assert.match(preparingWords(600_000), /5 minutes or more/);
    assert.match(preparingWords(null), /5 minutes or more/);
  });
});
