"use client";

// Leaflet map of cab positions. Tiles are free CARTO dark tiles (OpenStreetMap data, attributed).
// If tiles can't load (no signal, blocked host) the cabs are still drawn on a plain background
// and the map says so. A GPS position is a pin; a mobile-network (cell tower) position is an
// "approximately here" shape with a dashed accuracy circle.

import "leaflet/dist/leaflet.css";

import type * as Leaflet from "leaflet";
import { useEffect, useRef, useState } from "react";

import { cabTone } from "../lib/status";
import type { CabLocation, CabSummary } from "../lib/types";

type MapCab = Pick<CabSummary, "id" | "label" | "status" | "location">;

const TILE_URL = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
const LONDON: [number, number] = [51.5072, -0.1276];

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const shapeSvg: Record<string, string> = {
  on: '<span class="m-pin-shape m-shape m-shape-on"></span>',
  off: '<span class="m-pin-shape m-shape m-shape-off"></span>',
  switching:
    '<svg class="m-pin-shape" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 9.5A7.5 7.5 0 0 1 18 6.8L20 9"/><path d="M20 4.5V9h-4.5"/><path d="M19.5 14.5A7.5 7.5 0 0 1 6 17.2L4 15"/><path d="M4 19.5V15h4.5"/></svg>',
  paused:
    '<svg class="m-pin-shape" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"><path d="M7.5 5v14M16.5 5v14"/></svg>',
};

export function CabMap({
  cabs,
  selectedId,
  onSelect,
  trail,
  className,
  interactive = true,
  testId = "cab-map",
}: {
  cabs: MapCab[];
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  trail?: CabLocation[];
  className?: string;
  interactive?: boolean;
  testId?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const leafletRef = useRef<typeof Leaflet | null>(null);
  const layerRef = useRef<Leaflet.LayerGroup | null>(null);
  const fittedRef = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [ready, setReady] = useState(false);
  const [tiles, setTiles] = useState<"loading" | "ok" | "failed">("loading");

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    let failTimer: number | undefined;
    void import("leaflet").then((module) => {
      const L = (module as unknown as { default?: typeof Leaflet }).default ?? (module as unknown as typeof Leaflet);
      if (cancelled || !containerRef.current) return;
      leafletRef.current = L;
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const map = L.map(containerRef.current, {
        zoomControl: false,
        attributionControl: true,
        dragging: interactive,
        touchZoom: interactive,
        scrollWheelZoom: interactive,
        doubleClickZoom: interactive,
        boxZoom: false,
        keyboard: interactive,
        tapTolerance: 15,
        zoomAnimation: !reduceMotion,
        fadeAnimation: !reduceMotion,
        markerZoomAnimation: !reduceMotion,
      }).setView(LONDON, 12);
      map.attributionControl.setPrefix(false);
      const tileLayer = L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, subdomains: "abcd", maxZoom: 19, detectRetina: false });
      let loaded = 0;
      tileLayer.on("tileload", () => {
        loaded += 1;
        setTiles("ok");
      });
      tileLayer.on("tileerror", () => {
        if (loaded === 0) setTiles("failed");
      });
      failTimer = window.setTimeout(() => {
        if (loaded === 0) setTiles("failed");
      }, 6000);
      tileLayer.addTo(map);
      if (interactive) L.control.zoom({ position: "bottomright" }).addTo(map);
      map.on("click", () => onSelectRef.current?.(null));
      layerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;
      setReady(true);
    });
    return () => {
      cancelled = true;
      if (failTimer) window.clearTimeout(failTimer);
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [interactive]);

  // Keep the map sized to its container (tab bar, rotation, keyboard).
  useEffect(() => {
    if (!ready || !containerRef.current) return;
    const observer = new ResizeObserver(() => mapRef.current?.invalidateSize());
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [ready]);

  // Draw cabs whenever data or selection changes.
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!ready || !L || !map || !layer) return;
    layer.clearLayers();
    const bounds: Leaflet.LatLngBounds[] = [];

    if (trail && trail.length > 1) {
      L.polyline(
        trail.map((point) => [point.lat, point.lng] as [number, number]),
        { color: "#e0b340", weight: 3, opacity: 0.55, dashArray: "2 7", lineCap: "round", interactive: false },
      ).addTo(layer);
    }

    for (const cab of cabs) {
      const location = cab.location;
      if (!location) continue;
      const tone = cabTone(cab);
      const approx = location.source === "cell";
      const latLng = L.latLng(location.lat, location.lng);
      if (approx && location.accuracyM) {
        const circle = L.circle(latLng, {
          radius: location.accuracyM,
          color: "#9fb4d6",
          weight: 1.5,
          dashArray: "5 6",
          fillColor: "#9fb4d6",
          fillOpacity: 0.12,
          interactive: false,
        }).addTo(layer);
        bounds.push(circle.getBounds());
      } else {
        bounds.push(L.latLngBounds(latLng, latLng));
      }
      const selected = cab.id === selectedId;
      const icon = L.divIcon({
        className: "m-pin-wrap",
        iconSize: [0, 0],
        html: `<div class="m-pin m-pin-${tone}${approx ? " is-approx" : ""}${selected ? " is-selected" : ""}" data-testid="map-marker" data-cab-id="${escapeHtml(
          cab.id,
        )}" data-approx="${approx}">${shapeSvg[tone]}<span class="m-pin-label">${approx ? "&asymp;&nbsp;" : ""}${escapeHtml(
          cab.label,
        )}</span></div>`,
      });
      const marker = L.marker(latLng, {
        icon,
        keyboard: true,
        title: `${cab.label}${approx ? " (approximate)" : ""}`,
        alt: cab.label,
        zIndexOffset: selected ? 1000 : 0,
      }).addTo(layer);
      marker.on("click", (event) => {
        L.DomEvent.stopPropagation(event);
        onSelectRef.current?.(cab.id);
      });
    }

    if (!fittedRef.current && bounds.length > 0) {
      fittedRef.current = true;
      const all = bounds.reduce((acc, item) => acc.extend(item), L.latLngBounds(bounds[0].getSouthWest(), bounds[0].getNorthEast()));
      const single = bounds.length === 1 && all.getNorthEast().equals(all.getSouthWest());
      if (single) {
        map.setView(all.getCenter(), 15, { animate: false });
      } else {
        map.fitBounds(all, { padding: [36, 36], maxZoom: 15, animate: false });
      }
    }
  }, [cabs, selectedId, trail, ready]);

  return (
    <div className={`m-map ${className ?? ""}`} data-testid={testId} data-tiles={tiles}>
      <div ref={containerRef} className="m-map-canvas" />
      {tiles === "failed" ? (
        <div className="m-map-notile" role="status" data-testid="tiles-failed">
          Street map couldn&rsquo;t load. Cab positions are still shown.
        </div>
      ) : null}
    </div>
  );
}
