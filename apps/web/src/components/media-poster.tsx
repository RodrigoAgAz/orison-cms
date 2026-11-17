"use client";

import { useState } from "react";

import clsx from "clsx";

type Props = {
  alt: string;
  src?: string | null;
  /**
   * A video to take a still from when there is no thumbnail (files uploaded before thumbnails
   * were reliable, very short clips) or the thumbnail does not load.
   */
  videoSrc?: string | null;
  className?: string;
  /** Shown only when there is nothing to show at all: it must describe the picture, not the slot. */
  label?: string;
};

export function MediaPoster({ alt, src, videoSrc, className, label }: Props) {
  const [imageFailed, setImageFailed] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const showImage = Boolean(src) && !imageFailed;
  const showVideo = !showImage && Boolean(videoSrc) && !videoFailed;
  return (
    <div className={clsx("media-poster", className)}>
      {showImage ? <img alt={alt} loading="lazy" onError={() => setImageFailed(true)} src={src!} /> : null}
      {showVideo ? (
        <video aria-label={alt} muted onError={() => setVideoFailed(true)} playsInline preload="metadata" src={`${videoSrc}#t=1`} />
      ) : null}
      <div className={clsx("media-poster-overlay", !showImage && !showVideo && "is-visible")}>
        <span>{label ?? "No preview"}</span>
      </div>
    </div>
  );
}
