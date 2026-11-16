"use client";

import { clockTime, duration } from "../lib/format";

/** Last 24 hours as a bar: filled where the screen was on. Times in London time. */
export function Timeline24({ intervals, now = Date.now() }: { intervals: { start: string; end: string }[]; now?: number }) {
  const windowMs = 24 * 3600_000;
  const from = now - windowMs;
  const blocks = intervals
    .map((interval) => ({
      start: Math.max(from, new Date(interval.start).getTime()),
      end: Math.min(now, new Date(interval.end).getTime()),
    }))
    .filter((block) => block.end > block.start);
  const onSeconds = blocks.reduce((total, block) => total + (block.end - block.start) / 1000, 0);
  const ticks = [0, 6, 12, 18, 24].map((hoursAgo) => now - hoursAgo * 3600_000).reverse();

  const description =
    blocks.length === 0
      ? "Not on at all in the last 24 hours."
      : `On for ${duration(onSeconds)} in the last 24 hours: ${blocks
          .map((block) => `${clockTime(block.start)} to ${now - block.end < 60_000 * 15 ? "now" : clockTime(block.end)}`)
          .join(", ")}.`;

  return (
    <figure className="m-timeline" data-testid="timeline">
      <div className="m-timeline-track" role="img" aria-label={description}>
        {blocks.map((block) => (
          <span
            key={block.start}
            className="m-timeline-on"
            style={{ left: `${((block.start - from) / windowMs) * 100}%`, width: `${Math.max(0.6, ((block.end - block.start) / windowMs) * 100)}%` }}
          />
        ))}
      </div>
      <div className="m-timeline-ticks" aria-hidden="true">
        {ticks.map((tick, index) => (
          <span key={tick} style={{ left: `${(index / (ticks.length - 1)) * 100}%` }}>
            {index === ticks.length - 1 ? "Now" : clockTime(tick)}
          </span>
        ))}
      </div>
      <figcaption className="m-timeline-legend">
        <span>
          <i className="m-key m-key-on" /> On
        </span>
        <span>
          <i className="m-key m-key-off" /> Off
        </span>
        <span className="m-timeline-total">{blocks.length ? `${duration(onSeconds)} on in 24 hours` : "Off all day"}</span>
      </figcaption>
    </figure>
  );
}
