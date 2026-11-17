import { formatDistanceToNowStrict } from "date-fns";
import type { Route } from "next";
import Link from "next/link";

import { PageErrorNotice } from "@/components/page-error-notice";
import { StatusPill } from "@/components/status-pill";
import { requireUser } from "@/lib/auth";
import { formatSignal, screenActivityLabel } from "@/lib/device-status";
import { getDashboardData } from "@/lib/fleet-data";
import { formatLondonDateTime } from "@/lib/london-time";

function formatRelativeTime(value: Date | string | null | undefined, never = "never") {
  if (!value) {
    return never;
  }
  return formatDistanceToNowStrict(new Date(value), { addSuffix: true });
}

function formatDuration(valueMs: number | null) {
  if (valueMs === null) {
    return "n/a";
  }
  const totalSeconds = Math.round(valueMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function activityClass(status: string | null) {
  switch (status) {
    case "playing":
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
    attentionItems,
    cabs,
    error,
    fleetControl,
    fleetWideLoop,
    groupSummaries,
    journeyMetrics,
    liveLoops,
    passengerDetection,
    publishingLoops,
    safetyVideo,
    stats,
  } = await getDashboardData();

  const otherLiveLoops = liveLoops.filter((loop) => !loop.isFleet);

  return (
    <div className="page ops-dashboard">
      <section className="card ops-hero">
        <div className="ops-hero-copy">
          <span className="eyebrow">Dashboard</span>
          <h1>Orison cabs</h1>
          <p className="muted">What every cab is playing, whether it is up to date, and what needs attention.</p>
          <div className="ops-hero-meta">
            <span>
              All cabs play: <strong>{fleetWideLoop?.name ?? "no loop"}</strong>
            </span>
            <span>
              {fleetWideLoop?.publishedAt ? `Published ${formatRelativeTime(fleetWideLoop.publishedAt)}` : "Not published yet"}
            </span>
          </div>
        </div>

        <div className="button-row">
          <Link className="button button-primary" href="/loops">
            Open loops
          </Link>
          <Link className="button button-secondary" href="/devices">
            Open cabs
          </Link>
        </div>
      </section>

      <PageErrorNotice message={error} title="Dashboard data unavailable" />

      <section className="ops-command-strip">
        <article className="ops-command-card">
          <span className="ops-command-label">Cabs online now</span>
          <strong className="ops-command-value">
            {stats.onlineCount + stats.outdatedCount}/{stats.totalCabs}
          </strong>
          <p className="ops-command-note">
            {stats.outdatedCount} updating · {stats.offlineCount} offline
            {stats.syncFailingCount > 0 ? ` · ${stats.syncFailingCount} cannot update` : ""}
          </p>
        </article>

        <article className="ops-command-card">
          <span className="ops-command-label">On a journey now</span>
          <strong className="ops-command-value">{passengerDetection ? stats.onJourneyNow : "n/a"}</strong>
          <p className="ops-command-note">
            {passengerDetection
              ? `${stats.mutedNow} muted · ${stats.idleNow} waiting for a passenger (online cabs only)`
              : "No cab detects passengers: they play continuously"}
          </p>
        </article>

        <article className="ops-command-card">
          <span className="ops-command-label">Safety message</span>
          <strong className="ops-command-value is-copy">{safetyVideo ? "Set" : "Missing"}</strong>
          <p className="ops-command-note">
            {safetyVideo ? `${safetyVideo.filename} · ${formatDuration(safetyVideo.durationMs)}` : "Choose one in Settings"}
          </p>
        </article>

        <article className="ops-command-card">
          <span className="ops-command-label">Pause</span>
          <strong className="ops-command-value is-copy">{fleetControl.disabled ? "All cabs paused" : "Not paused"}</strong>
          <p className="ops-command-note">
            {fleetControl.disabled
              ? fleetControl.reason ?? "No reason given"
              : `${stats.pausedCount} cab${stats.pausedCount === 1 ? "" : "s"} paused individually`}
          </p>
        </article>

        <article className="ops-command-card">
          <span className="ops-command-label">Loops live</span>
          <strong className="ops-command-value">{liveLoops.length}</strong>
          <p className="ops-command-note">
            {fleetWideLoop ? "1 for all cabs" : "None for all cabs"} · {otherLiveLoops.length} for groups or single cabs
          </p>
        </article>

        <article className="ops-command-card">
          <span className="ops-command-label">Advert plays today</span>
          <strong className="ops-command-value">{stats.advertPlaysToday}</strong>
          <p className="ops-command-note">
            Video adverts played to passengers or continuously, since midnight (London) · {stats.stillShowingsToday} still
            showings
          </p>
        </article>
      </section>

      <div className="ops-main-grid">
        <section className="card ops-stage-card stack">
          <div className="card-header">
            <div>
              <span className="eyebrow">Cabs</span>
              <h2>What each cab is doing</h2>
            </div>
            <div className="button-row">
              <Link className="button button-secondary" href="/device-preview">
                Screen preview
              </Link>
            </div>
          </div>

          <div className="ops-group-strip">
            {groupSummaries.map((group) => (
              <Link className="ops-group-card" href={group.href as Route} key={group.id}>
                <div className="ops-group-top">
                  <div>
                    <strong>{group.name}</strong>
                    <p>{group.description ?? (group.id === "fleet-all" ? "Every cab" : "Group")}</p>
                  </div>
                  <span className="ops-group-count">{group.cabCount}</span>
                </div>
                <div className="ops-group-metrics">
                  <span>{group.onlineCount} online</span>
                  <span>{group.outdatedCount} updating</span>
                  <span>{group.offlineCount} offline</span>
                </div>
                <div className="ops-group-loop">
                  <span className="eyebrow">{group.id === "fleet-all" ? "Loop for all cabs" : "Group plays"}</span>
                  <strong>{group.loop?.name ?? "No loop"}</strong>
                </div>
              </Link>
            ))}
          </div>

          {cabs.length === 0 ? (
            <div className="empty-state">
              <strong>No cabs yet</strong>
              <p>A cab appears here by itself when it sends its first heartbeat, or register one on the Cabs page.</p>
              <Link className="button button-primary" href="/devices">
                Open cabs
              </Link>
            </div>
          ) : (
            <div className="ops-fleet-matrix">
              {cabs.map((cab) => (
                <article className={`ops-fleet-node is-${cab.status}`} key={cab.id}>
                  <div className="ops-fleet-node-top">
                    <div>
                      <strong>{cab.serialNumber}</strong>
                      <p>{cab.cabLicenseNumber ?? "No licence number"}</p>
                    </div>
                    <span
                      className={
                        cab.sync.state === "failing"
                          ? "dot dot-red"
                          : cab.status === "online"
                            ? "dot dot-green"
                            : cab.status === "outdated"
                              ? "dot dot-amber"
                              : cab.status === "offline"
                                ? "dot dot-red"
                                : "dot dot-grey"
                      }
                    />
                  </div>

                  <div className="ops-fleet-node-pills">
                    <StatusPill value={cab.status} />
                    <span className={activityClass(cab.playerStatusNow)}>
                      {screenActivityLabel(cab.playerStatusNow, cab.playbackTrigger, cab.online)}
                    </span>
                    <span className="ops-mini-chip">{cab.group?.name ?? "No group"}</span>
                  </div>

                  <dl className="ops-node-meta">
                    <div>
                      <dt>Should play</dt>
                      <dd>
                        {cab.expectedLoopName ?? "No loop"}
                        {cab.expectedSourceLabel ? ` (${cab.expectedSourceLabel})` : ""}
                      </dd>
                    </div>
                    <div>
                      <dt>Update</dt>
                      <dd className={cab.sync.state === "failing" ? "text-danger" : undefined}>
                        {cab.sync.state === "failing" ? `Failing: ${cab.sync.error}` : cab.sync.label}
                      </dd>
                    </div>
                    <div>
                      <dt>Last heartbeat</dt>
                      <dd>{formatRelativeTime(cab.lastHeartbeatAt)}</dd>
                    </div>
                    <div>
                      <dt>Signal / storage</dt>
                      <dd>
                        {formatSignal(cab.signalPercent, cab.signalDbm)} ·{" "}
                        {typeof cab.storageFreeMb === "number" ? `${cab.storageFreeMb} MB free` : "storage unknown"}
                      </dd>
                    </div>
                  </dl>

                  {cab.isDisabled ? (
                    <div className="ops-node-alert">Paused{cab.disabledReason ? `: ${cab.disabledReason}` : ""}</div>
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
                <span className="eyebrow">Needs a look</span>
                <h2>What needs action</h2>
              </div>
            </div>

            {attentionItems.length === 0 ? (
              <div className="empty-state compact">
                <strong>Nothing needs action</strong>
                <p>Every cab is online and up to date.</p>
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
              <span className="eyebrow">Loops</span>
              <h2>What is live where</h2>
            </div>
          </div>

          <div className="ops-programme-grid">
            <article className="ops-programme-panel">
              <span className="eyebrow">All cabs</span>
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
                  <strong>No loop for all cabs</strong>
                  <p>Cabs outside a group with its own loop have nothing to play.</p>
                </div>
              )}
            </article>

            <article className="ops-programme-panel">
              <span className="eyebrow">Groups and single cabs</span>
              {otherLiveLoops.length === 0 ? (
                <div className="empty-state compact">
                  <strong>None</strong>
                  <p>Every cab plays the loop for all cabs.</p>
                </div>
              ) : (
                <div className="ops-programme-list">
                  {otherLiveLoops.map((loop) => (
                    <Link className="ops-programme-row" href={`/loops/${loop.id}` as Route} key={`${loop.id}-${loop.audience}`}>
                      <div>
                        <strong>{loop.name}</strong>
                        <p>{loop.audience}</p>
                      </div>
                      <span>{loop.publishedAt ? formatRelativeTime(loop.publishedAt) : "Live"}</span>
                    </Link>
                  ))}
                </div>
              )}
            </article>

            <article className="ops-programme-panel">
              <span className="eyebrow">Being published</span>
              {publishingLoops.length === 0 ? (
                <div className="empty-state compact">
                  <strong>Nothing is being published</strong>
                  <p>Loops appear here while they compile.</p>
                </div>
              ) : (
                <div className="ops-programme-list">
                  {publishingLoops.map((loop) => (
                    <Link className="ops-programme-row" href={`/loops/${loop.id}` as Route} key={loop.id}>
                      <div>
                        <strong>{loop.name}</strong>
                        <p>{loop.targetGroup?.name ?? "All cabs"}</p>
                      </div>
                      <span>{formatRelativeTime(loop.updatedAt)}</span>
                    </Link>
                  ))}
                </div>
              )}
            </article>

            <article className="ops-programme-panel">
              <span className="eyebrow">Go to</span>
              <div className="ops-quick-actions">
                <Link className="button button-secondary" href="/assets">
                  Assets
                </Link>
                <Link className="button button-secondary" href="/analytics">
                  Analytics
                </Link>
                <Link className="button button-secondary" href="/settings">
                  Settings
                </Link>
              </div>
            </article>
          </div>
        </section>

        <section className="card stack">
          <div className="card-header">
            <div>
              <span className="eyebrow">Journeys</span>
              <h2>Passenger journeys</h2>
            </div>
          </div>

          {passengerDetection ? (
            <div className="ops-journey-grid">
              <article className="ops-metric-card">
                <span className="ops-metric-label">Today</span>
                <strong>{journeyMetrics.today}</strong>
              </article>
              <article className="ops-metric-card">
                <span className="ops-metric-label">This week</span>
                <strong>{journeyMetrics.week}</strong>
              </article>
              <article className="ops-metric-card">
                <span className="ops-metric-label">This month</span>
                <strong>{journeyMetrics.month}</strong>
              </article>
              <article className="ops-metric-card">
                <span className="ops-metric-label">Average journey (30 days)</span>
                <strong>{formatDuration(journeyMetrics.averageDurationMs)}</strong>
              </article>
              <article className="ops-metric-card">
                <span className="ops-metric-label">Advert plays per journey</span>
                <strong>{journeyMetrics.advertPlaysPerJourney ?? "n/a"}</strong>
              </article>
              <article className="ops-metric-card">
                <span className="ops-metric-label">Muted cabs now</span>
                <strong>{stats.mutedNow}</strong>
              </article>
            </div>
          ) : (
            <div className="empty-state compact">
              <strong>Not applicable</strong>
              <p>No cab has passenger detection: they play the loop continuously, so there are no journeys to count.</p>
            </div>
          )}
          <p className="muted small-print">
            Days and weeks are London time (weeks start on Monday). Only cabs with passenger detection record journeys.
          </p>
        </section>
      </div>

      <section className="card stack">
        <div className="card-header">
          <div>
            <span className="eyebrow">Recent activity</span>
            <h2>What happened</h2>
          </div>
        </div>

        {activity.length === 0 ? (
          <div className="empty-state compact">
            <strong>No activity yet</strong>
            <p>Publishes, cab updates and pauses will appear here.</p>
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
                  <p className="muted">{formatLondonDateTime(event.createdAt)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
