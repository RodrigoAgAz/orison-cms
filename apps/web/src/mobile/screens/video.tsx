"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ChevronIcon, TrashIcon } from "../components/icons";
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
import { api, ApiFailure } from "../lib/api";
import { longDate, preparingWords, quoted, videoLength } from "../lib/format";
import { cabCount, encodeTarget, placeWords } from "../lib/status";
import { invalidate, useResource } from "../lib/store";
import type { AssignTarget, LoopSummary, Overview } from "../lib/types";

type Place = { key: string; label: string; detail: string; to: string; emptyGroup?: { id: string; name: string } };

export function VideoScreen({ id }: { id: string }) {
  const router = useRouter();
  // Poll while it is being prepared; a finished video rarely changes (where it plays does, slowly).
  const [preparing, setPreparing] = useState(true);
  const loop = useResource<LoopSummary>(`/api/m/loops/${id}`, { refreshMs: preparing ? 10_000 : 120_000 });
  const overview = useResource<Overview>("/api/m/overview", { refreshMs: 30_000 });
  const [removeOpen, setRemoveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = loop.data;
  const loadedState = data?.processing.state;
  useEffect(() => {
    if (loadedState) setPreparing(loadedState === "processing");
  }, [loadedState]);

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
  const place = placeWords(data.liveOn);
  const groupsById = new Map((overview.data?.groups ?? []).map((group) => [group.id, group]));
  const ownCabs = (overview.data?.cabs ?? []).filter((cab) => cab.expectedSource === "cab" && cab.expected?.id === data.id);

  // Every place that keeps this video in use, each with a way to change it.
  const places: Place[] = [
    ...(data.liveOn.fleet
      ? [{ key: "fleet", label: "All cabs", detail: "The video for all cabs", to: "/m/change?target=fleet" }]
      : []),
    ...data.liveOn.groups.map((group) => {
      const count = groupsById.get(group.id)?.cabCount;
      return {
        key: `g-${group.id}`,
        label: `${group.name} group`,
        detail: count === 0 ? "Chosen for this group, which has no cabs yet" : `Chosen for this group${count ? ` (${cabCount(count)})` : ""}`,
        to: `/m/change?target=${encodeTarget({ type: "group", groupId: group.id })}`,
        emptyGroup: count === 0 ? group : undefined,
      };
    }),
    ...ownCabs.map((cab) => ({
      key: `c-${cab.id}`,
      label: cab.label,
      detail: "Its own video",
      to: `/m/change?target=${encodeTarget({ type: "cab", deviceId: cab.id })}`,
    })),
  ];
  // Only groups with no cabs keep it: the phone can free it without changing any screen.
  const onlyEmptyGroups = isLive && !data.liveOn.fleet && data.liveOn.cabCount === 0 && places.length > 0 && places.every((item) => item.emptyGroup);

  async function archive() {
    try {
      await api(`/api/m/loops/${id}/archive`, { method: "POST" });
      return "done" as const;
    } catch (failure) {
      if (failure instanceof ApiFailure && failure.uncertain) {
        // The server may have removed it. Ask.
        const after = await api<LoopSummary>(`/api/m/loops/${id}`).catch((check) => (check instanceof ApiFailure && check.status === 404 ? null : undefined));
        if (after === null || after?.status === "ARCHIVED") return "done" as const;
        if (after) throw new Error("It wasn’t removed (the server didn’t answer in time). Please try again.");
        throw new Error("We didn’t hear back, so we can’t tell whether it was removed. Look in Videos in a minute: if it’s gone, it worked.");
      }
      throw failure;
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await archive();
      await invalidate("/api/m/");
      setRemoveOpen(false);
      router.replace(href("/m/videos"));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That didn’t work.");
    } finally {
      setBusy(false);
    }
  }

  async function freeAndRemove() {
    setBusy(true);
    setError(null);
    try {
      for (const item of places) {
        if (!item.emptyGroup) continue;
        const target: AssignTarget = { type: "group", groupId: item.emptyGroup.id };
        try {
          await api("/api/m/assign", { method: "POST", json: { loopId: null, target } });
        } catch (failure) {
          // An unanswered change is checked by the removal itself: it refuses while the group still has it.
          if (!(failure instanceof ApiFailure && failure.uncertain)) throw failure;
        }
      }
      await archive();
      await invalidate("/api/m/");
      setRemoveOpen(false);
      router.replace(href("/m/videos"));
    } catch (failure) {
      await invalidate("/api/m/");
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
            : `${preparingWords(data.durationMs)} You can leave this screen; it carries on without you.`}
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
            {isLive && place ? (
              <>
                <p className="m-bigline" data-testid="video-place-line">
                  <span className={place.live ? "m-livedot" : "m-setdot"} aria-hidden="true" />{" "}
                  {place.live ? `On ${cabCount(data.liveOn.cabCount)}` : "Not on any screen yet"}
                </p>
                <KeyValue
                  items={places.map((item) => [
                    item.label,
                    ownCabs.some((cab) => `c-${cab.id}` === item.key) ? (
                      <Link key={item.key} href={href(`/m/cabs/${item.key.slice(2)}`)} className="m-link">
                        {item.detail}
                      </Link>
                    ) : (
                      item.detail
                    ),
                  ])}
                />
              </>
            ) : (
              <p className="m-body-text" data-testid="video-not-chosen">
                {data.liveOn.onScreens
                  ? `Not chosen for any cab, but ${data.liveOn.onScreens === 1 ? "1 cab still shows it" : `${data.liveOn.onScreens} cabs still show it`} until ${data.liveOn.onScreens === 1 ? "it switches" : "they switch"} to its new video.`
                  : "Not playing on any cab. It’s in the library, ready to use."}
              </p>
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
        title={isLive ? (place?.live ? "This video is playing" : "This video is still chosen") : `Remove ${quoted(data.name)}?`}
        testId="remove-sheet"
        footer={
          isLive ? (
            onlyEmptyGroups ? (
              <>
                <button type="button" className="m-btn m-btn-ghost" onClick={() => setRemoveOpen(false)} disabled={busy}>
                  Keep it
                </button>
                <button type="button" className="m-btn m-btn-danger" onClick={() => void freeAndRemove()} disabled={busy} data-testid="remove-free-confirm">
                  {busy ? <Spinner /> : null} Remove
                </button>
              </>
            ) : (
              <button type="button" className="m-btn m-btn-primary" onClick={() => setRemoveOpen(false)}>
                OK
              </button>
            )
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
          onlyEmptyGroups ? (
            <p className="m-body-text" data-testid="remove-explain">
              {quoted(data.name)} is chosen for {places.map((item) => item.emptyGroup!.name).join(" and ")}, which{" "}
              {places.length === 1 ? "has" : "have"} no cabs yet, so no screen shows it. Removing it sets{" "}
              {places.length === 1 ? "that group" : "those groups"} back to the video for all cabs. No screen changes.
            </p>
          ) : (
            <>
              <p className="m-body-text" data-testid="remove-explain">
                {quoted(data.name)} is still chosen for the places below. Put a different video on each first, then you can remove this one.
              </p>
              <ul className="m-list m-card" data-testid="remove-places">
                {places.map((item) => (
                  <li key={item.key}>
                    <Link href={href(item.to)} className="m-listrow" onClick={() => setRemoveOpen(false)}>
                      <span className="m-listrow-text">
                        <strong>{item.label}</strong>
                        <span className="m-muted">{item.detail}</span>
                      </span>
                      <span className="m-listrow-action">Change</span>
                      <ChevronIcon size={18} className="m-listrow-chev" />
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )
        ) : (
          <p className="m-body-text">
            {data.liveOn.onScreens
              ? "It will disappear from this list. No cab is set to play it; a cab that still shows it keeps it until it switches to its new video."
              : "It will disappear from this list. No cab is playing it, so nothing on the screens changes."}
          </p>
        )}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </Sheet>
    </Screen>
  );
}
