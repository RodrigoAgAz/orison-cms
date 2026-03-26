import Link from "next/link";

import { PageErrorNotice } from "@/components/page-error-notice";
import { StatCard } from "@/components/stat-card";
import { StatusPill } from "@/components/status-pill";
import { requireUser } from "@/lib/auth";
import { getDashboardData, resolveDeviceStatus } from "@/lib/queries";

export default async function DashboardPage() {
  await requireUser();
  const { activity, devices, publishedLoop, stats, error } = await getDashboardData();

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Operations</span>
          <h1>Fleet Dashboard</h1>
          <p className="muted">Pilot fleet view for the 30-cab London rollout.</p>
        </div>
        <div className="button-row">
          <Link className="button button-primary" href="/loops">
            Create New Loop
          </Link>
          {publishedLoop ? (
            <Link className="button button-secondary" href={`/loops/${publishedLoop.id}`}>
              View Current Loop
            </Link>
          ) : null}
        </div>
      </div>

      <section className="stats-grid">
        <StatCard label="Total Devices" value={stats.totalDevices} hint={`${stats.onlineCount} online`} />
        <StatCard
          label="Current Loop"
          value={publishedLoop?.name ?? "None published"}
          hint={publishedLoop?.publishedAt ? new Date(publishedLoop.publishedAt).toLocaleString() : undefined}
        />
        <StatCard label="Impressions Today" value={stats.impressionsToday} />
        <StatCard label="Fleet Uptime" value={`${stats.uptimePercent}%`} />
      </section>

      <PageErrorNotice message={error} title="Dashboard data unavailable" />

      <div className="grid-two">
        <section className="card stack">
          <div className="card-header">
            <div>
              <span className="eyebrow">Fleet Status</span>
              <h2>Cab Grid</h2>
            </div>
          </div>

          {devices.length === 0 ? (
            <div className="empty-state">
              <strong>No devices registered</strong>
              <p>Register your first cab screen to start monitoring heartbeats, sync state, and fleet health.</p>
              <Link className="button button-primary" href="/devices">
                Register First Device
              </Link>
            </div>
          ) : (
            <div className="fleet-grid">
              {devices.map((device) => {
                const status = resolveDeviceStatus(device, publishedLoop?.id ?? null);
                return (
                  <div className="fleet-dot-card" key={device.id}>
                    <span
                      className={
                        status === "online"
                          ? "dot dot-green"
                          : status === "outdated"
                            ? "dot dot-amber"
                            : status === "offline"
                              ? "dot dot-red"
                              : "dot dot-grey"
                      }
                    />
                    <strong className="fleet-grid-label">{device.serialNumber}</strong>
                    <span className="muted">{device.cabLicenseNumber ?? "Unassigned cab"}</span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="card stack">
          <div className="card-header">
            <div>
              <span className="eyebrow">Activity</span>
              <h2>Recent Events</h2>
            </div>
          </div>

          <div className="activity-list">
            {activity.length === 0 ? (
              <div className="empty-state compact">
                <strong>No activity yet</strong>
                <p>Publishing loops, uploads, and device heartbeats will appear here.</p>
              </div>
            ) : (
              activity.map((event) => (
                <div className="activity-item" key={event.id}>
                  <strong>{event.message}</strong>
                  <div className="muted">{new Date(event.createdAt).toLocaleString()}</div>
                  <StatusPill value={event.type} />
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
