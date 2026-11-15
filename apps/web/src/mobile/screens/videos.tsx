"use client";

import Link from "next/link";

import { AlertIcon, ChevronIcon, UploadIcon, VideosIcon } from "../components/icons";
import { ButtonLink, EmptyState, ErrorState, Freshness, href, LoadingScreen, Poster, Screen, Spinner, TopBar } from "../components/ui";
import { plural, videoLength, when } from "../lib/format";
import { useResource } from "../lib/store";
import type { LoopSummary } from "../lib/types";

export function liveWords(loop: LoopSummary) {
  const { fleet, groups, cabCount } = loop.liveOn;
  if (!fleet && groups.length === 0 && cabCount === 0) return null;
  const count = plural(cabCount, "cab");
  if (fleet) return `Playing on all cabs · ${count}`;
  if (groups.length) return `Playing in ${groups.map((group) => group.name).join(", ")} · ${count}`;
  return `Playing on ${count}`;
}

export function VideosScreen() {
  const loops = useResource<{ items: LoopSummary[] }>("/api/m/loops", { refreshMs: 15_000 });
  const items = loops.data?.items;

  return (
    <Screen>
      <TopBar
        title="Videos"
        large
        right={
          <ButtonLink to="/m/upload" variant="secondary" className="m-btn-small" testId="videos-upload">
            <UploadIcon size={16} /> Upload
          </ButtonLink>
        }
        subtitle={<Freshness updatedAt={loops.updatedAt} loading={loops.loading} onRefresh={() => void loops.refresh()} />}
      />
      {!items ? (
        loops.error ? (
          <ErrorState message={loops.error.message} onRetry={() => void loops.refresh()} />
        ) : (
          <LoadingScreen label="Loading videos" />
        )
      ) : items.length === 0 ? (
        <EmptyState
          icon={<VideosIcon size={28} />}
          title="No videos yet"
          action={
            <ButtonLink to="/m/upload" variant="primary">
              Upload a video
            </ButtonLink>
          }
        >
          Upload a video from your phone and it will appear here, ready to put on the screens.
        </EmptyState>
      ) : (
        <ul className="m-videolist" data-testid="video-list">
          {items.map((loop) => (
            <li key={loop.id}>
              <VideoRow loop={loop} />
            </li>
          ))}
        </ul>
      )}
    </Screen>
  );
}

function VideoRow({ loop }: { loop: LoopSummary }) {
  const live = liveWords(loop);
  const state = loop.processing.state;
  return (
    <Link href={href(`/m/videos/${loop.id}`)} className={`m-videorow is-${state}`} data-testid="video-row" data-loop-id={loop.id} data-state={state}>
      <span className="m-videorow-still">
        {state === "processing" ? (
          <span className="m-poster m-poster-wide m-poster-busy">
            <Spinner size={22} />
          </span>
        ) : state === "failed" ? (
          <span className="m-poster m-poster-wide m-poster-failed">
            <AlertIcon size={24} />
          </span>
        ) : (
          <Poster src={loop.posterUrl} alt="" ratio="wide" />
        )}
        {state === "ready" && loop.durationMs ? <span className="m-videorow-len">{videoLength(loop.durationMs)}</span> : null}
      </span>
      <span className="m-videorow-text">
        <strong>{loop.name}</strong>
        {state === "processing" ? (
          <span className="m-videorow-status is-busy">Getting it ready for the screens…</span>
        ) : state === "failed" ? (
          <span className="m-videorow-status is-failed" data-testid="video-failed-reason">
            Couldn&rsquo;t be used: {loop.processing.error ?? "the video couldn’t be prepared."}
          </span>
        ) : live ? (
          <span className="m-videorow-status is-live">
            <span className="m-livedot" aria-hidden="true" /> {live}
          </span>
        ) : (
          <span className="m-videorow-status">Not playing anywhere</span>
        )}
        <span className="m-muted m-videorow-date">Added {when(loop.publishedAt ?? loop.createdAt)}</span>
      </span>
      <ChevronIcon size={18} className="m-listrow-chev" />
    </Link>
  );
}
