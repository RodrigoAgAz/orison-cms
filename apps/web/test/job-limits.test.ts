import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createKeyedJobs, createLimiter } from "../src/lib/job-limits";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("createLimiter", () => {
  it("never runs more than `concurrency` tasks at once and starts them in order", async () => {
    const limiter = createLimiter(2);
    const gates = Array.from({ length: 5 }, () => deferred());
    const started: number[] = [];
    let running = 0;
    let peak = 0;
    const all = gates.map((gate, index) =>
      limiter.run(async () => {
        started.push(index);
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
        return index;
      }),
    );
    await tick();
    assert.deepEqual(started, [0, 1]);
    assert.equal(limiter.active, 2);
    assert.equal(limiter.waiting, 3);
    gates[1].resolve();
    await tick();
    await tick();
    assert.deepEqual(started, [0, 1, 2]);
    for (const gate of gates) gate.resolve();
    assert.deepEqual(await Promise.all(all), [0, 1, 2, 3, 4]);
    assert.equal(peak, 2);
    assert.equal(limiter.active, 0);
  });

  it("frees the slot when a task fails", async () => {
    const limiter = createLimiter(1);
    await assert.rejects(limiter.run(async () => Promise.reject(new Error("boom"))), /boom/);
    assert.equal(await limiter.run(async () => "next"), "next");
  });

  it("rejects a bad concurrency", () => {
    assert.throws(() => createLimiter(0));
  });
});

describe("createKeyedJobs (poster jobs)", () => {
  it("runs one job per key: concurrent requests for the same loop share it", async () => {
    const jobs = createKeyedJobs<string>(createLimiter(2));
    const gate = deferred();
    let calls = 0;
    const task = async () => {
      calls += 1;
      await gate.promise;
      return "poster-key";
    };
    const requests = Array.from({ length: 10 }, () => jobs.run("loop-1", task));
    await tick();
    assert.equal(calls, 1);
    assert.equal(jobs.size, 1);
    gate.resolve();
    assert.deepEqual(new Set(await Promise.all(requests)), new Set(["poster-key"]));
    assert.equal(jobs.has("loop-1"), false, "forgotten once settled");
    // A later request (e.g. after a republish) runs again.
    await jobs.run("loop-1", task);
    assert.equal(calls, 2);
  });

  it("caps different loops at the global limit (a fresh deploy asking for every poster)", async () => {
    const jobs = createKeyedJobs<number>(createLimiter(2));
    const gates = new Map<string, ReturnType<typeof deferred>>();
    let running = 0;
    let peak = 0;
    const requests = Array.from({ length: 12 }, (_, index) => {
      const key = `loop-${index % 6}`; // 6 loops, each requested twice
      if (!gates.has(key)) gates.set(key, deferred());
      return jobs.run(key, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gates.get(key)!.promise;
        running -= 1;
        return index % 6;
      });
    });
    await tick();
    assert.equal(jobs.size, 6);
    assert.equal(running, 2);
    for (const gate of gates.values()) gate.resolve(undefined);
    const values = await Promise.all(requests);
    assert.deepEqual(values, [0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5]);
    assert.equal(peak, 2);
  });

  it("a failed job is not cached", async () => {
    const jobs = createKeyedJobs<string>(createLimiter(1));
    await assert.rejects(jobs.run("x", async () => Promise.reject(new Error("ffmpeg failed"))));
    assert.equal(await jobs.run("x", async () => "ok"), "ok");
  });
});
