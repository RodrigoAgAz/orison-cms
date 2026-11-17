"use client";

// A tiny stale-while-revalidate cache for the mobile app. Every screen reads through
// useResource(url): it shows the last good data immediately, refreshes on an interval while the
// app is visible, refreshes when the app comes back to the foreground or the network returns,
// and keeps the last good data (with a quiet notice) when a refresh fails.
//
// Requests are bounded (lib/api.ts), so an in-flight request always settles. A refresh that
// fails for want of an answer is retried soon by itself (with backoff) rather than waiting for
// the next interval. A forced refresh (after a change, or the refresh button) never reuses a
// request that started earlier: it starts a new one and the older answer is ignored, so data
// from before a change can never overwrite data from after it.

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { api, ApiFailure } from "./api";

type Entry = {
  data?: unknown;
  error?: ApiFailure;
  updatedAt?: number;
  stale?: boolean;
  inflight?: Promise<void>;
  /** Generation of the latest request started for this key; answers from older ones are dropped. */
  gen?: number;
  /** Consecutive failed attempts (for the retry backoff). */
  failures?: number;
};

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const retryTimers = new Map<string, number>();
const connectionListeners = new Set<() => void>();
let connection = { offline: false, since: 0 };

/** First retry after a failed refresh, doubled each time, capped. */
export const RETRY_FIRST_MS = 3_000;
export const RETRY_MAX_MS = 30_000;

export function retryDelay(failures: number) {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.max(0, failures - 1));
}

function emit(key: string) {
  listeners.get(key)?.forEach((listener) => listener());
}

function setConnection(offline: boolean) {
  if (connection.offline === offline) return;
  connection = { offline, since: Date.now() };
  connectionListeners.forEach((listener) => listener());
}

function hasListeners(key: string) {
  return (listeners.get(key)?.size ?? 0) > 0;
}

function clearRetry(key: string) {
  const timer = retryTimers.get(key);
  if (timer !== undefined) {
    clearTimeout(timer);
    retryTimers.delete(key);
  }
}

function scheduleRetry(key: string, failures: number) {
  clearRetry(key);
  if (!hasListeners(key)) return;
  const timer = setTimeout(() => {
    retryTimers.delete(key);
    if (!hasListeners(key)) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return; // foregrounding refreshes
    void fetchResource(key);
  }, retryDelay(failures)) as unknown as number;
  retryTimers.set(key, timer);
}

/**
 * Fetch `key` into the cache. Without `force`, a request already in flight is shared. With
 * `force`, a new request starts and any older one's answer is ignored.
 */
export function fetchResource(key: string, options: { force?: boolean } = {}): Promise<void> {
  const entry = entries.get(key) ?? {};
  if (entry.inflight && !options.force) return entry.inflight;
  clearRetry(key);
  const gen = (entry.gen ?? 0) + 1;
  const isCurrent = () => entries.get(key)?.gen === gen;
  const inflight = api<unknown>(key)
    .then((data) => {
      if (!isCurrent()) return;
      entries.set(key, { data, updatedAt: Date.now(), gen });
      setConnection(false);
    })
    .catch((error: unknown) => {
      if (!isCurrent()) return;
      const failure = error instanceof ApiFailure ? error : new ApiFailure("Something went wrong.", 0);
      if (failure.network && !failure.timedOut) setConnection(true);
      const previous = entries.get(key) ?? {};
      const failures = (previous.failures ?? 0) + 1;
      entries.set(key, { ...previous, inflight: undefined, error: failure, failures });
      // No answer or a server hiccup: try again soon by itself. A 4xx answer will not change.
      if (failure.status === 0 || failure.status >= 500) scheduleRetry(key, failures);
    })
    .finally(() => {
      if (isCurrent()) emit(key);
    });
  entries.set(key, { ...entry, inflight, gen });
  emit(key);
  return inflight;
}

/** Refetch every resource whose key starts with one of the prefixes (others are marked stale). */
export function invalidate(...prefixes: string[]) {
  const jobs: Promise<void>[] = [];
  for (const [key, entry] of entries) {
    if (!prefixes.some((prefix) => key.startsWith(prefix))) continue;
    if (hasListeners(key)) {
      jobs.push(fetchResource(key, { force: true }));
    } else {
      entries.set(key, { ...entry, stale: true });
    }
  }
  return Promise.all(jobs);
}

function refreshAllVisible() {
  for (const [key, set] of listeners) {
    if (set.size > 0) void fetchResource(key);
  }
}

if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshAllVisible();
  });
  window.addEventListener("online", () => {
    refreshAllVisible();
  });
  window.addEventListener("offline", () => setConnection(true));
  window.addEventListener("pageshow", (event) => {
    if ((event as PageTransitionEvent).persisted) refreshAllVisible();
  });
}

function subscribe(key: string, listener: () => void) {
  const set = listeners.get(key) ?? new Set();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) clearRetry(key);
  };
}

const emptyEntry: Entry = {};

export type Resource<T> = {
  data: T | undefined;
  /** Set when the latest attempt failed. `data` still holds the last good value, if any. */
  error: ApiFailure | undefined;
  updatedAt: number | undefined;
  loading: boolean;
  refresh: () => Promise<void>;
};

/**
 * `refreshMs` > 0 polls while the app is visible. `passive` only reads what other screens have
 * loaded (it never fetches by itself), for small things like the tab bar.
 */
export function useResource<T>(key: string | null, options: { refreshMs?: number; passive?: boolean } = {}): Resource<T> {
  const refreshMs = options.refreshMs ?? 30_000;
  const passive = options.passive ?? false;
  const entry = useSyncExternalStore(
    useCallback((listener: () => void) => (key ? subscribe(key, listener) : () => undefined), [key]),
    () => (key ? entries.get(key) ?? emptyEntry : emptyEntry),
    () => emptyEntry,
  );

  useEffect(() => {
    if (!key || passive) return;
    const current = entries.get(key);
    if (!current?.updatedAt || current.stale || Date.now() - current.updatedAt > Math.min(refreshMs, 10_000)) {
      void fetchResource(key);
    }
    if (refreshMs <= 0) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void fetchResource(key);
    }, refreshMs);
    return () => window.clearInterval(timer);
  }, [key, refreshMs, passive]);

  // The refresh button: always a fresh request, even if an older one is still going.
  const refresh = useCallback(() => (key ? fetchResource(key, { force: true }) : Promise.resolve()), [key]);

  return {
    data: entry.data as T | undefined,
    error: entry.error,
    updatedAt: entry.updatedAt,
    loading: Boolean(entry.inflight),
    refresh,
  };
}

export function setResource<T>(key: string, update: (previous: T | undefined) => T) {
  const entry = entries.get(key) ?? {};
  entries.set(key, { ...entry, data: update(entry.data as T | undefined) });
  emit(key);
}

export function useConnection() {
  return useSyncExternalStore(
    (listener) => {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    () => connection,
    () => connection,
  );
}

/** When the oldest data on screen was loaded (resources with a screen showing them), or null. */
export function oldestVisibleUpdate(): number | null {
  let oldest: number | null = null;
  for (const [key, set] of listeners) {
    if (set.size === 0) continue;
    const updatedAt = entries.get(key)?.updatedAt;
    if (updatedAt && (oldest === null || updatedAt < oldest)) oldest = updatedAt;
  }
  return oldest;
}

export function clearAll() {
  entries.clear();
}
