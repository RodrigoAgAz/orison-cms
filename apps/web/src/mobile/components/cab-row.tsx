"use client";

import Link from "next/link";

import { duration, when } from "../lib/format";
import { contentLine, isSwitchedOn, passengerLine } from "../lib/status";
import type { CabSummary } from "../lib/types";
import { ChevronIcon } from "./icons";
import { href, Poster, StatusBadge } from "./ui";

export function runningLine(cab: CabSummary, now = new Date()) {
  if (isSwitchedOn(cab)) {
    if (cab.onlineSince) return `On for ${duration((now.getTime() - new Date(cab.onlineSince).getTime()) / 1000)}`;
    return "On now";
  }
  if (cab.status === "paused") {
    return cab.lastSeenAt ? `Screen paused · last on ${when(cab.lastSeenAt, now)}` : "Screen paused";
  }
  if (!cab.lastSeenAt) return "Hasn’t been switched on yet";
  return `Off · last on ${when(cab.lastSeenAt, now)}`;
}

export function CabRow({ cab }: { cab: CabSummary }) {
  const shownLoop = cab.isUpToDate || !cab.expected ? cab.playing : cab.expected;
  const passenger = passengerLine(cab);
  const pending = !cab.isUpToDate && Boolean(cab.expected);
  return (
    <li>
      <Link href={href(`/m/cabs/${cab.id}`)} className="m-cabrow" data-testid="cab-row" data-cab-id={cab.id} data-status={cab.status}>
        <div className="m-cabrow-top">
          <span className="m-cabrow-plate">{cab.label}</span>
          <StatusBadge cab={cab} />
        </div>
        <div className="m-cabrow-meta">
          {[cab.driverName, cab.group?.name].filter(Boolean).join(" · ") || "No group"}
        </div>
        <div className="m-cabrow-playing">
          <Poster src={shownLoop?.posterUrl} alt="" ratio="thumb" />
          <span className={pending ? "m-cabrow-loop is-pending" : "m-cabrow-loop"}>{contentLine(cab)}</span>
        </div>
        <div className="m-cabrow-foot">
          <span>{runningLine(cab)}</span>
          {passenger ? <span>{passenger}</span> : null}
        </div>
        <ChevronIcon size={18} className="m-cabrow-chev" />
      </Link>
    </li>
  );
}
