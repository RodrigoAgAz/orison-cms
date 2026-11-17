"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { StatCard } from "@/components/stat-card";
import { useToast } from "@/components/toast-provider";
import { formatDayKeyShort, formatLondonDateTime } from "@/lib/london-time";

type Props = {
  analytics: {
    todayKey: string | null;
    firstDayKey: string | null;
    series: Array<{ day: string; advertPlays: number; stillShowings: number }>;
    totals: {
      advertPlays: number;
      advertPlaysToday: number;
      stillShowings: number;
      stillShowingsToday: number;
      fillerPlays: number;
      safetyPlays: number;
      loopPasses: number;
    };
    completion: { measuredPlays: number; completedPlays: number; ratePercent: number | null };
    busiestDay: { day: string; advertPlays: number } | null;
    adBreakdown: Array<{
      assetId: string;
      label: string;
      plays: number;
      measuredPlays: number;
      completionPercent: number | null;
    }>;
    onlineNow: number;
    activeCabs: number;
    passengerDetection: boolean;
    journeyMetrics: {
      today: number;
      week: number;
      month: number;
      averageDurationMs: number | null;
      advertPlaysPerJourney: number | null;
    };
    cabLocations: Array<{
      serialNumber: string;
      lastHeartbeatAt: string | null;
      location: {
        lat: number;
        lng: number;
        accuracyM: number | null;
        source: string | null;
        at: string | null;
      } | null;
    }>;
  };
};

function formatDuration(valueMs: number | null) {
  if (valueMs === null) {
    return "n/a";
  }
  const totalSeconds = Math.round(valueMs / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function chartLabel(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDayKeyShort(value) : String(value ?? "");
}

function locationSourceLabel(source: string | null) {
  switch (source) {
    case "gps":
      return "GPS fix";
    case "cell":
      return "Approximate (mobile mast)";
    default:
      return "Reported position";
  }
}

export function AnalyticsDashboard({ analytics }: Props) {
  const { toast } = useToast();
  const [from, setFrom] = useState(analytics.firstDayKey ?? "");
  const [to, setTo] = useState(analytics.todayKey ?? "");
  const [exporting, setExporting] = useState(false);
  const hasPlaybackData = useMemo(
    () => analytics.series.some((entry) => entry.advertPlays > 0 || entry.stillShowings > 0),
    [analytics.series],
  );
  const journeysNa = !analytics.passengerDetection;

  async function exportCsv() {
    if (!from || !to) {
      toast({ title: "Choose dates", message: "Pick a first and last day to export.", tone: "error" });
      return;
    }
    setExporting(true);
    try {
      // A plain navigation lets the browser stream the file to disk instead of holding it in memory.
      const response = await fetch(`/api/analytics/export?from=${from}&to=${to}`, { method: "HEAD" });
      if (!response.ok) {
        const check = await fetch(`/api/analytics/export?from=${from}&to=${to}`);
        const body = (await check.json().catch(() => null)) as { error?: string } | null;
        toast({ title: "Export failed", message: body?.error ?? "Unable to generate the CSV export.", tone: "error" });
        return;
      }
      window.location.href = `/api/analytics/export?from=${from}&to=${to}`;
      toast({
        title: "Export started",
        message: `Playback log from ${from} to ${to} (London days) is downloading.`,
        tone: "success",
      });
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="stack-lg">
      <section className="stats-grid">
        <StatCard
          hint="Video adverts that played to a passenger or on a cab playing continuously. Stills are not counted."
          label="Advert plays (30 days)"
          value={analytics.totals.advertPlays}
        />
        <StatCard
          hint="Times a still image was put on screen while a cab was idle or muted (older firmware logs one a minute)."
          label="Still showings (30 days)"
          value={analytics.totals.stillShowings}
        />
        <StatCard
          hint={
            analytics.completion.ratePercent === null
              ? "Not measured: only firmware 1.2.0 and later reports whether an advert ran to the end."
              : `Of ${analytics.completion.measuredPlays} advert plays with measured data.`
          }
          label="Advert completion"
          value={analytics.completion.ratePercent === null ? "Not measured" : `${analytics.completion.ratePercent}%`}
        />
        <StatCard
          hint="Active cabs that sent a heartbeat recently. This is the state right now, not an uptime figure."
          label="Cabs online now"
          value={`${analytics.onlineNow} of ${analytics.activeCabs}`}
        />
      </section>

      <section className="stats-grid">
        <StatCard
          hint={journeysNa ? "No cab detects passengers (they play continuously)." : "Since midnight, London time."}
          label="Journeys today"
          value={journeysNa ? "n/a" : analytics.journeyMetrics.today}
        />
        <StatCard
          hint={journeysNa ? "Not applicable." : "Since Monday, London time."}
          label="Journeys this week"
          value={journeysNa ? "n/a" : analytics.journeyMetrics.week}
        />
        <StatCard
          hint={journeysNa ? "Not applicable." : "Since the 1st, London time."}
          label="Journeys this month"
          value={journeysNa ? "n/a" : analytics.journeyMetrics.month}
        />
        <StatCard
          hint={journeysNa ? "Not applicable." : "Advert plays during journeys divided by journeys, last 30 days."}
          label="Advert plays per journey"
          value={journeysNa ? "n/a" : analytics.journeyMetrics.advertPlaysPerJourney ?? "n/a"}
        />
      </section>

      <section className="stats-grid">
        <StatCard
          hint={journeysNa ? "Not applicable." : "Average length of journeys that ended in the last 30 days."}
          label="Average journey"
          value={journeysNa ? "n/a" : formatDuration(analytics.journeyMetrics.averageDurationMs)}
        />
        <StatCard
          hint={analytics.busiestDay ? `On ${formatDayKeyShort(analytics.busiestDay.day)}.` : "No advert plays yet."}
          label="Busiest day (advert plays)"
          value={analytics.busiestDay?.advertPlays ?? 0}
        />
        <StatCard hint="Filler videos played in journeys or continuously." label="Filler plays (30 days)" value={analytics.totals.fillerPlays} />
        <StatCard hint="Times the safety message started." label="Safety message plays (30 days)" value={analytics.totals.safetyPlays} />
      </section>

      <section className="stats-grid">
        <StatCard
          hint="Full passes of a pre-built loop or a phone upload, one uploaded video without slots (firmware 1.2.0+). Counted apart from advert plays: the CMS does not know which adverts are inside such a video."
          label="Pre-built loop passes (30 days)"
          value={analytics.totals.loopPasses}
        />
      </section>

      <div className="card card-toolbar">
        <div>
          <span className="eyebrow">Export</span>
          <h2>Playback log (CSV)</h2>
          <p className="muted small-print">
            Every row from the first to the last London day chosen, with what each row counts as and its London time.
          </p>
        </div>
        <div className="button-row">
          <label className="field compact-field">
            <span>From</span>
            <input onChange={(event) => setFrom(event.target.value)} type="date" value={from} />
          </label>
          <label className="field compact-field">
            <span>To</span>
            <input onChange={(event) => setTo(event.target.value)} type="date" value={to} />
          </label>
          <button className="button button-primary" disabled={exporting} onClick={() => void exportCsv()} type="button">
            Export CSV
          </button>
        </div>
      </div>

      <div className="grid-two analytics-grid">
        <section className="card stack">
          <div className="card-header">
            <div>
              <span className="eyebrow">Advert plays</span>
              <h2>Per day</h2>
            </div>
          </div>

          {hasPlaybackData ? (
            <div className="chart-shell">
              <ResponsiveContainer height="100%" width="100%">
                <LineChart data={analytics.series}>
                  <CartesianGrid stroke="rgba(255, 255, 255, 0.08)" vertical={false} />
                  <XAxis dataKey="day" tickFormatter={chartLabel} tickLine={false} />
                  <YAxis allowDecimals={false} tickLine={false} width={44} />
                  <Tooltip formatter={(value) => [value ?? 0, "Advert plays"]} labelFormatter={chartLabel} />
                  <Line dataKey="advertPlays" dot={false} stroke="#c9a84c" strokeWidth={3} type="monotone" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="empty-state compact">
              <strong>No playback data yet</strong>
              <p>The chart fills in once cabs upload their playback logs.</p>
            </div>
          )}
          <p className="muted small-print">London calendar days. Still showings are not included.</p>
        </section>

        <section className="card stack">
          <div className="card-header">
            <div>
              <span className="eyebrow">Adverts</span>
              <h2>Plays per advert (30 days)</h2>
            </div>
          </div>

          {analytics.adBreakdown.length > 0 ? (
            <div className="chart-shell">
              <ResponsiveContainer height="100%" width="100%">
                <BarChart data={analytics.adBreakdown.slice(0, 12)}>
                  <CartesianGrid stroke="rgba(255, 255, 255, 0.08)" vertical={false} />
                  <XAxis dataKey="label" interval={0} tickFormatter={(value: string) => value.slice(0, 16)} tickLine={false} />
                  <YAxis allowDecimals={false} tickLine={false} width={44} />
                  <Tooltip formatter={(value) => [value ?? 0, "Advert plays"]} />
                  <Bar dataKey="plays" fill="#3b82f6" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="empty-state compact">
              <strong>No advert plays yet</strong>
              <p>Adverts appear here once one has played to a passenger or on a cab playing continuously.</p>
            </div>
          )}
        </section>
      </div>

      <div className="grid-two analytics-grid">
        <section className="card stack" style={{ alignContent: "start" }}>
          <div className="card-header">
            <div>
              <span className="eyebrow">Adverts</span>
              <h2>Plays and completion</h2>
            </div>
          </div>

          {analytics.adBreakdown.length === 0 ? (
            <div className="empty-state compact">
              <strong>No advert plays yet</strong>
              <p>Each advert&apos;s plays appear here.</p>
            </div>
          ) : (
            <div className="chart-list" style={{ alignContent: "start" }}>
              {analytics.adBreakdown.map((entry) => (
                <div className="activity-item" key={entry.assetId}>
                  <strong>{entry.label}</strong>
                  <div className="muted">
                    {entry.plays} {entry.plays === 1 ? "play" : "plays"} ·{" "}
                    {entry.completionPercent === null
                      ? "completion not measured"
                      : `${entry.completionPercent}% ran to the end (of ${entry.measuredPlays} measured)`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card stack">
          <div className="card-header">
            <div>
              <span className="eyebrow">Location</span>
              <h2>Last known position</h2>
            </div>
          </div>

          {analytics.cabLocations.length === 0 ? (
            <div className="empty-state compact">
              <strong>No cabs yet</strong>
              <p>Positions appear once cabs send heartbeats.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Cab</th>
                    <th>Last heartbeat</th>
                    <th>Position</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.cabLocations.map((entry) => (
                    <tr key={entry.serialNumber}>
                      <td>{entry.serialNumber}</td>
                      <td>{formatLondonDateTime(entry.lastHeartbeatAt)}</td>
                      <td>
                        {entry.location ? (
                          <div className="cab-cell-lines">
                            <a
                              href={`https://www.openstreetmap.org/?mlat=${entry.location.lat}&mlon=${entry.location.lng}#map=16/${entry.location.lat}/${entry.location.lng}`}
                              rel="noreferrer"
                              target="_blank"
                            >
                              {entry.location.lat.toFixed(5)}, {entry.location.lng.toFixed(5)}
                            </a>
                            <span className="muted">
                              {locationSourceLabel(entry.location.source)}
                              {typeof entry.location.accuracyM === "number"
                                ? `, within about ${Math.round(entry.location.accuracyM)} m`
                                : ""}
                              {entry.location.at ? `, ${formatLondonDateTime(entry.location.at)}` : ""}
                            </span>
                          </div>
                        ) : (
                          <span className="muted">Not known yet</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
