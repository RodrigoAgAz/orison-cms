"use client";

// Small pieces shared by the loops list, the loop builder and the pre-built loop page.

import { useCallback, useEffect, useRef, useState } from "react";

import { Modal } from "@/components/modal";

export type LiveOn = { fleet: boolean; groups: Array<{ id: string; name: string }>; cabCount: number };

export type LoopStateView = {
  id: string;
  name: string;
  status: string;
  kind: "builder" | "prebuilt" | "phone";
  updatedAt: string;
  publishedAt: string | null;
  version: number;
  durationMs: number | null;
  hasVideo: boolean;
  publishError: string | null;
  targetGroupId: string | null;
  targetLabel: string;
  readySlots: number;
  slotCount: number;
  liveOn: LiveOn;
  live: boolean;
  liveLabel: string;
  publish: { kind: "idle" | "running" | "interrupted"; label: string | null; fraction: number; startedAt: string | null };
  unpublishedChanges: boolean;
  /** Compiled before this release: plays exactly as it did until it is published again. */
  publishedBeforeUpdate: boolean;
};

export const PUBLISHED_BEFORE_UPDATE_NOTE =
  "Published before this update: cabs keep playing it exactly as it was. Publishing it again applies the exact slot timings, the new sound handling and the smaller file.";

export function statusOf(state: Pick<LoopStateView, "status" | "live" | "publish" | "kind">) {
  if (state.publish.kind === "running") return { label: "Publishing", tone: "busy" as const };
  if (state.status === "PUBLISHED") return state.live ? { label: "On air", tone: "live" as const } : { label: "Published, not playing", tone: "quiet" as const };
  if (state.status === "ARCHIVED") return { label: "Paused", tone: "quiet" as const };
  if (state.status === "PUBLISHING") return { label: "Processing", tone: "busy" as const };
  return { label: "Draft", tone: "draft" as const };
}

export function LoopStatusBadge({ state }: { state: Pick<LoopStateView, "status" | "live" | "publish" | "kind"> }) {
  const status = statusOf(state);
  return (
    <span className={`lx-badge lx-badge-${status.tone}`}>
      {status.tone === "live" ? <span className="lx-live-dot" aria-hidden /> : null}
      {status.label}
    </span>
  );
}

export function formatDuration(ms: number | null | undefined) {
  if (!ms && ms !== 0) return "—";
  const seconds = ms / 1000;
  if (seconds < 60) return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

export function formatClock(ms: number) {
  const total = Math.max(0, Math.round(ms / 100) / 10);
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds.toFixed(seconds % 1 ? 1 : 0)}`;
}

export function formatWhen(iso: string | null) {
  if (!iso) return "never";
  const date = new Date(iso);
  return date.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function elapsed(since: string | null) {
  if (!since) return "";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export function PublishProgress({ state, compact = false }: { state: Pick<LoopStateView, "publish" | "live">; compact?: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const percent = Math.round(state.publish.fraction * 100);
  return (
    <div className={`lx-progress ${compact ? "is-compact" : ""}`} role="status" aria-live="polite">
      <div className="lx-progress-top">
        <strong>{state.publish.label ?? "Starting"}</strong>
        <span>
          {percent}% · {elapsed(state.publish.startedAt)}
        </span>
      </div>
      <div className="lx-progress-track">
        <div className="lx-progress-fill" style={{ width: `${Math.max(percent, 3)}%` }} />
      </div>
      {!compact ? (
        <p className="muted">
          {state.live
            ? "The current version stays on air until the new one is ready, then cabs switch to it."
            : "It goes on air when it is ready. You can leave this page; publishing carries on."}
        </p>
      ) : null}
    </div>
  );
}

/** Poll a loop's state; faster while it is publishing. */
export function useLoopState(loopId: string, initial: LoopStateView, onSettled?: (state: LoopStateView) => void) {
  const [state, setState] = useState(initial);
  const settled = useRef(onSettled);
  settled.current = onSettled;
  useEffect(() => setState(initial), [initial]);
  useEffect(() => {
    if (state.publish.kind !== "running") return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/loops/${loopId}/publish`, { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as { state: LoopStateView };
        if (cancelled) return;
        setState(body.state);
        if (body.state.publish.kind !== "running") settled.current?.(body.state);
      } catch {
        // keep polling
      }
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loopId, state.publish.kind]);
  return [state, setState] as const;
}

export type ConfirmRequest = {
  title: string;
  message: string;
  lines?: string[];
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
};

export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal className="lx-confirm" eyebrow="Please confirm" onClose={() => !busy && onClose()} title={request.title}>
      <div className="stack">
        <p>{request.message}</p>
        {request.lines && request.lines.length ? (
          <ul className="lx-effect-list">
            {request.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        <div className="button-row lx-confirm-actions">
          <button className="button button-secondary" disabled={busy} onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className={`button ${request.danger ? "button-danger" : "button-primary"}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await request.onConfirm();
              } finally {
                setBusy(false);
                onClose();
              }
            }}
            type="button"
          >
            {busy ? "Working…" : request.confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export async function readError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error && body.error !== "Internal server error" ? body.error : fallback;
}

/**
 * Warn before leaving with unsaved changes: closing or reloading the tab, clicking a link inside
 * the app, and the browser's back button.
 */
export function useLeaveGuard(dirty: boolean, message = "You have unsaved changes in this loop. Leave without saving them?") {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = message;
    }
    function onClick(event: MouseEvent) {
      if (!dirtyRef.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank") return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || (url.pathname === window.location.pathname && url.search === window.location.search)) return;
      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopPropagation();
      } else {
        dirtyRef.current = false;
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [message]);

  // Back button: while there are unsaved changes keep an extra history entry, and ask on popstate.
  const guarded = useRef(false);
  useEffect(() => {
    if (dirty && !guarded.current) {
      window.history.pushState({ orisonLeaveGuard: true }, "", window.location.href);
      guarded.current = true;
    }
  }, [dirty]);
  useEffect(() => {
    function onPopState() {
      if (!guarded.current) return;
      if (dirtyRef.current && !window.confirm(message)) {
        window.history.pushState({ orisonLeaveGuard: true }, "", window.location.href);
        return;
      }
      guarded.current = false;
      dirtyRef.current = false;
      window.history.back();
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [message]);

  /** Call after saving: drops the extra history entry so Back works normally again. */
  return useCallback(() => {
    dirtyRef.current = false;
  }, []);
}
