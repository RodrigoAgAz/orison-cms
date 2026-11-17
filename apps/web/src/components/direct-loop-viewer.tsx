"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { requestDelete, requestPause } from "@/components/loop-actions-client";
import { ConfirmDialog, LoopStatusBadge, formatDuration, formatWhen, readError, type ConfirmRequest, type LoopStateView } from "@/components/loop-ui";
import { useToast } from "@/components/toast-provider";

type Props = {
  loop: {
    id: string;
    name: string;
    videoUrl: string | null;
    manifestUrl: string | null;
    durationMs: number | null;
    targetGroupId: string | null;
  };
  state: LoopStateView;
  deviceGroups: Array<{ id: string; name: string }>;
};

/** A pre-built loop: one uploaded video, no slots. */
export function DirectLoopViewer({ loop, state, deviceGroups }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const phone = state.kind === "phone";

  async function changeTarget(nextId: string, token?: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/loops/${loop.id}/target`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetGroupId: nextId || null, token: token ?? null }),
      });
      if (!response.ok) throw new Error(await readError(response, "The target could not be changed."));
      const body = (await response.json()) as { needsConfirmation?: boolean; message?: string; lines: string[]; token?: string };
      if (body.needsConfirmation) {
        setConfirm({
          title: "Change where this loop plays?",
          message: body.message ?? "",
          lines: body.lines.length ? body.lines : ["No cab plays anything different right now."],
          confirmLabel: "Move it now",
          onConfirm: () => changeTarget(nextId, body.token),
        });
        return;
      }
      toast({ title: "Where it plays changed", message: "Saved.", tone: "success" });
      router.refresh();
    } catch (error) {
      toast({ title: "Not changed", message: error instanceof Error ? error.message : "", tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  function putOnAir() {
    setConfirm({
      title: `Put "${loop.name}" on air?`,
      message: `It starts playing on ${state.targetLabel.toLowerCase()} straight away (its video is ready, nothing needs compiling).`,
      confirmLabel: "Put on air",
      onConfirm: async () => {
        const response = await fetch(`/api/loops/${loop.id}/publish`, { method: "POST" });
        if (!response.ok) {
          toast({ title: "Not on air", message: await readError(response, "It could not be put on air."), tone: "error" });
          return;
        }
        toast({ title: "On air", message: `"${loop.name}" is on air.`, tone: "success" });
        router.refresh();
      },
    });
  }

  return (
    <div className="lb">
      <header className="lb-head card">
        <div className="lb-head-main">
          <Link className="lb-back" href="/loops">
            ← Loops
          </Link>
          <div className="lb-title-row">
            <h1 className="lb-name-static">{loop.name}</h1>
            <LoopStatusBadge state={state} />
          </div>
          <dl className="lb-facts">
            <div>
              <dt>On air</dt>
              <dd>{state.live ? state.liveLabel : "No"}</dd>
            </div>
            <div>
              <dt>Plays on</dt>
              <dd>
                {phone ? (
                  "Chosen in the phone app"
                ) : (
                  <select aria-label="Plays on" disabled={busy} onChange={(event) => void changeTarget(event.target.value)} value={loop.targetGroupId ?? ""}>
                    <option value="">All cabs</option>
                    {deviceGroups.map((group) => (
                      <option key={group.id} value={group.id}>
                        Group {group.name}
                      </option>
                    ))}
                  </select>
                )}
              </dd>
            </div>
            <div>
              <dt>Length</dt>
              <dd>{formatDuration(loop.durationMs)}</dd>
            </div>
            <div>
              <dt>Published</dt>
              <dd>{formatWhen(state.publishedAt)}</dd>
            </div>
          </dl>
          <p className="muted">
            {phone
              ? "Uploaded from the phone app as one finished video. Where it plays is chosen in the phone app."
              : "Uploaded as one finished video: it has no slots, so the cab plays it from start to end."}
          </p>
        </div>
        <div className="lb-actions">
          <div className="button-row">
            {state.status === "PUBLISHED" ? (
              <button className="button button-secondary" disabled={busy} onClick={() => void requestPause(loop, setConfirm, toast, () => router.refresh())} type="button">
                Pause
              </button>
            ) : (
              <>
                {!phone ? (
                  <button className="button button-primary" disabled={busy} onClick={putOnAir} type="button">
                    Put on air
                  </button>
                ) : null}
                <button className="button button-danger" disabled={busy} onClick={() => requestDelete(loop, setConfirm, toast, () => router.push("/loops"))} type="button">
                  Delete
                </button>
              </>
            )}
          </div>
        </div>
      </header>
      {state.publishError ? <div className="alert alert-warning">{state.publishError}</div> : null}

      <section className="card stack">
        {loop.videoUrl ? (
          <div className="direct-loop-frame">
            <video controls preload="metadata" src={loop.videoUrl} />
          </div>
        ) : null}
      </section>

      {confirm ? <ConfirmDialog onClose={() => setConfirm(null)} request={confirm} /> : null}
    </div>
  );
}
