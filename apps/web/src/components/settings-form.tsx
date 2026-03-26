"use client";

import { useState } from "react";

type Props = {
  settings: {
    defaultFillerTemplate: Array<{ category: string; durationMs: number }>;
    syncIntervalSeconds: number;
    heartbeatIntervalSeconds: number;
    notificationEmails: string[];
  };
  users: Array<{
    id: string;
    name: string;
    email: string;
    role: string;
  }>;
};

export function SettingsForm({ settings, users }: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState({
    syncIntervalSeconds: String(settings.syncIntervalSeconds),
    heartbeatIntervalSeconds: String(settings.heartbeatIntervalSeconds),
    notificationEmails: settings.notificationEmails.join(", "),
    fillers: settings.defaultFillerTemplate,
  });

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        syncIntervalSeconds: Number(state.syncIntervalSeconds),
        heartbeatIntervalSeconds: Number(state.heartbeatIntervalSeconds),
        notificationEmails: state.notificationEmails
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        defaultFillerTemplate: state.fillers,
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Unable to save settings");
      setSaving(false);
      return;
    }

    window.location.reload();
  }

  return (
    <div className="stack-lg">
      <form className="card stack" onSubmit={handleSubmit}>
        <div className="card-header">
          <div>
            <span className="eyebrow">Core Settings</span>
            <h2>Defaults & Device Intervals</h2>
          </div>
        </div>

        <label className="field">
          <span>Sync interval (seconds)</span>
          <input
            type="number"
            value={state.syncIntervalSeconds}
            onChange={(event) =>
              setState((current) => ({
                ...current,
                syncIntervalSeconds: event.target.value,
              }))
            }
          />
        </label>

        <label className="field">
          <span>Heartbeat interval (seconds)</span>
          <input
            type="number"
            value={state.heartbeatIntervalSeconds}
            onChange={(event) =>
              setState((current) => ({
                ...current,
                heartbeatIntervalSeconds: event.target.value,
              }))
            }
          />
        </label>

        <label className="field">
          <span>Alert recipients</span>
          <input
            type="text"
            value={state.notificationEmails}
            onChange={(event) =>
              setState((current) => ({
                ...current,
                notificationEmails: event.target.value,
              }))
            }
            placeholder="ops@orisonscreens.com, jack@orisonscreens.com"
          />
        </label>

        <div className="stack">
          <strong>Default filler template</strong>
          <p className="muted">
            These durations control how long each filler item stays on screen inside the minute slot.
            If a weather or news filler is a static JPG/PNG, it will remain visible for this full
            duration before the loop advances to the next filler item. Enter the duration in
            milliseconds.
          </p>
          {state.fillers.map((item, index) => (
            <div className="inline-form" key={`${item.category}-${index}`}>
              <select
                value={item.category}
                onChange={(event) =>
                  setState((current) => ({
                    ...current,
                    fillers: current.fillers.map((filler, fillerIndex) =>
                      fillerIndex === index
                        ? {
                            ...filler,
                            category: event.target.value,
                          }
                        : filler,
                    ),
                  }))
                }
              >
                <option value="FILLER_WEATHER">FILLER_WEATHER</option>
                <option value="FILLER_NEWS">FILLER_NEWS</option>
                <option value="FILLER_BRANDED">FILLER_BRANDED</option>
                <option value="FILLER_OTHER">FILLER_OTHER</option>
              </select>
              <input
                type="number"
                min={1000}
                value={item.durationMs}
                onChange={(event) =>
                  setState((current) => ({
                    ...current,
                    fillers: current.fillers.map((filler, fillerIndex) =>
                      fillerIndex === index
                        ? {
                            ...filler,
                            durationMs: Math.max(Number(event.target.value) || 0, 1000),
                          }
                        : filler,
                    ),
                  }))
                }
              />
              <button
                className="button button-secondary"
                onClick={() =>
                  setState((current) => ({
                    ...current,
                    fillers: current.fillers.filter((_, fillerIndex) => fillerIndex !== index),
                  }))
                }
                type="button"
              >
                Remove
              </button>
            </div>
          ))}
          <button
            className="button button-secondary"
            onClick={() =>
              setState((current) => ({
                ...current,
                fillers: [
                  ...current.fillers,
                  {
                    category: "FILLER_OTHER",
                    durationMs: 5000,
                  },
                ],
              }))
            }
            type="button"
          >
            Add filler step
          </button>
        </div>

        {error ? <div className="alert alert-danger">{error}</div> : null}

        <button className="button button-primary" disabled={saving} type="submit">
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </form>

      <div className="card stack">
        <div className="card-header">
          <div>
            <span className="eyebrow">Users</span>
            <h2>Internal Operators</h2>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{user.name}</td>
                  <td>{user.email}</td>
                  <td>{user.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted">
          Device API keys are handled via the server environment and per-device token hashes.
        </p>
      </div>
    </div>
  );
}
