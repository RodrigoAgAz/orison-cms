"use client";

import { useState } from "react";

import { CabMap } from "../components/cab-map";
import { ClockIcon, MapIcon, PauseIcon, PlayIcon } from "../components/icons";
import { Timeline24 } from "../components/timeline";
import {
  ButtonLink,
  ErrorState,
  KeyValue,
  LoadingScreen,
  Notice,
  Screen,
  Section,
  Sheet,
  Spinner,
  StatusBadge,
  TopBar,
  Freshness,
} from "../components/ui";
import { VideoPlayer } from "../components/video-player";
import { api } from "../lib/api";
import { ago, distance, duration, hoursAsDuration, longDate, plural, quoted, when, whenLong } from "../lib/format";
import { isSwitchedOn, passengerLine, sourceLine } from "../lib/status";
import { invalidate, useResource } from "../lib/store";
import type { CabDetail, Overview } from "../lib/types";

function signalWords(dbm: number | null) {
  if (dbm === null) return "Unknown";
  const label = dbm >= -75 ? "Strong" : dbm >= -90 ? "Good" : dbm >= -105 ? "Weak" : "Very weak";
  return `${label} (${dbm} dBm)`;
}

export function CabScreen({ id }: { id: string }) {
  const key = `/api/m/cabs/${id}`;
  const cab = useResource<CabDetail>(key, { refreshMs: 20_000 });
  const overview = useResource<Overview>("/api/m/overview", { refreshMs: 30_000 });
  const [pauseOpen, setPauseOpen] = useState(false);
  const data = cab.data;

  const top = (
    <TopBar
      title={data?.label ?? "Cab"}
      back={{ fallback: "/m", label: "Cabs" }}
    />
  );

  if (!data) {
    return (
      <Screen>
        {top}
        {cab.error ? <ErrorState message={cab.error.message} onRetry={() => void cab.refresh()} /> : <LoadingScreen label="Loading cab" />}
      </Screen>
    );
  }

  const now = new Date();
  const on = isSwitchedOn(data);
  const passenger = passengerLine(data);
  const group = data.group ? overview.data?.groups.find((item) => item.id === data.group?.id) : null;
  const inheritName = group ? `${group.name}’s video` : "the video for all cabs";
  const inheritLoop = group?.loop ?? overview.data?.fleetLoop ?? null;
  const pending = !data.isUpToDate && data.expected;
  // This cab's own figure: older screen software only checks for changes every 30 minutes.
  const lag = data.changeLagMinutes;

  return (
    <Screen>
      {top}

      <div className="m-cabhead" data-testid="cab-head">
        <div className="m-cabhead-row">
          <h2 className="m-cabhead-plate">{data.label}</h2>
          <StatusBadge cab={data} size="lg" />
        </div>
        <p className="m-muted">
          {[data.driverName ? `Driver ${data.driverName}` : null, data.group ? `${data.group.name} group` : "Not in a group"]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <div className="m-cabhead-fresh">
          <Freshness updatedAt={cab.updatedAt} loading={cab.loading} onRefresh={() => void cab.refresh()} />
        </div>
        {data.status === "paused" ? (
          data.cabPaused ? (
            <Notice tone="warn" title="Screen paused">
              {data.pausedReason ? `Reason: ${data.pausedReason}. ` : ""}It shows a still Orison picture instead of videos until it&rsquo;s resumed.
            </Notice>
          ) : (
            <Notice tone="warn" title="All screens paused">
              Every cab screen is paused from the desktop site. This one shows a still Orison picture until all screens are resumed.
            </Notice>
          )
        ) : passenger ? (
          <p className="m-cabhead-passenger">{passenger}</p>
        ) : null}
      </div>

      <Section title={on ? "Playing now" : data.status === "paused" ? "Set to play" : "Last played"}>
        <div className="m-card m-cabplay">
          {data.playing || data.expected ? (
            <VideoPlayer
              loopId={(data.playing ?? data.expected)!.id}
              name={(data.playing ?? data.expected)!.name}
              posterUrl={(data.playing ?? data.expected)!.posterUrl}
            />
          ) : null}
          <div className="m-cabplay-text">
            <strong data-testid="cab-playing">{data.playing ? data.playing.name : "Nothing has played yet"}</strong>
            <span className="m-muted">{sourceLine(data)}</span>
          </div>
          {pending ? (
            <Notice tone="info" title={on ? "Switching to a new video" : "New video waiting"} testId="cab-pending">
              {on
                ? `It has been told to play ${quoted(data.expected!.name)} and will switch within about ${plural(lag, "minute")}.`
                : data.status === "paused"
                  ? `It will play ${quoted(data.expected!.name)} when the screen is resumed.`
                  : `It will play ${quoted(data.expected!.name)} the next time it’s switched on.`}
            </Notice>
          ) : null}
          <div className="m-actions">
            <ButtonLink to={`/m/change?target=cab:${data.id}`} variant="primary" className="m-btn-block" testId="change-cab">
              Change what this cab plays
            </ButtonLink>
            {data.expectedSource === "cab" ? (
              <ButtonLink to={`/m/change?target=cab:${data.id}&loop=inherit`} variant="secondary" className="m-btn-block" testId="cab-inherit">
                Go back to {inheritName}
                {inheritLoop ? <span className="m-btn-sub">{quoted(inheritLoop.name)}</span> : null}
              </ButtonLink>
            ) : null}
          </div>
        </div>
      </Section>

      <Section title="Time on">
        <div className="m-card">
          <div className="m-stats">
            <div>
              <span className="m-stat-label">
                <ClockIcon size={15} /> {on ? "On for" : "Status"}
              </span>
              <strong className="m-stat-value">
                {on && data.onlineSince ? duration((now.getTime() - new Date(data.onlineSince).getTime()) / 1000) : on ? "On" : "Off"}
              </strong>
              <span className="m-muted m-stat-sub">
                {on && data.onlineSince
                  ? `since ${whenLong(data.onlineSince, now)}`
                  : data.lastSeenAt
                    ? `last on ${whenLong(data.lastSeenAt, now)}`
                    : "never switched on yet"}
              </span>
            </div>
            <div>
              <span className="m-stat-label">On today</span>
              <strong className="m-stat-value">{data.hoursOnlineToday > 0 ? hoursAsDuration(data.hoursOnlineToday) : "Not yet"}</strong>
              <span className="m-muted m-stat-sub">since midnight</span>
            </div>
          </div>
          <h3 className="m-subhead">Last 24 hours</h3>
          <Timeline24 intervals={data.timeline} now={now.getTime()} />
        </div>
      </Section>

      <Section title="Where it is">
        <div className="m-card m-cabloc">
          {data.location ? (
            <>
              <CabMap cabs={[data]} trail={data.location.source === "gps" ? data.trail : undefined} interactive={false} className="m-map-small" testId="cab-map" />
              <p className="m-cabloc-text" data-testid="cab-location-text">
                {data.location.source === "gps" ? (
                  <>
                    <MapIcon size={16} className="m-inline-icon" /> <strong>GPS position</strong>, {ago(data.location.at)}
                    {data.location.accuracyM ? ` · accurate to about ${distance(data.location.accuracyM)}` : ""}.
                  </>
                ) : (
                  <>
                    <MapIcon size={16} className="m-inline-icon" /> <strong>Approximate area</strong>
                    {data.location.accuracyM ? ` within about ${distance(data.location.accuracyM)}` : ""}, {ago(data.location.at)}. This
                    cab had no GPS fix, so the position comes from the nearest mobile phone mast.
                  </>
                )}
                {!on ? ` It may have moved since it was switched off.` : ""}
              </p>
              <a
                className="m-btn m-btn-secondary m-btn-block"
                href={`https://maps.apple.com/?ll=${data.location.lat},${data.location.lng}&q=${encodeURIComponent(data.label)}`}
                target="_blank"
                rel="noreferrer"
              >
                Open in Maps
              </a>
            </>
          ) : (
            <p className="m-cabloc-none" data-testid="cab-location-text">
              <MapIcon size={18} className="m-inline-icon" /> This cab hasn&rsquo;t reported where it is yet. Its position appears once the
              screen is switched on with a signal.
            </p>
          )}
        </div>
      </Section>

      <Section title="Screen">
        <div className="m-card">
          {data.cabPaused ? (
            <>
              <p className="m-body-text">
                The screen in {data.label} is paused: passengers see a still Orison picture instead of videos. Resume it to start playing again.
                {data.fleetPaused ? " All screens are also paused from the desktop site, so it won’t play until those are resumed too." : ""}
              </p>
              <button type="button" className="m-btn m-btn-primary m-btn-block" onClick={() => setPauseOpen(true)} data-testid="resume-cab">
                <PlayIcon size={18} /> Resume this screen
              </button>
            </>
          ) : data.fleetPaused ? (
            <div data-testid="fleet-paused">
              <Notice tone="warn" title="All screens are paused">
                {data.pausedReason && data.pausedReason !== "All cabs are paused" ? `Reason: ${data.pausedReason}. ` : ""}Every cab screen has been
                paused from the desktop site, so this one can&rsquo;t be resumed on its own. It plays again when all screens are resumed there.
              </Notice>
            </div>
          ) : (
            <>
              <p className="m-body-text">Pausing stops videos on this screen (it shows a still Orison picture instead), for example while the cab is off the road.</p>
              <button type="button" className="m-btn m-btn-secondary m-btn-block" onClick={() => setPauseOpen(true)} data-testid="pause-cab">
                <PauseIcon size={18} /> Pause this screen
              </button>
            </>
          )}
        </div>
      </Section>

      <details className="m-details m-card" data-testid="tech-details">
        <summary>Technical details</summary>
        <KeyValue
          items={[
            ["Screen serial", <code key="s">{data.serialNumber}</code>],
            ["Last check-in", data.lastSeenAt ? `${when(data.lastSeenAt, now)} (${ago(data.lastSeenAt)})` : "Never"],
            ["Running since restart", data.uptimeSeconds !== null ? duration(data.uptimeSeconds) : "Off"],
            ["Mobile signal", signalWords(data.signalStrength)],
            ["Connection", data.networkType ? data.networkType.toUpperCase() : "Unknown"],
            ["Free storage", data.storageFreeMb !== null ? `${(data.storageFreeMb / 1024).toFixed(1)} GB` : "Unknown"],
            ["Temperature", data.cpuTemp !== null ? `${Math.round(data.cpuTemp)}°C` : "Unknown"],
            ["Software", data.firmwareVersion ?? "Unknown"],
            ["Playing (ID)", data.playing ? <code key="p">{data.playing.id}</code> : "None"],
            ["In service since", longDate(data.inServiceSince)],
            ...(data.notes ? ([["Notes", data.notes]] as Array<[string, React.ReactNode]>) : []),
          ]}
        />
      </details>

      <PauseSheet cab={data} open={pauseOpen} onClose={() => setPauseOpen(false)} onDone={() => void invalidate("/api/m/")} />
    </Screen>
  );
}

function PauseSheet({ cab, open, onClose, onDone }: { cab: CabDetail; open: boolean; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the cab's own pause can be undone here; an all-screens pause is lifted on the desktop site.
  const resuming = cab.cabPaused;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (resuming) {
        await api(`/api/devices/${cab.id}/enable`, { method: "POST", json: {} });
      } else {
        await api(`/api/devices/${cab.id}/disable`, { method: "POST", json: { reason: reason.trim() || null } });
      }
      onDone();
      setReason("");
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That didn’t work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={resuming ? `Resume the screen in ${cab.label}?` : `Pause the screen in ${cab.label}?`}
      testId="pause-sheet"
      footer={
        <>
          <button type="button" className="m-btn m-btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="m-btn m-btn-primary" onClick={() => void submit()} disabled={busy} data-testid="pause-confirm">
            {busy ? <Spinner /> : null}
            {resuming ? "Resume screen" : "Pause screen"}
          </button>
        </>
      }
    >
      {resuming ? (
        <p className="m-body-text">
          It will start playing again{" "}
          {isSwitchedOn(cab) || cab.lastSeenAt
            ? `within about ${plural(cab.changeLagMinutes, "minute")} if the cab is on, or the next time it’s switched on`
            : "when it’s switched on"}
          .{cab.fleetPaused ? " All screens are also paused from the desktop site, so it won’t play until those are resumed too." : ""}
        </p>
      ) : (
        <>
          <p className="m-body-text">
            Passengers in {cab.label} will see a still Orison picture instead of videos until you resume it
            {isSwitchedOn(cab) ? ` (it takes effect within about ${plural(cab.changeLagMinutes, "minute")})` : ""}. Other cabs aren&rsquo;t affected.
          </p>
          <label className="m-field">
            <span>Reason (optional)</span>
            <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="For example: in for repairs" maxLength={200} />
          </label>
        </>
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Sheet>
  );
}
