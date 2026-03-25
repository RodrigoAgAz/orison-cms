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
                value={item.durationMs}
                onChange={(event) =>
                  setState((current) => ({
                    ...current,
                    fillers: current.fillers.map((filler, fillerIndex) =>
                      fillerIndex === index
                        ? {
                            ...filler,
                            durationMs: Number(event.target.value),
                          }
                        : filler,
                    ),
                  }))
                }
              />
            </div>
          ))}
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

