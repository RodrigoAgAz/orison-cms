"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { TrashIcon } from "../components/icons";
import {
  ButtonLink,
  ErrorState,
  href,
  KeyValue,
  LoadingScreen,
  Notice,
  Screen,
  Section,
  Sheet,
  Spinner,
  TopBar,
} from "../components/ui";
import { VideoPlayer } from "../components/video-player";
import { api } from "../lib/api";
import { longDate, plural, quoted, videoLength } from "../lib/format";
import { invalidate, useResource } from "../lib/store";
import type { LoopSummary, Overview } from "../lib/types";

export function VideoScreen({ id }: { id: string }) {
  const router = useRouter();
  const loop = useResource<LoopSummary>(`/api/m/loops/${id}`, { refreshMs: 10_000 });
  const overview = useResource<Overview>("/api/m/overview", { refreshMs: 30_000 });
  const [removeOpen, setRemoveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = loop.data;

  const top = <TopBar title="Video" back={{ fallback: "/m/videos", label: "Videos" }} />;
  if (!data) {
    return (
      <Screen>
        {top}
        {loop.error ? <ErrorState message={loop.error.message} onRetry={() => void loop.refresh()} /> : <LoadingScreen label="Loading video" />}
      </Screen>
    );
  }

  const state = data.processing.state;
  const isLive = data.liveOn.fleet || data.liveOn.groups.length > 0 || data.liveOn.cabCount > 0;
  const ownCabs = (overview.data?.cabs ?? []).filter((cab) => cab.expectedSource === "cab" && cab.expected?.id === data.id);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/m/loops/${id}/archive`, { method: "POST" });
      await invalidate("/api/m/");
      setRemoveOpen(false);
      router.replace(href("/m/videos"));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That didn’t work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      {top}
      <div className="m-videohead">
        {state === "ready" ? (
          <VideoPlayer loopId={data.id} name={data.name} posterUrl={data.posterUrl} videoUrl={data.videoUrl} />
        ) : (
          <div className={`m-player m-player-${state}`}>
            <span className="m-poster m-poster-wide m-poster-busy">{state === "processing" ? <Spinner size={28} /> : null}</span>
          </div>
        )}
        <h2 className="m-videohead-title" data-testid="video-title">
          {data.name}
        </h2>
        <p className="m-muted">
          {[videoLength(data.durationMs), `added ${longDate(data.publishedAt ?? data.createdAt)}`].filter(Boolean).join(" · ")}
        </p>
      </div>

      {state === "processing" ? (
        <Notice tone="info" title={data.processing.waiting ? "Waiting its turn" : "Getting it ready for the screens"}>
          {data.processing.waiting
            ? "Videos are prepared one at a time and another one is being prepared first. This one starts as soon as that’s done; you can leave this screen."
            : "This usually takes a minute or two. You can leave this screen; it carries on without you."}
        </Notice>
      ) : null}
      {state === "failed" ? (
        <Notice tone="danger" title="This video couldn’t be used" testId="video-failed">
          {data.processing.error ?? "The video couldn’t be prepared."} You can remove it and try uploading it again.
        </Notice>
      ) : null}
      {state === "ready" && data.processing.error ? (
        <Notice tone="warn" title="Ready, but not put on screens">
          {data.processing.error}
        </Notice>
      ) : null}

      {state === "ready" ? (
        <Section title="Where it’s playing">
          <div className="m-card" data-testid="video-live">
            {isLive ? (
              <>
                <p className="m-bigline">
                  <span className="m-livedot" aria-hidden="true" /> Set to play on {plural(data.liveOn.cabCount, "cab")}
                </p>
                <KeyValue
                  items={[
                    ...(data.liveOn.fleet ? ([["All cabs", "Yes, the video for all cabs"]] as Array<[string, React.ReactNode]>) : []),
                    ...data.liveOn.groups.map((group) => [`${group.name} group`, "Chosen for this group"] as [string, React.ReactNode]),
                    ...(ownCabs.length
                      ? ([
                          [
                            "Single cabs",
                            ownCabs.map((cab, index) => (
                              <span key={cab.id}>
                                {index > 0 ? ", " : ""}
                                <Link href={href(`/m/cabs/${cab.id}`)} className="m-link">
                                  {cab.label}
                                </Link>
                              </span>
                            )),
                          ],
                        ] as Array<[string, React.ReactNode]>)
                      : []),
                  ]}
                />
              </>
            ) : (
              <p className="m-body-text">Not playing on any cab. It&rsquo;s in the library, ready to use.</p>
            )}
            <ButtonLink to={`/m/change?loop=${data.id}`} variant="primary" className="m-btn-block" testId="put-on-screens">
              Put on screens
            </ButtonLink>
          </div>
        </Section>
      ) : null}

      {state !== "processing" ? (
        <Section>
          <button
            type="button"
            className="m-btn m-btn-danger-ghost m-btn-block"
            onClick={() => {
              setError(null);
              setRemoveOpen(true);
            }}
            data-testid="remove-video"
          >
            <TrashIcon size={18} /> Remove from library
          </button>
        </Section>
      ) : null}

      <Sheet
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        title={isLive ? "This video is playing" : `Remove ${quoted(data.name)}?`}
        testId="remove-sheet"
        footer={
          isLive ? (
            <button type="button" className="m-btn m-btn-primary" onClick={() => setRemoveOpen(false)}>
              OK
            </button>
          ) : (
            <>
              <button type="button" className="m-btn m-btn-ghost" onClick={() => setRemoveOpen(false)} disabled={busy}>
                Keep it
              </button>
              <button type="button" className="m-btn m-btn-danger" onClick={() => void remove()} disabled={busy} data-testid="remove-confirm">
                {busy ? <Spinner /> : null} Remove
              </button>
            </>
          )
        }
      >
        {isLive ? (
          <p className="m-body-text">
            {quoted(data.name)} is set to play on {plural(data.liveOn.cabCount, "cab")}. Put a different video on those cabs first, then you
            can remove this one.
          </p>
        ) : (
          <p className="m-body-text">It will disappear from this list. No cab is playing it, so nothing on the screens changes.</p>
        )}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </Sheet>
    </Screen>
  );
}
