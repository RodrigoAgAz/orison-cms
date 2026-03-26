import { formatDistanceToNowStrict } from "date-fns";
import type { Route } from "next";
import Link from "next/link";

import { PageErrorNotice } from "@/components/page-error-notice";
import { StatusPill } from "@/components/status-pill";
import { requireUser } from "@/lib/auth";
import { getDashboardData } from "@/lib/queries";

function formatRelativeTime(value: Date | string | null | undefined) {
  if (!value) {
    return "No heartbeat yet";
  }

  return formatDistanceToNowStrict(new Date(value), { addSuffix: true });
}

function formatDuration(valueMs: number) {
  if (!valueMs) {
    return "0m";
  }

  const totalSeconds = Math.round(valueMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function playerStateLabel(value: string) {
  switch (value) {
    case "journey":
      return "Journey";
    case "silent":
      return "Silent";
    case "idle":
      return "Idle";
    case "disabled":
      return "Disabled";
    default:
      return "Unknown";
  }
}

function playerStateClass(value: string) {
  switch (value) {
    case "journey":
      return "ops-state-pill is-journey";
    case "silent":
      return "ops-state-pill is-silent";
    case "idle":
      return "ops-state-pill is-idle";
    case "disabled":
      return "ops-state-pill is-disabled";
    default:
      return "ops-state-pill";
  }
}

export default async function DashboardPage() {
  await requireUser();
  const {
    activity,
    activeProgrammes,
    attentionItems,
    devices,
    error,
    fleetControl,
    fleetWideLoop,
    groupSummaries,
    journeyMetrics,
    publishedLoop,
    publishingLoops,
    safetyVideo,
    stats,
  } = await getDashboardData();

  const groupProgrammes = activeProgrammes.filter((programme) => programme.audience !== "All devices");

  return (
    <div className="page ops-dashboard">
      <section className="card ops-hero">
        <div className="ops-hero-copy">
          <span className="eyebrow">Operations</span>
          <h1>Orison Ops Dashboard</h1>
          <p className="muted">
            Live control room for fleet health, targeted programmes, safety playback, and passenger journey state.
          </p>
          <div className="ops-hero-meta">
            <span>
              Latest live programme: <strong>{publishedLoop?.name ?? "No published loop"}</strong>
            </span>
            <span>
              Updated {publishedLoop?.publishedAt ? formatRelativeTime(publishedLoop.publishedAt) : "not yet published"}
            </span>
          </div>
        </div>

        <div className="button-row">
          <Link className="button button-primary" href="/loops">
            Create Loop
          </Link>
          <Link className="button button-secondary" href="/loops">
            Upload Pre-built Loop
          </Link>
          <Link className="button button-secondary" href="/devices">
            Open Devices
          </Link>
        </div>
      </section>

      <PageErrorNotice message={error} title="Dashboard data unavailable" />

      <section className="ops-command-strip">
        <article className="ops-command-card">
          <span className="ops-command-label">Fleet Health</span>
          <strong className="ops-command-value">
            {stats.onlineCount}/{stats.totalDevices}
          </strong>
          <p className="ops-command-note">
            {stats.outdatedCount} outdated · {stats.offlineCount} offline
          </p>
        </article>

        <article className="ops-command-card">
          <span className="ops-command-label">Active Journeys</span>
          <strong className="ops-command-value">{stats.activeJourneys}</strong>
          <p className="ops-command-note">
            {stats.silentScreens} muted · {stats.idleScreens} idle
          </p>
        </article>

        <article className="ops-command-card">
          <span className="ops-command-label">Safety Message</span>
          <strong className="ops-command-value is-copy">{safetyVideo ? "Configured" : "Missing"}</strong>
          <p className="ops-command-note">
            {safetyVideo
              ? `${safetyVideo.filename} · ${formatDuration(safetyVideo.durationMs ?? 0)}`
              : "Assign an active safety clip in Settings"}
          </p>
        </article>

        <article className="ops-command-card">
          <span className="ops-command-label">Emergency Status</span>
          <strong className="ops-command-value is-copy">{fleetControl.disabled ? "Disabled" : "Enabled"}</strong>
          <p className="ops-command-note">{fleetControl.reason ?? "No remote kill-switch active"}</p>
        </article>

        <article className="ops-command-card">
          <span className="ops-command-label">Programmes Live</span>
          <strong className="ops-command-value">{stats.liveProgrammes}</strong>
          <p className="ops-command-note">
            {fleetWideLoop ? "Fleet-wide fallback ready" : "No fleet-wide fallback"} · {groupProgrammes.length} group targets
          </p>
        </article>

        <article className="ops-command-card">
          <span className="ops-command-label">Ad Plays Today</span>
          <strong className="ops-command-value">{stats.adPlaysToday}</strong>
          <p className="ops-command-note">
            {stats.journeysToday} journeys today · {stats.uptimePercent}% fleet uptime
          </p>
        </article>
      </section>

      <div className="ops-main-grid">
        <section className="card ops-stage-card stack">
          <div className="card-header">
            <div>
              <span className="eyebrow">Fleet Matrix</span>
              <h2>Live Device State</h2>
            </div>
            <div className="button-row">
              <Link className="button button-secondary" href="/device-preview">
                Device Preview
              </Link>
              {publishedLoop ? (
                <Link className="button button-secondary" href={`/loops/${publishedLoop.id}` as Route}>
                  View Latest Loop
                </Link>
              ) : null}
            </div>
          </div>

          <div className="ops-group-strip">
            {groupSummaries.map((group) => (
              <Link className="ops-group-card" href={group.href as Route} key={group.id}>
                <div className="ops-group-top">
                  <div>
                    <strong>{group.name}</strong>
                    <p>{group.description ?? "Targeted fleet segment overview"}</p>
                  </div>
                  <span className="ops-group-count">{group.deviceCount}</span>
                </div>
                <div className="ops-group-metrics">
                  <span>{group.onlineCount} online</span>
                  <span>{group.outdatedCount} outdated</span>
                  <span>{group.offlineCount} offline</span>
                  <span>{group.journeyCount + group.silentCount} active journeys</span>
                </div>
                <div className="ops-group-loop">
                  <span className="eyebrow">Target Loop</span>
                  <strong>{group.targetLoop?.name ?? "No loop assigned"}</strong>
                </div>
              </Link>
            ))}
          </div>

          {devices.length === 0 ? (
            <div className="empty-state">
              <strong>No devices registered</strong>
              <p>Register your first cab screen to turn this control room into a live fleet view.</p>
              <Link className="button button-primary" href="/devices">
                Register First Device
              </Link>
            </div>
          ) : (
            <div className="ops-fleet-matrix">
              {devices.map((device) => (
                <article className={`ops-fleet-node is-${device.status}`} key={device.id}>
                  <div className="ops-fleet-node-top">
                    <div>
                      <strong>{device.serialNumber}</strong>
                      <p>{device.cabLicenseNumber ?? "Unassigned cab"}</p>
                    </div>
                    <span
                      className={
                        device.status === "online"
                          ? "dot dot-green"
                          : device.status === "outdated"
                            ? "dot dot-amber"
                            : device.status === "offline"
                              ? "dot dot-red"
                              : "dot dot-grey"
                      }
                    />
                  </div>

                  <div className="ops-fleet-node-pills">
                    <StatusPill value={device.status} />
                    <span className={playerStateClass(device.playerStatus)}>{playerStateLabel(device.playerStatus)}</span>
                    <span className="ops-mini-chip">{device.group?.name ?? "Fleet-wide"}</span>
                  </div>

                  <dl className="ops-node-meta">
                    <div>
                      <dt>Expected loop</dt>
                      <dd>{device.expectedLoopName ?? "No loop assigned"}</dd>
                    </div>
                    <div>
                      <dt>Last heartbeat</dt>
                      <dd>{formatRelativeTime(device.lastHeartbeatAt)}</dd>
                    </div>
                    <div>
                      <dt>Signal / storage</dt>
                      <dd>
                        {device.latestHeartbeat?.signalStrength ?? "n/a"} dBm ·{" "}
                        {typeof device.storageFreeMb === "number" ? `${device.storageFreeMb} MB free` : "storage unknown"}
                      </dd>
                    </div>
                  </dl>

                  {device.isDisabled ? (
                    <div className="ops-node-alert">
                      Disabled{device.disabledReason ? `: ${device.disabledReason}` : ""}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="ops-side-stack">
          <section className="card stack">
            <div className="card-header">
              <div>
                <span className="eyebrow">Attention Queue</span>
                <h2>What Needs Action</h2>
              </div>
            </div>

            {attentionItems.length === 0 ? (
              <div className="empty-state compact">
                <strong>No immediate operational issues</strong>
                <p>The fleet is healthy, current, and ready for passenger journeys.</p>
              </div>
            ) : (
              <div className="ops-attention-list">
                {attentionItems.map((item) => (
                  <div className={`ops-attention-item is-${item.severity}`} key={item.id}>
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.detail}</p>
                    </div>
                    <Link className="button button-secondary" href={item.href as Route}>
                      {item.actionLabel}
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>

      <div className="ops-lower-grid">
        <section className="card stack">
          <div className="card-header">
            <div>
              <span className="eyebrow">Programme Control</span>
              <h2>Live Content Routing</h2>
            </div>
          </div>

          <div className="ops-programme-grid">
            <article className="ops-programme-panel">
              <span className="eyebrow">Fleet-wide Fallback</span>
              {fleetWideLoop ? (
                <>
                  <strong>{fleetWideLoop.name}</strong>
                  <p>Published {fleetWideLoop.publishedAt ? formatRelativeTime(fleetWideLoop.publishedAt) : "recently"}</p>
                  <Link className="button button-secondary" href={`/loops/${fleetWideLoop.id}` as Route}>
                    Open loop
                  </Link>
                </>
              ) : (
                <div className="empty-state compact">
                  <strong>No fleet-wide fallback</strong>
                  <p>Publish a fleet-wide loop so ungrouped devices always have content.</p>
                </div>
              )}
            </article>

            <article className="ops-programme-panel">
              <span className="eyebrow">Group Loops</span>
              {groupProgrammes.length === 0 ? (
                <div className="empty-state compact">
                  <strong>No group-specific loops live</strong>
                  <p>Publish targeted content to a device group to segment the fleet.</p>
                </div>
              ) : (
                <div className="ops-programme-list">
                  {groupProgrammes.map((programme) => (
                    <Link className="ops-programme-row" href={programme.href as Route} key={`${programme.id}-${programme.audience}`}>
                      <div>
                        <strong>{programme.name}</strong>
                        <p>{programme.audience}</p>
                      </div>
                      <span>{programme.publishedAt ? formatRelativeTime(programme.publishedAt) : "Live"}</span>
                    </Link>
                  ))}
                </div>
              )}
            </article>

            <article className="ops-programme-panel">
              <span className="eyebrow">Publishing Queue</span>
              {publishingLoops.length === 0 ? (
                <div className="empty-state compact">
                  <strong>No active publishing jobs</strong>
                  <p>Compiled loops and direct uploads will appear here while they go live.</p>
                </div>
              ) : (
                <div className="ops-programme-list">
                  {publishingLoops.map((loop) => (
                    <Link className="ops-programme-row" href={`/loops/${loop.id}` as Route} key={loop.id}>
                      <div>
                        <strong>{loop.name}</strong>
                        <p>{loop.targetGroup?.name ?? "All devices"}</p>
                      </div>
                      <span>{formatRelativeTime(loop.updatedAt)}</span>
                    </Link>
                  ))}
                </div>
              )}
            </article>

            <article className="ops-programme-panel">
              <span className="eyebrow">Quick Actions</span>
              <div className="ops-quick-actions">
                <Link className="button button-primary" href="/loops">
                  Create or Publish Loop
                </Link>
                <Link className="button button-secondary" href="/assets">
                  Open Asset Library
                </Link>
                <Link className="button button-secondary" href="/devices">
                  Manage Devices
                </Link>
                <Link className="button button-secondary" href="/settings">
                  Review Safety Settings
                </Link>
              </div>
            </article>
          </div>
        </section>

        <section className="card stack">
          <div className="card-header">
            <div>
              <span className="eyebrow">Journey Signal</span>
              <h2>Passenger Activity</h2>
            </div>
          </div>

          <div className="ops-journey-grid">
            <article className="ops-metric-card">
              <span className="ops-metric-label">Journeys Today</span>
              <strong>{journeyMetrics.todayCount}</strong>
            </article>
            <article className="ops-metric-card">
              <span className="ops-metric-label">Journeys This Week</span>
              <strong>{journeyMetrics.weekCount}</strong>
            </article>
            <article className="ops-metric-card">
              <span className="ops-metric-label">Journeys This Month</span>
              <strong>{journeyMetrics.monthCount}</strong>
            </article>
            <article className="ops-metric-card">
              <span className="ops-metric-label">Avg Journey</span>
              <strong>{formatDuration(journeyMetrics.averageDurationMs)}</strong>
            </article>
            <article className="ops-metric-card">
              <span className="ops-metric-label">Ad Plays / Journey</span>
              <strong>{journeyMetrics.adPlaysPerJourney}</strong>
            </article>
            <article className="ops-metric-card">
              <span className="ops-metric-label">Muted Cabs Right Now</span>
              <strong>{stats.silentScreens}</strong>
            </article>
          </div>
        </section>
      </div>

      <section className="card stack">
        <div className="card-header">
          <div>
            <span className="eyebrow">Recent Activity</span>
            <h2>Operational Timeline</h2>
          </div>
        </div>

        {activity.length === 0 ? (
          <div className="empty-state compact">
            <strong>No activity yet</strong>
            <p>Loop publishes, device syncs, and fleet operations will appear here.</p>
          </div>
        ) : (
          <div className="ops-timeline">
            {activity.map((event) => (
              <div className="ops-timeline-item" key={event.id}>
                <div className="ops-timeline-rail" />
                <div className="ops-timeline-body">
                  <div className="ops-timeline-head">
                    <strong>{event.message}</strong>
                    <StatusPill value={event.type} />
                  </div>
                  <p className="muted">{new Date(event.createdAt).toLocaleString()}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
