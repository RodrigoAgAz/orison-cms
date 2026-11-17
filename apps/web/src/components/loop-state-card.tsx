"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { requestDelete } from "@/components/loop-actions-client";
import { ConfirmDialog, LoopStatusBadge, formatWhen, type ConfirmRequest, type LoopStateView } from "@/components/loop-ui";
import { useToast } from "@/components/toast-provider";

/** A loop with no slots and no video: a phone upload still processing or failed, or similar. */
export function LoopStateCard({ state }: { state: LoopStateView }) {
  const router = useRouter();
  const { toast } = useToast();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const processing = state.status === "PUBLISHING" && !state.publishError;
  return (
    <div className="card stack lb-empty-loop">
      <Link className="lb-back" href="/loops">
        ← Loops
      </Link>
      <div className="lb-title-row">
        <h1>{state.name}</h1>
        <LoopStatusBadge state={state} />
      </div>
      <p className="muted">
        {state.kind === "phone" ? "Uploaded from the phone app" : "Pre-built loop"} · last changed {formatWhen(state.updatedAt)}
      </p>
      {processing ? (
        <div className="alert alert-warning">This video is still being processed. This page shows it once it is ready.</div>
      ) : (
        <div className="alert alert-danger">
          <strong>There is no video for this loop.</strong> {state.publishError ?? "Its upload did not finish."}
        </div>
      )}
      <div className="button-row">
        <button className="button button-secondary" onClick={() => router.refresh()} type="button">
          Check again
        </button>
        <button
          className="button button-danger"
          disabled={processing}
          onClick={() => requestDelete(state, setConfirm, toast, () => router.push("/loops"))}
          type="button"
        >
          Delete
        </button>
      </div>
      {confirm ? <ConfirmDialog onClose={() => setConfirm(null)} request={confirm} /> : null}
    </div>
  );
}
