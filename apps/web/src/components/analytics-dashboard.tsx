"use client";

import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useToast } from "@/components/toast-provider";

type Props = {
  analytics: {
    impressionsSeries: Array<{
      day: string;
      count: number;
    }>;
    adBreakdown: Array<{
      assetId: string | null;
      label: string;
      count: number;
    }>;
    fleetUptimePercent: number;
  };
};

function formatChartDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function AnalyticsDashboard({ analytics }: Props) {
  const { toast } = useToast();
  const [from, setFrom] = useState(() => {
    const first = analytics.impressionsSeries[0]?.day;
    return first ?? new Date().toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => {
    const last = analytics.impressionsSeries[analytics.impressionsSeries.length - 1]?.day;
    return last ?? new Date().toISOString().slice(0, 10);
  });
  const hasPlaybackData = useMemo(
    () =>
      analytics.impressionsSeries.some((entry) => entry.count > 0) ||
      analytics.adBreakdown.some((entry) => entry.count > 0),
    [analytics.adBreakdown, analytics.impressionsSeries],
  );

  async function exportCsv() {
    const response = await fetch(`/api/analytics/export?from=${from}&to=${to}`);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      toast({
        title: "Export failed",
        message: body?.error ?? "Unable to generate the CSV export.",
        tone: "error",
      });
      return;
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `orison-playback-${from}-to-${to}.csv`;
    link.click();
    URL.revokeObjectURL(url);

    toast({
      title: "CSV exported",
      message: `Playback logs from ${from} to ${to} were downloaded.`,
      tone: "success",
    });
  }

  return (
    <div className="stack-lg">
      <section className="stats-grid">
        <div className="card stat-card">
          <span className="stat-label">Fleet Uptime</span>
          <strong className="stat-value">{analytics.fleetUptimePercent}%</strong>
        </div>
        <div className="card stat-card">
          <span className="stat-label">Tracked Days</span>
          <strong className="stat-value">{analytics.impressionsSeries.length}</strong>
        </div>
        <div className="card stat-card">
          <span className="stat-label">Ad Assets</span>
          <strong className="stat-value">{analytics.adBreakdown.length}</strong>
        </div>
        <div className="card stat-card">
          <span className="stat-label">Peak Daily Plays</span>
          <strong className="stat-value">
            {Math.max(...analytics.impressionsSeries.map((item) => item.count), 0)}
          </strong>
        </div>
      </section>

      <div className="card card-toolbar">
        <div>
          <span className="eyebrow">Export</span>
          <h2>Playback Log CSV</h2>
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
          <button className="button button-primary" onClick={() => void exportCsv()} type="button">
            Export CSV
          </button>
        </div>
      </div>

      <div className="grid-two analytics-grid">
        <section className="card stack">
          <div className="card-header">
            <div>
              <span className="eyebrow">Impressions</span>
              <h2>Daily Trend</h2>
            </div>
          </div>

          {hasPlaybackData ? (
            <div className="chart-shell">
              <ResponsiveContainer height="100%" width="100%">
                <LineChart data={analytics.impressionsSeries}>
                  <CartesianGrid stroke="rgba(17, 32, 51, 0.08)" vertical={false} />
                  <XAxis dataKey="day" tickFormatter={formatChartDate} tickLine={false} />
                  <YAxis allowDecimals={false} tickLine={false} width={36} />
                  <Tooltip
                    formatter={(value) => [value ?? 0, "Plays"]}
                    labelFormatter={(label) =>
                      typeof label === "string" ? formatChartDate(label) : String(label ?? "")
                    }
                  />
                  <Line
                    dataKey="count"
                    dot={false}
                    stroke="#c9a84c"
                    strokeWidth={3}
                    type="monotone"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="empty-state compact">
              <strong>No playback data yet</strong>
              <p>Daily impression charts will appear once the first loop has played on devices.</p>
            </div>
          )}
        </section>

        <section className="card stack">
          <div className="card-header">
            <div>
              <span className="eyebrow">Ad Breakdown</span>
              <h2>Per Advertisement</h2>
            </div>
          </div>

          {hasPlaybackData && analytics.adBreakdown.length > 0 ? (
            <div className="chart-shell">
              <ResponsiveContainer height="100%" width="100%">
                <BarChart data={analytics.adBreakdown}>
                  <CartesianGrid stroke="rgba(17, 32, 51, 0.08)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    interval={0}
                    tickFormatter={(value: string) => value.slice(0, 16)}
                    tickLine={false}
                  />
                  <YAxis allowDecimals={false} tickLine={false} width={36} />
                  <Tooltip formatter={(value) => [value ?? 0, "Ad plays"]} />
                  <Bar dataKey="count" fill="#0a1628" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="empty-state compact">
              <strong>No playback data yet</strong>
              <p>Per-ad performance will appear once advertisement playback logs arrive.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
