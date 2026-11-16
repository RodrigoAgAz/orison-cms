"use client";

import { useState } from "react";

import { api } from "../lib/api";
import type { LoopSummary } from "../lib/types";
import { PlayIcon } from "./icons";
import { Poster, Spinner } from "./ui";

/** A still with a play button; tapping it plays the video inline (fetching its URL if needed). */
export function VideoPlayer({
  loopId,
  name,
  posterUrl,
  videoUrl,
  testId = "video-player",
}: {
  loopId: string;
  name: string;
  posterUrl: string | null;
  videoUrl?: string | null;
  testId?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "playing" | "error">("idle");

  async function play() {
    setState("loading");
    try {
      const url = videoUrl ?? (await api<LoopSummary>(`/api/m/loops/${loopId}`)).videoUrl;
      if (!url) {
        setState("error");
        return;
      }
      setSrc(url);
      setState("playing");
    } catch {
      setState("error");
    }
  }

  if (state === "playing" && src) {
    return (
      <div className="m-player" data-testid={testId}>
        <video
          src={src}
          poster={posterUrl ?? undefined}
          controls
          autoPlay
          playsInline
          preload="metadata"
          aria-label={`Video: ${name}`}
          onError={() => setState("error")}
        />
      </div>
    );
  }

  return (
    <div className="m-player" data-testid={testId}>
      <Poster src={posterUrl} alt={`Still from ${name}`} ratio="wide" />
      <button type="button" className="m-player-play" onClick={() => void play()} aria-label={`Watch ${name}`}>
        <span className="m-player-btn">{state === "loading" ? <Spinner size={22} /> : <PlayIcon size={26} />}</span>
        <span className="m-player-hint">{state === "error" ? "Couldn’t play this video. Tap to try again." : "Watch"}</span>
      </button>
    </div>
  );
}
