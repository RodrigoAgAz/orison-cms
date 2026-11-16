"use client";

// A tiny stale-while-revalidate cache for the mobile app. Every screen reads through
// useResource(url): it shows the last good data immediately, refreshes on an interval while the
// app is visible, refreshes when the app comes back to the foreground or the network returns,
// and keeps the last good data (with a quiet notice) when a refresh fails.

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { api, ApiFailure } from "./api";

type Entry = {
  data?: unknown;
  error?: ApiFailure;
  updatedAt?: number;
  stale?: boolean;
  inflight?: Promise<void>;
};

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const connectionListeners = new Set<() => void>();
let connection = { offline: false, since: 0 };

function emit(key: string) {
  listeners.get(key)?.forEach((listener) => listener());
}

function setConnection(offline: boolean) {
  if (connection.offline === offline) return;
  connection = { offline, since: Date.now() };
  connectionListeners.forEach((listener) => listener());
}

export function fetchResource(key: string): Promise<void> {
  const entry = entries.get(key) ?? {};
  if (entry.inflight) return entry.inflight;
  const inflight = api<unknown>(key)
    .then((data) => {
      entries.set(key, { data, updatedAt: Date.now() });
      setConnection(false);
    })
    .catch((error: unknown) => {
      const failure = error instanceof ApiFailure ? error : new ApiFailure("Something went wrong.", 0);
      if (failure.network) setConnection(true);
      const previous = entries.get(key) ?? {};
      entries.set(key, { ...previous, inflight: undefined, error: failure });
    })
    .finally(() => emit(key));
  entries.set(key, { ...entry, inflight });
  emit(key);
  return inflight;
}

/** Refetch every resource whose key starts with one of the prefixes (others are marked stale). */
export function invalidate(...prefixes: string[]) {
  const jobs: Promise<void>[] = [];
  for (const [key, entry] of entries) {
    if (!prefixes.some((prefix) => key.startsWith(prefix))) continue;
    if ((listeners.get(key)?.size ?? 0) > 0) {
      jobs.push(fetchResource(key));
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

export function useResource<T>(key: string | null, options: { refreshMs?: number } = {}): Resource<T> {
  const refreshMs = options.refreshMs ?? 30_000;
  const entry = useSyncExternalStore(
    useCallback((listener: () => void) => (key ? subscribe(key, listener) : () => undefined), [key]),
    () => (key ? entries.get(key) ?? emptyEntry : emptyEntry),
    () => emptyEntry,
  );

  useEffect(() => {
    if (!key) return;
    const current = entries.get(key);
    if (!current?.updatedAt || current.stale || Date.now() - current.updatedAt > Math.min(refreshMs, 10_000)) {
      void fetchResource(key);
    }
    if (refreshMs <= 0) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void fetchResource(key);
    }, refreshMs);
    return () => window.clearInterval(timer);
  }, [key, refreshMs]);

  const refresh = useCallback(() => (key ? fetchResource(key) : Promise.resolve()), [key]);

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

export function clearAll() {
  entries.clear();
}
