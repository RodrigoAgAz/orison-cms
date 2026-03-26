"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { PaginationControls } from "@/components/pagination-controls";
import { StatusPill } from "@/components/status-pill";
import { useToast } from "@/components/toast-provider";

type LoopRow = {
  id: string;
  name: string;
  status: string;
  updatedAt: string;
  completeSlots: number;
  targetGroupName: string;
  isDirectUpload: boolean;
};

type Props = {
  loops: LoopRow[];
  page: number;
  pageSize: number;
  total: number;
};

export function LoopsTable({ loops, page, pageSize, total }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [processingLoopId, setProcessingLoopId] = useState<string | null>(null);

  async function handlePause(loop: LoopRow) {
    const confirmed = window.confirm(`Pause published loop "${loop.name}"?`);
    if (!confirmed) {
      return;
    }

    setProcessingLoopId(loop.id);

    try {
      const response = await fetch(`/api/loops/${loop.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "ARCHIVED" }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Unable to pause the loop.");
      }

      toast({
        title: "Loop paused",
        message: `${loop.name} was archived and is no longer active.`,
        tone: "success",
      });
      router.refresh();
    } catch (error) {
      toast({
        title: "Pause failed",
        message: error instanceof Error ? error.message : "Unable to pause the loop.",
        tone: "error",
      });
    } finally {
      setProcessingLoopId(null);
    }
  }

  async function handleDelete(loop: LoopRow) {
    const confirmed = window.confirm(`Delete loop "${loop.name}"?`);
    if (!confirmed) {
      return;
    }

    setProcessingLoopId(loop.id);

    try {
      const response = await fetch(`/api/loops/${loop.id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Unable to delete the loop.");
      }

      toast({
        title: "Loop deleted",
        message: `${loop.name} was removed.`,
        tone: "success",
      });
      router.refresh();
    } catch (error) {
      toast({
        title: "Delete failed",
        message: error instanceof Error ? error.message : "Unable to delete the loop.",
        tone: "error",
      });
    } finally {
      setProcessingLoopId(null);
    }
  }

  if (loops.length === 0) {
    return (
      <div className="empty-state">
        <strong>No loops created yet</strong>
        <p>Create a new slot-based loop above, or use Upload Pre-built Loop for a quick publish.</p>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Audience</th>
              <th>Updated</th>
              <th>Slot Coverage</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loops.map((loop) => (
              <tr key={loop.id}>
                <td>{loop.name}</td>
                <td>
                  <StatusPill value={loop.status} />
                </td>
                <td>{loop.targetGroupName}</td>
                <td>{new Date(loop.updatedAt).toLocaleString()}</td>
                <td>
                  {loop.isDirectUpload ? (
                    <div className="stack-sm">
                      <strong>Direct upload</strong>
                      <span className="muted loop-table-subtext">Published from one pre-built MP4</span>
                    </div>
                  ) : (
                    `${loop.completeSlots}/10 complete`
                  )}
                </td>
                <td>
                  <div className="button-row table-actions">
                    <Link className="button button-secondary" href={`/loops/${loop.id}`}>
                      {loop.isDirectUpload ? "View" : "Open"}
                    </Link>
                    {loop.status === "PUBLISHED" ? (
                      <button
                        className="button button-secondary"
                        disabled={processingLoopId === loop.id}
                        onClick={() => void handlePause(loop)}
                        type="button"
                      >
                        {processingLoopId === loop.id ? (
                          <span className="button-inline">
                            <span aria-hidden className="button-spinner" />
                            Working
                          </span>
                        ) : (
                          "Pause"
                        )}
                      </button>
                    ) : null}
                    {loop.status !== "PUBLISHED" && loop.status !== "PUBLISHING" ? (
                      <button
                        className="button button-danger"
                        disabled={processingLoopId === loop.id}
                        onClick={() => void handleDelete(loop)}
                        type="button"
                      >
                        {processingLoopId === loop.id ? (
                          <span className="button-inline">
                            <span aria-hidden className="button-spinner" />
                            Deleting
                          </span>
                        ) : (
                          "Delete"
                        )}
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PaginationControls page={page} pageSize={pageSize} pathname="/loops" total={total} />
    </div>
  );
}
