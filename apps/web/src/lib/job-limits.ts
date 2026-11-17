// Small in-process concurrency helpers for heavy background work (ffmpeg). Pure: no I/O, so the
// rules can be unit-tested. State that must be shared by every route in the process lives on
// globalThis (see `processSingleton`), because Next can load a module more than once.

export type Limiter = {
  /** Run `task` once fewer than `concurrency` tasks are running; tasks start in FIFO order. */
  run<T>(task: () => Promise<T>): Promise<T>;
  readonly active: number;
  readonly waiting: number;
};

export function createLimiter(concurrency: number): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= concurrency) return;
    const start = queue.shift();
    if (start) {
      active += 1;
      start();
    }
  };

  return {
    run<T>(task: () => Promise<T>) {
      return new Promise<T>((resolve, reject) => {
        queue.push(() => {
          Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              next();
            });
        });
        next();
      });
    },
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
  };
}

export type KeyedJobs<T> = {
  /**
   * One in-flight job per key: a second call for a key that is already queued or running gets the
   * same promise instead of starting another job. Jobs run through the shared limiter.
   */
  run(key: string, task: () => Promise<T>): Promise<T>;
  has(key: string): boolean;
  readonly size: number;
};

export function createKeyedJobs<T>(limiter: Limiter): KeyedJobs<T> {
  const inFlight = new Map<string, Promise<T>>();
  return {
    run(key, task) {
      const existing = inFlight.get(key);
      if (existing) return existing;
      const promise = limiter.run(task).finally(() => {
        if (inFlight.get(key) === promise) inFlight.delete(key);
      });
      inFlight.set(key, promise);
      return promise;
    },
    has(key) {
      return inFlight.has(key);
    },
    get size() {
      return inFlight.size;
    },
  };
}

/** A value created once per Node process, shared by every bundle that imports this helper. */
export function processSingleton<T>(name: string, create: () => T): T {
  const store = globalThis as unknown as Record<symbol, T | undefined>;
  const key = Symbol.for(`orison.${name}`);
  store[key] ??= create();
  return store[key]!;
}

/**
 * The one limiter for heavy media work in this process (ffmpeg): phone loop uploads
 * (upload-queue.ts), desktop asset processing and desktop loop publishes all run through it, one
 * at a time, so compiles never run on top of each other.
 */
export function mediaJobLimiter(): Limiter {
  return processSingleton("media-job-limiter", () => createLimiter(1));
}
