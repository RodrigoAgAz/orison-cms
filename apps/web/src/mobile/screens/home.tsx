"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { CabRow } from "../components/cab-row";
import { AlertIcon, BrandMark, CabsIcon, ChevronIcon, InfoIcon } from "../components/icons";
import { InstallHint } from "../components/install-hint";
import {
  ButtonLink,
  ConnectionNotice,
  EmptyState,
  ErrorState,
  Freshness,
  href,
  LoadingScreen,
  Notice,
  Poster,
  Screen,
  Section,
  StatusShape,
} from "../components/ui";
import { plural, quoted, videoLength, when } from "../lib/format";
import { cabCount, isSwitchedOn, lagPhrase, updateFailureText } from "../lib/status";
import { useResource } from "../lib/store";
import type { LoopSummary, Overview } from "../lib/types";

type Filter = "all" | "on" | "off" | "paused";

export function HomeScreen() {
  const overview = useResource<Overview>("/api/m/overview", { refreshMs: 20_000 });
  const loops = useResource<{ items: LoopSummary[] }>("/api/m/loops", { refreshMs: 60_000 });
  const [filter, setFilter] = useState<Filter>("all");
  const data = overview.data;

  const lists = useMemo(() => {
    const cabs = data?.cabs ?? [];
    return {
      all: cabs,
      on: cabs.filter(isSwitchedOn),
      off: cabs.filter((cab) => cab.status === "offline"),
      paused: cabs.filter((cab) => cab.status === "paused"),
    };
  }, [data]);

  const header = (
    <header className="m-topbar m-home-head">
      <div className="m-topbar-row">
        <div className="m-home-brand">
          <BrandMark size={34} />
          <span>Orison</span>
        </div>
        <Freshness updatedAt={overview.updatedAt} loading={overview.loading} onRefresh={() => void overview.refresh()} />
      </div>
      <ConnectionNotice />
    </header>
  );

  if (!data) {
    return (
      <Screen>
        {header}
        {overview.error ? (
          <ErrorState message={overview.error.message} onRetry={() => void overview.refresh()} />
        ) : (
          <LoadingScreen label="Loading your cabs" />
        )}
      </Screen>
    );
  }

  const onCount = data.counts.online + data.counts.updating;
  const failedUploads = (loops.data?.items ?? []).filter((loop) => loop.processing.state === "failed");
  const preparing = (loops.data?.items ?? []).filter((loop) => loop.processing.state === "processing");
  const neverOn = data.cabs.filter((cab) => !cab.lastSeenAt && cab.status !== "paused");
  const longOff = data.cabs.filter(
    (cab) => cab.status === "offline" && cab.lastSeenAt && Date.now() - new Date(cab.lastSeenAt).getTime() > 48 * 3600_000,
  );
  const attention = [
    ...(data.fleetPaused
      ? [{ key: "fleet", tone: "danger" as const, to: "/m", title: "All screens are paused", text: "Every cab screen is paused from the desktop site." }]
      : []),
    // Only screens paused on their own (an all-screens pause is the single item above).
    ...lists.paused.filter((cab) => cab.cabPaused).map((cab) => ({
      key: `p-${cab.id}`,
      tone: "warn" as const,
      to: `/m/cabs/${cab.id}`,
      title: `${cab.label}: screen paused`,
      text: cab.pausedReason ? `Reason: ${cab.pausedReason}` : "No videos play until it\u2019s resumed.",
    })),
    // Cabs that report their update keeps failing (firmware 1.2.0+), with the reason and the next try.
    ...data.cabs
      .filter((cab) => cab.sync?.state === "failing" && cab.status !== "inactive")
      .map((cab) => ({
        key: `u-${cab.id}`,
        tone: "warn" as const,
        to: `/m/cabs/${cab.id}`,
        title: `${cab.label}: update failing`,
        text: updateFailureText(cab),
      })),
    ...failedUploads.map((loop) => ({
      key: `f-${loop.id}`,
      tone: "warn" as const,
      to: `/m/videos/${loop.id}`,
      title: `${quoted(loop.name)} couldn’t be used`,
      text: loop.processing.error ?? "The video couldn’t be prepared.",
    })),
    ...longOff.map((cab) => ({
      key: `o-${cab.id}`,
      tone: "info" as const,
      to: `/m/cabs/${cab.id}`,
      title: `${cab.label} has been off for a while`,
      text: `Last on ${when(cab.lastSeenAt!)}.`,
    })),
    ...neverOn.map((cab) => ({
      key: `n-${cab.id}`,
      tone: "info" as const,
      to: `/m/cabs/${cab.id}`,
      title: `${cab.label} hasn’t been switched on yet`,
      text: "It will start playing as soon as it is.",
    })),
  ];

  const segments = [
    { key: "online", count: data.counts.online, tone: "on" as const },
    { key: "updating", count: data.counts.updating, tone: "switching" as const },
    { key: "offline", count: data.counts.offline, tone: "off" as const },
    { key: "paused", count: data.counts.paused, tone: "paused" as const },
  ];
  const shown = lists[filter];
  // Cabs reported as downloading or failing say so on their own badge.
  const switchingCabs = data.cabs.filter((cab) => cab.status === "updating" && (!cab.sync || cab.sync.state === "waiting"));

  return (
    <Screen>
      {header}
      <InstallHint />

      {/* With no cabs at all, the empty state under Cabs says so; a big "0" adds nothing. */}
      <section className="m-hero m-card" aria-label="Screens on now" data-testid="hero" hidden={data.counts.total === 0}>
        <div className="m-hero-figure">
          <span className="m-hero-num" data-testid="on-count">
            {onCount}
          </span>
          <span className="m-hero-of">
            of {plural(data.counts.total, "screen")}
            <br />
            on right now
          </span>
        </div>
        {data.counts.total > 0 ? (
          <div className="m-hero-bar" aria-hidden="true">
            {segments.map((segment) =>
              segment.count > 0 ? (
                <span key={segment.key} className={`m-seg m-seg-${segment.tone}`} style={{ flexGrow: segment.count }} />
              ) : null,
            )}
          </div>
        ) : null}
        {data.counts.total > 0 ? (
        <ul className="m-hero-legend">
          <li>
            <StatusShape tone="on" /> <b>{data.counts.online}</b> on
          </li>
          {data.counts.updating > 0 ? (
            <li>
              <StatusShape tone="switching" /> <b>{data.counts.updating}</b> switching video
            </li>
          ) : null}
          <li>
            <StatusShape tone="off" /> <b>{data.counts.offline}</b> off
          </li>
          {data.counts.paused > 0 ? (
            <li>
              <StatusShape tone="paused" /> <b>{data.counts.paused}</b> paused
            </li>
          ) : null}
        </ul>
        ) : null}
      </section>

      <Section title="What’s playing">
        <div className="m-card m-playing">
          <Link href={href(data.fleetLoop ? `/m/videos/${data.fleetLoop.id}` : "/m/videos")} className="m-playing-main" data-testid="fleet-loop">
            <Poster src={data.fleetLoop?.posterUrl} alt="" ratio="wide" className="m-playing-poster" />
            <div className="m-playing-text">
              <span className="m-label">All cabs</span>
              <strong>{data.fleetLoop ? data.fleetLoop.name : "Nothing chosen yet"}</strong>
              <span className="m-muted">
                {data.fleetLoop
                  ? [
                      data.counts.total === 0
                        ? "No cabs yet"
                        : data.fleetLoop.liveOn.cabCount === 0
                          ? "No cab follows it right now"
                          : `Set for ${cabCount(data.fleetLoop.liveOn.cabCount)}`,
                      videoLength(data.fleetLoop.durationMs),
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : "Choose a video to play on every cab."}
              </span>
            </div>
          </Link>
          <ButtonLink to="/m/change?target=fleet" variant="primary" className="m-btn-block" testId="change-fleet">
            Change what all cabs play
          </ButtonLink>
        </div>

        {data.groups.length > 0 ? (
          <ul className="m-list m-card m-groups" aria-label="Groups">
            {data.groups.map((group) => (
              <li key={group.id}>
                <Link href={href(`/m/change?target=group:${group.id}`)} className="m-listrow" data-testid="group-row" data-group-id={group.id}>
                  <Poster src={group.loop?.posterUrl} alt="" ratio="thumb" />
                  <span className="m-listrow-text">
                    <strong>{group.name}</strong>
                    <span className="m-muted">
                      {group.followsFleet ? "Same as all cabs" : group.loop ? quoted(group.loop.name) : "Nothing chosen"} ·{" "}
                      {group.cabCount === 0 ? "no cabs in it yet" : `${group.onlineCount} of ${cabCount(group.cabCount)} on`}
                    </span>
                  </span>
                  <span className="m-listrow-action">Change</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      {attention.length > 0 || preparing.length > 0 ? (
        <Section title="Needs a look">
          <ul className="m-list m-card" data-testid="attention">
            {preparing.map((loop) => (
              <li key={`pr-${loop.id}`}>
                <Link href={href(`/m/videos/${loop.id}`)} className="m-listrow m-attn m-attn-info">
                  <span className="m-attn-icon">
                    <InfoIcon size={18} />
                  </span>
                  <span className="m-listrow-text">
                    <strong>Getting {quoted(loop.name)} ready</strong>
                    <span className="m-muted">It will appear in Videos when it&rsquo;s done.</span>
                  </span>
                  <ChevronIcon size={18} className="m-listrow-chev" />
                </Link>
              </li>
            ))}
            {attention.map((item) => (
              <li key={item.key}>
                <Link href={href(item.to)} className={`m-listrow m-attn m-attn-${item.tone}`}>
                  <span className="m-attn-icon">{item.tone === "info" ? <InfoIcon size={18} /> : <AlertIcon size={18} />}</span>
                  <span className="m-listrow-text">
                    <strong>{item.title}</strong>
                    <span className="m-muted">{item.text}</span>
                  </span>
                  <ChevronIcon size={18} className="m-listrow-chev" />
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Cabs" id="cabs">
        <div className="m-chips" role="tablist" aria-label="Show cabs" hidden={data.cabs.length === 0}>
          {(
            [
              ["all", "All", lists.all.length],
              ["on", "On", lists.on.length],
              ["off", "Off", lists.off.length],
              ["paused", "Paused", lists.paused.length],
            ] as const
          ).map(([key, label, count]) =>
            key === "paused" && count === 0 && filter !== "paused" ? null : (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={filter === key}
                className={`m-chip ${filter === key ? "is-active" : ""}`}
                onClick={() => setFilter(key)}
              >
                {label} <span className="m-chip-count">{count}</span>
              </button>
            ),
          )}
        </div>
        {data.cabs.length === 0 ? (
          <EmptyState icon={<CabsIcon size={28} />} title="No cabs yet">
            Cabs appear here the first time their screen is switched on.
          </EmptyState>
        ) : shown.length === 0 ? (
          <p className="m-empty-inline">No cabs are {filter === "on" ? "on" : filter === "off" ? "off" : "paused"} right now.</p>
        ) : (
          <ul className="m-cablist" data-testid="cab-list">
            {shown.map((cab) => (
              <CabRow key={cab.id} cab={cab} />
            ))}
          </ul>
        )}
        {switchingCabs.length > 0 ? (
          <Notice tone="info">
            &ldquo;Switching&rdquo; means the cab is on and has been told to play a new video. Cabs switch{" "}
            {lagPhrase(switchingCabs, data.changeLagMinutes)}.
          </Notice>
        ) : null}
      </Section>
    </Screen>
  );
}
