import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loopProcessing } from "../src/lib/mobile";
import { STALE_PUBLISHING_MESSAGE, STALE_PUBLISHING_MS, STALE_TARGET_STEP_MESSAGE } from "../src/lib/upload-rules";

const now = new Date(Date.UTC(2026, 10, 15, 12, 0));
const ago = (ms: number) => new Date(now.getTime() - ms);
const row = (overrides: Record<string, unknown>) =>
  ({ id: "l1", status: "PUBLISHING", publishError: null, updatedAt: ago(1000), pendingTargetAt: null, ...overrides }) as Parameters<
    typeof loopProcessing
  >[0];

describe("loopProcessing", () => {
  it("queued behind another upload: processing and waiting", () => {
    const state = loopProcessing(row({}), now, { state: "waiting", ahead: 1 });
    assert.deepEqual(state, { state: "processing", error: null, waiting: true, queuedBehind: 1 });
  });

  it("a slow job that is still alive is not declared failed", () => {
    // Even if the row was not touched for a while, a job this process is running is alive.
    const state = loopProcessing(row({ updatedAt: ago(STALE_PUBLISHING_MS * 3) }), now, { state: "running", ahead: 0 });
    assert.equal(state.state, "processing");
  });

  it("no liveness for too long and no job: failed", () => {
    const state = loopProcessing(row({ updatedAt: ago(STALE_PUBLISHING_MS + 1000) }), now);
    assert.deepEqual(state, { state: "failed", error: STALE_PUBLISHING_MESSAGE, waiting: false, queuedBehind: 0 });
  });

  it("published but its target not yet applied: still processing (no premature 'on its way')", () => {
    const state = loopProcessing(row({ status: "PUBLISHED", pendingTargetAt: ago(5000) }), now, { state: "running", ahead: 0 });
    assert.equal(state.state, "processing");
  });

  it("published, target step abandoned: ready with a note", () => {
    const state = loopProcessing(row({ status: "PUBLISHED", pendingTargetAt: ago(5000), updatedAt: ago(STALE_PUBLISHING_MS + 1) }), now);
    assert.deepEqual(state, { state: "ready", error: STALE_TARGET_STEP_MESSAGE, waiting: false, queuedBehind: 0 });
  });

  it("published with a skipped-target note: ready with that note", () => {
    const state = loopProcessing(row({ status: "PUBLISHED", publishError: "It wasn't put on all cabs, because ..." }), now);
    assert.equal(state.state, "ready");
    assert.match(state.error ?? "", /wasn't put on/);
  });
});
