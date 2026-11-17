"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { requestDelete, requestPause } from "@/components/loop-actions-client";
import { ConfirmDialog, LoopStatusBadge, PublishProgress, formatWhen, readError, type ConfirmRequest, type LoopStateView } from "@/components/loop-ui";
import { PaginationControls } from "@/components/pagination-controls";
import { useToast } from "@/components/toast-provider";

type Props = {
  loops: LoopStateView[];
  page: number;
  pageSize: number;
  total: number;
};

const kindLabels: Record<LoopStateView["kind"], string> = {
  builder: "Built in slots",
  prebuilt: "Pre-built video",
  phone: "Phone upload",
};

function shortLiveOn(liveOn: LoopStateView["liveOn"]) {
  const where = liveOn.fleet ? ["All cabs"] : liveOn.groups.map((group) => group.name);
  const cabs = `${liveOn.cabCount} cab${liveOn.cabCount === 1 ? "" : "s"}`;
  return where.length ? `${where.join(", ")} · ${cabs}` : cabs;
}

export function LoopsTable({ loops: initial, page, pageSize, total }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [loops, setLoops] = useState(initial);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  useEffect(() => setLoops(initial), [initial]);

  // Live progress and outcome of publishes shown on this page.
  const runningIds = loops.filter((loop) => loop.publish.kind === "running").map((loop) => loop.id).join(",");
  useEffect(() => {
    if (!runningIds) return;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/loops/state?ids=${runningIds}`, { cache: "no-store" }).catch(() => null);
      if (!response?.ok) return;
      const body = (await response.json()) as { items: LoopStateView[] };
      const byId = new Map(body.items.map((item) => [item.id, item]));
      setLoops((current) => current.map((loop) => byId.get(loop.id) ?? loop));
      for (const item of body.items) {
        if (item.publish.kind !== "running") {
          toast(
            item.publishError
              ? { title: "Publish failed", message: `${item.name}: ${item.publishError}`, tone: "error" }
              : { title: "Published", message: `"${item.name}" is published${item.live ? ` and on air for ${item.liveLabel}` : ""}.`, tone: "success" },
          );
        }
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [runningIds, toast]);

  // Uploaded videos being converted (desktop pre-built loops and phone uploads): refresh until done.
  const convertingIds = loops.filter((loop) => loop.status === "PUBLISHING" && !loop.publishError && loop.publish.kind !== "running").map((loop) => loop.id).join(",");
  useEffect(() => {
    if (!convertingIds) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [convertingIds, router]);

  async function duplicate(loop: LoopStateView) {
    setBusyId(loop.id);
    try {
      const response = await fetch(`/api/loops/${loop.id}/duplicate`, { method: "POST" });
      if (!response.ok) throw new Error(await readError(response, "The loop could not be duplicated."));
      const copy = (await response.json()) as { id: string; name: string };
      toast({ title: "Duplicated", message: `Opened "${copy.name}".`, tone: "success" });
      router.push(`/loops/${copy.id}`);
    } catch (error) {
      toast({ title: "Not duplicated", message: error instanceof Error ? error.message : "", tone: "error" });
    } finally {
      setBusyId(null);
    }
  }

  if (loops.length === 0) {
    return (
      <div className="empty-state">
        <strong>No loops yet</strong>
        <p>Create a loop above, or upload a pre-built one.</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="table-wrap">
        <table className="data-table ll-table">
          <thead>
            <tr>
              <th>Loop</th>
              <th>Status</th>
              <th>On air for</th>
              <th>Plays on</th>
              <th>Last published</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loops.map((loop) => (
              <tr key={loop.id}>
                <td>
                  <Link className="ll-name" href={`/loops/${loop.id}`}>
                    {loop.name}
                  </Link>
                  <span className="ll-kind">
                    {kindLabels[loop.kind]}
                    {loop.kind === "builder" ? ` · ${loop.readySlots} of ${loop.slotCount} slots ready` : ""}
                  </span>
                </td>
                <td>
                  <div className="ll-status">
                    <LoopStatusBadge state={loop} />
                    {loop.unpublishedChanges ? <span className="lx-badge lx-badge-warn">Changes not yet published</span> : null}
                    {loop.publish.kind === "running" ? <PublishProgress compact state={loop} /> : null}
                    {loop.publish.kind !== "running" && loop.publishError ? (
                      <span className="ll-error" title={loop.publishError}>
                        {loop.status === "PUBLISHED" ? "Note" : "Failed"}: {loop.publishError}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className={loop.live ? "ll-live" : "muted"}>{loop.live ? shortLiveOn(loop.liveOn) : "Not on air"}</td>
                <td>{loop.kind === "phone" ? <span className="muted">Phone app</span> : loop.targetLabel}</td>
                <td>{formatWhen(loop.publishedAt)}</td>
                <td>
                  <div className="button-row table-actions">
                    {loop.kind === "builder" ? (
                      <button className="button button-secondary" disabled={busyId === loop.id} onClick={() => void duplicate(loop)} type="button">
                        Duplicate
                      </button>
                    ) : null}
                    {loop.status === "PUBLISHED" ? (
                      <button
                        className="button button-secondary"
                        disabled={busyId === loop.id || loop.publish.kind === "running"}
                        onClick={() => void requestPause(loop, setConfirm, toast, () => router.refresh())}
                        type="button"
                      >
                        Pause
                      </button>
                    ) : (
                      <button
                        className="button button-danger"
                        disabled={busyId === loop.id || loop.publish.kind === "running" || (loop.status === "PUBLISHING" && !loop.publishError)}
                        onClick={() => requestDelete(loop, setConfirm, toast, () => router.refresh())}
                        type="button"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PaginationControls page={page} pageSize={pageSize} pathname="/loops" total={total} />
      {confirm ? <ConfirmDialog onClose={() => setConfirm(null)} request={confirm} /> : null}
    </div>
  );
}
