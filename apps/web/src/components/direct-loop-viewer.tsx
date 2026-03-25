"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { StatusPill } from "@/components/status-pill";
import { useToast } from "@/components/toast-provider";

type Props = {
  loop: {
    id: string;
    name: string;
    status: string;
    compiledVideoUrl: string | null;
    manifestUrl: string | null;
    publishedAt: string | null;
    updatedAt: string;
  };
};

export function DirectLoopViewer({ loop }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [status, setStatus] = useState(loop.status);
  const [processing, setProcessing] = useState<"archive" | "delete" | null>(null);

  async function archiveLoop() {
    const confirmed = window.confirm(`Pause published loop "${loop.name}"?`);
    if (!confirmed) {
      return;
    }

    setProcessing("archive");

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
        throw new Error(body?.error ?? "Unable to pause loop");
      }

      setStatus("ARCHIVED");
      toast({
        title: "Loop paused",
        message: `${loop.name} was archived and is no longer active.`,
        tone: "success",
      });
      router.refresh();
    } catch (error) {
      toast({
        title: "Pause failed",
        message: error instanceof Error ? error.message : "Unable to pause loop",
        tone: "error",
      });
    } finally {
      setProcessing(null);
    }
  }

  async function deleteLoop() {
    const confirmed = window.confirm(`Delete loop "${loop.name}"?`);
    if (!confirmed) {
      return;
    }

    setProcessing("delete");

    try {
      const response = await fetch(`/api/loops/${loop.id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Unable to delete loop");
      }

      toast({
        title: "Loop deleted",
        message: `${loop.name} was removed.`,
        tone: "success",
      });
      router.push("/loops");
      router.refresh();
    } catch (error) {
      toast({
        title: "Delete failed",
        message: error instanceof Error ? error.message : "Unable to delete loop",
        tone: "error",
      });
    } finally {
      setProcessing(null);
    }
  }

  return (
    <div className="stack-lg">
      <div className="card stack">
        <div className="loop-builder-header">
          <div className="stack-sm">
            <span className="eyebrow">Direct Loop Upload</span>
            <div className="loop-title-row">
              <h1 className="direct-loop-title">{loop.name}</h1>
              <StatusPill value={status} />
            </div>
            <p className="muted direct-loop-copy">
              This programme was published from a single pre-built MP4. Slot programming and slot-level
              validation are bypassed for this loop.
            </p>
          </div>
          <div className="button-row">
            <Link className="button button-secondary" href="/loops">
              Back to loops
            </Link>
            {status === "PUBLISHED" ? (
              <button
                className="button button-secondary"
                disabled={processing !== null}
                onClick={() => void archiveLoop()}
                type="button"
              >
                {processing === "archive" ? "Pausing..." : "Pause"}
              </button>
            ) : null}
            {status !== "PUBLISHED" ? (
              <button
                className="button button-danger"
                disabled={processing !== null}
                onClick={() => void deleteLoop()}
                type="button"
              >
                {processing === "delete" ? "Deleting..." : "Delete"}
              </button>
            ) : null}
            {loop.compiledVideoUrl ? (
              <a
                className="button button-primary"
                href={loop.compiledVideoUrl}
                rel="noreferrer"
                target="_blank"
              >
                Open Video File
              </a>
            ) : null}
          </div>
        </div>
      </div>

      <div className="card stack direct-loop-viewer-card">
        <div className="card-header">
          <div>
            <span className="eyebrow">Published Output</span>
            <h2>Master Loop Preview</h2>
          </div>
        </div>

        {loop.compiledVideoUrl ? (
          <div className="direct-loop-frame">
            <video controls src={loop.compiledVideoUrl} />
          </div>
        ) : (
          <div className="empty-state compact">
            <strong>No compiled video available</strong>
            <p>The published loop file could not be resolved.</p>
          </div>
        )}

        <div className="meta-grid">
          <span>Published</span>
          <span>{loop.publishedAt ? new Date(loop.publishedAt).toLocaleString() : "Not recorded"}</span>
          <span>Last updated</span>
          <span>{new Date(loop.updatedAt).toLocaleString()}</span>
          <span>Manifest</span>
          <span>{loop.manifestUrl ? "Generated and available to devices" : "Unavailable"}</span>
          <span>Mode</span>
          <span>Direct upload</span>
        </div>
      </div>
    </div>
  );
}
