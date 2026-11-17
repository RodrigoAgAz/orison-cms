"use client";

// Pause / delete / put-on-air requests with their confirmations, shared by the loops list and the
// pre-built loop page (the builder has its own copies wired into its state).

import type { ConfirmRequest } from "@/components/loop-ui";
import { readError } from "@/components/loop-ui";

type Notify = (input: { title: string; message: string; tone: "success" | "error" | "info" }) => void;

export async function requestPause(
  loop: { id: string; name: string },
  ask: (request: ConfirmRequest) => void,
  notify: Notify,
  done: () => void,
  token?: string,
): Promise<void> {
  const response = await fetch(`/api/loops/${loop.id}/pause`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: token ?? null }),
  });
  if (!response.ok) {
    notify({ title: "Not paused", message: await readError(response, "The loop could not be paused."), tone: "error" });
    return;
  }
  const body = (await response.json()) as { needsConfirmation?: boolean; message?: string; lines: string[]; token?: string };
  if (body.needsConfirmation) {
    ask({
      title: "Take this loop off air?",
      message: body.message ?? "",
      lines: body.lines,
      confirmLabel: "Pause it",
      danger: true,
      onConfirm: () => requestPause(loop, ask, notify, done, body.token),
    });
    return;
  }
  notify({ title: "Paused", message: `"${loop.name}" is off air.`, tone: "success" });
  done();
}

export function requestDelete(loop: { id: string; name: string }, ask: (request: ConfirmRequest) => void, notify: Notify, done: () => void) {
  ask({
    title: `Delete "${loop.name}"?`,
    message: "The loop, its compiled video and its files in storage are deleted for good. Files in the asset library are kept.",
    confirmLabel: "Delete loop",
    danger: true,
    onConfirm: async () => {
      const response = await fetch(`/api/loops/${loop.id}`, { method: "DELETE" });
      if (!response.ok) {
        notify({ title: "Not deleted", message: await readError(response, "The loop could not be deleted."), tone: "error" });
        return;
      }
      notify({ title: "Deleted", message: `"${loop.name}" was deleted.`, tone: "success" });
      done();
    },
  });
}
