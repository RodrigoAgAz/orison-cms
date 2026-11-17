"use client";

import Link from "next/link";
import { useState } from "react";

import { runningLine } from "../components/cab-row";
import { CabMap } from "../components/cab-map";
import { ChevronIcon, CloseIcon } from "../components/icons";
import { MapIcon } from "../components/icons";
import { ConnectionNotice, EmptyState, ErrorState, Freshness, href, LoadingScreen, Poster, Sheet, StatusBadge, StatusShape } from "../components/ui";
import { ago, distance, plural } from "../lib/format";
import { cabCount, contentLine } from "../lib/status";
import { useResource } from "../lib/store";
import type { CabSummary, Overview } from "../lib/types";

/** Why a cab is not on the map, in words that are true for its equipment. */
export function notOnMapReason(cab: CabSummary) {
  switch (cab.positionReporting) {
    case "none":
      return "Its equipment doesn’t report a position";
    case "unknown":
      return cab.lastSeenAt ? "No position reported yet" : "Hasn’t been switched on yet";
    case "cell":
      return "No GPS; its mobile mast couldn’t be placed yet";
    case "gps":
      return "No GPS fix yet";
    default:
      return cab.lastSeenAt ? "No position reported yet" : "Hasn’t been switched on yet";
  }
}

export function MapScreen() {
  const overview = useResource<Overview>("/api/m/overview", { refreshMs: 20_000 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [missingOpen, setMissingOpen] = useState(false);
  const data = overview.data;

  const head = (
    <header className="m-map-head">
      <div className="m-map-headrow">
        <h1>Map</h1>
        <Freshness updatedAt={overview.updatedAt} loading={overview.loading} onRefresh={() => void overview.refresh()} />
      </div>
      <ConnectionNotice />
    </header>
  );

  if (!data) {
    return (
      <div className="m-screen">
        {head}
        {overview.error ? <ErrorState message={overview.error.message} onRetry={() => void overview.refresh()} /> : <LoadingScreen label="Loading map" />}
      </div>
    );
  }

  const located = data.cabs.filter((cab) => cab.location);
  const missing = data.cabs.filter((cab) => !cab.location);
  const approx = located.filter((cab) => cab.location?.source === "cell");
  const selected = data.cabs.find((cab) => cab.id === selectedId) ?? null;

  // Nothing to put on a map (the tab bar leaves Map out in this case; this is for a saved link).
  if (located.length === 0) {
    const noEquipment = missing.filter((cab) => cab.positionReporting === "none");
    return (
      <div className="m-screen">
        {head}
        <div data-testid="map-empty">
          <EmptyState icon={<MapIcon size={28} />} title={data.cabs.length === 0 ? "No cabs yet" : "No cab reports where it is"}>
            {data.cabs.length === 0
              ? "Cabs appear here once they’re switched on and report a position."
              : noEquipment.length === data.cabs.length
                ? data.cabs.length === 1
                  ? "This cab’s equipment doesn’t report a position (it has no GPS or mobile modem the box can read), so there is nothing to show on a map."
                  : "None of these cabs’ equipment reports a position (no GPS or mobile modem the box can read), so there is nothing to show on a map."
                : "Cabs appear here once their equipment reports a position."}
          </EmptyState>
          {missing.length > 0 ? (
            <ul className="m-list m-card m-map-emptylist">
              {missing.map((cab) => (
                <li key={cab.id}>
                  <Link href={href(`/m/cabs/${cab.id}`)} className="m-listrow">
                    <span className="m-listrow-text">
                      <strong>{cab.label}</strong>
                      <span className="m-muted">{notOnMapReason(cab)}</span>
                    </span>
                    <StatusBadge cab={cab} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="m-mapscreen">
      {head}
      <div className="m-mapscreen-body">
        <CabMap cabs={located} selectedId={selectedId} onSelect={setSelectedId} className="m-map-full" />

        <div className="m-map-overlay-top">
          <span className="m-map-count" data-testid="map-count">
            {located.length === data.cabs.length
              ? located.length === 1
                ? "1 cab shown"
                : `All ${cabCount(located.length)} shown`
              : `${located.length} of ${cabCount(data.cabs.length)} shown`}
          </span>
          {missing.length > 0 ? (
            <button type="button" className="m-map-chip" onClick={() => setMissingOpen(true)} data-testid="map-missing">
              {missing.length} not on the map
            </button>
          ) : null}
        </div>

        {selected ? (
          <div className="m-map-card" data-testid="map-card">
            <button type="button" className="m-iconbtn m-map-card-close" onClick={() => setSelectedId(null)} aria-label="Close">
              <CloseIcon size={18} />
            </button>
            <Link href={href(`/m/cabs/${selected.id}`)} className="m-map-card-link">
              <div className="m-cabrow-top">
                <span className="m-cabrow-plate">{selected.label}</span>
                <StatusBadge cab={selected} />
              </div>
              <div className="m-cabrow-playing">
                <Poster src={(selected.isUpToDate ? selected.playing : selected.expected ?? selected.playing)?.posterUrl} alt="" ratio="thumb" />
                <span className="m-cabrow-loop">{contentLine(selected)}</span>
              </div>
              <div className="m-cabrow-foot">
                <span>{runningLine(selected)}</span>
              </div>
              <div className="m-map-card-where">
                {selected.location?.source === "cell"
                  ? `Approximate area${selected.location.accuracyM ? `, within about ${distance(selected.location.accuracyM)}` : ""} · ${ago(selected.location.at)}`
                  : selected.location
                    ? `GPS position · ${ago(selected.location.at)}`
                    : ""}
              </div>
              <span className="m-map-card-open">
                Open cab <ChevronIcon size={16} />
              </span>
            </Link>
          </div>
        ) : (
          <div className="m-map-legend" aria-label="Map key">
            <span>
              <StatusShape tone="on" /> On
            </span>
            <span>
              <StatusShape tone="switching" /> Switching
            </span>
            <span>
              <StatusShape tone="off" /> Off
            </span>
            {approx.length > 0 ? (
              <span>
                <i className="m-key m-key-approx" /> Approximate area
              </span>
            ) : null}
          </div>
        )}
      </div>

      <Sheet open={missingOpen} onClose={() => setMissingOpen(false)} title={`${plural(missing.length, "cab")} not on the map`}>
        <p className="m-body-text">
          {missing.every((cab) => cab.positionReporting === "none")
            ? "Their equipment doesn’t report a position, so they can’t be shown on the map."
            : "Each one says why it isn’t on the map."}
        </p>
        <ul className="m-list m-card">
          {missing.map((cab) => (
            <li key={cab.id}>
              <Link href={href(`/m/cabs/${cab.id}`)} className="m-listrow">
                <span className="m-listrow-text">
                  <strong>{cab.label}</strong>
                  <span className="m-muted">
                    {notOnMapReason(cab)} · {runningLine(cab)}
                  </span>
                </span>
                <StatusBadge cab={cab} />
              </Link>
            </li>
          ))}
        </ul>
      </Sheet>
    </div>
  );
}
