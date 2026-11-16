"use client";

import Link from "next/link";
import { useState } from "react";

import { runningLine } from "../components/cab-row";
import { CabMap } from "../components/cab-map";
import { ChevronIcon, CloseIcon } from "../components/icons";
import { ConnectionNotice, ErrorState, Freshness, href, LoadingScreen, Poster, Sheet, StatusBadge, StatusShape } from "../components/ui";
import { ago, distance, plural } from "../lib/format";
import { cabCount, contentLine } from "../lib/status";
import { useResource } from "../lib/store";
import type { Overview } from "../lib/types";

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

  return (
    <div className="m-mapscreen">
      {head}
      <div className="m-mapscreen-body">
        <CabMap cabs={located} selectedId={selectedId} onSelect={setSelectedId} className="m-map-full" />

        <div className="m-map-overlay-top">
          <span className="m-map-count" data-testid="map-count">
            {located.length === data.cabs.length ? `All ${cabCount(located.length)} shown` : `${located.length} of ${cabCount(data.cabs.length)} shown`}
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
        <p className="m-body-text">These cabs haven&rsquo;t reported a position yet. They appear on the map once their screen is on with a signal.</p>
        <ul className="m-list m-card">
          {missing.map((cab) => (
            <li key={cab.id}>
              <Link href={href(`/m/cabs/${cab.id}`)} className="m-listrow">
                <span className="m-listrow-text">
                  <strong>{cab.label}</strong>
                  <span className="m-muted">{runningLine(cab)}</span>
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
