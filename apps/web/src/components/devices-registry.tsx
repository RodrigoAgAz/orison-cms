"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Modal } from "@/components/modal";
import { StatusDot } from "@/components/status-dot";
import { useToast } from "@/components/toast-provider";

type DeviceItem = {
  id: string;
  serialNumber: string;
  cabLicenseNumber: string | null;
  driverName: string | null;
  currentLoopId: string | null;
  lastSyncAt: string | null;
  lastHeartbeatAt: string | null;
  storageFreeMb: number | null;
  hpTaxiCabId: string | null;
  notes: string | null;
  isActive: boolean;
  status: "online" | "outdated" | "offline" | "inactive";
  heartbeats: Array<{
    id: string;
    receivedAt: string;
    playerStatus: string | null;
    networkType: string | null;
    signalStrength: number | null;
  }>;
};

type Props = {
  devices: DeviceItem[];
  publishedLoopId: string | null;
};

export function DevicesRegistry({ devices, publishedLoopId }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [registerOpen, setRegisterOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    serialNumber: "",
    cabLicenseNumber: "",
    driverName: "",
    hpTaxiCabId: "",
    notes: "",
  });

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);

    const response = await fetch("/api/devices", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        serialNumber: form.serialNumber,
        cabLicenseNumber: form.cabLicenseNumber || null,
        driverName: form.driverName || null,
        hpTaxiCabId: form.hpTaxiCabId || null,
        notes: form.notes || null,
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      toast({
        title: "Device registration failed",
        message: body?.error ?? "Unable to register the device.",
        tone: "error",
      });
      setSaving(false);
      return;
    }

    toast({
      title: "Device registered",
      message: `${form.serialNumber} is now in the fleet registry.`,
      tone: "success",
    });
    setRegisterOpen(false);
    setSaving(false);
    setForm({
      serialNumber: "",
      cabLicenseNumber: "",
      driverName: "",
      hpTaxiCabId: "",
      notes: "",
    });
    router.refresh();
  }

  return (
    <div className="card stack">
      <div className="card-header">
        <div>
          <span className="eyebrow">Device Registry</span>
          <h2>Cab Units</h2>
        </div>
        <button className="button button-primary" onClick={() => setRegisterOpen(true)} type="button">
          Register Device
        </button>
      </div>

      {devices.length === 0 ? (
        <div className="empty-state">
          <strong>No devices registered yet</strong>
          <p>Add your first cab screen unit to start tracking sync, heartbeats, and storage.</p>
          <button
            className="button button-primary"
            onClick={() => setRegisterOpen(true)}
            type="button"
          >
            Register the first device
          </button>
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Serial</th>
                  <th>Cab License</th>
                  <th>Driver</th>
                  <th>Status</th>
                  <th>Current Loop</th>
                  <th>Last Sync</th>
                  <th>Last Heartbeat</th>
                  <th>Storage Free</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((device) => {
                  return (
                    <tr key={device.id}>
                      <td>
                        <strong>{device.serialNumber}</strong>
                        {device.hpTaxiCabId ? (
                          <div className="muted">HP Taxi ID: {device.hpTaxiCabId}</div>
                        ) : null}
                      </td>
                      <td>{device.cabLicenseNumber ?? "n/a"}</td>
                      <td>{device.driverName ?? "n/a"}</td>
                      <td>
                        <StatusDot label={device.status} status={device.status} />
                      </td>
                      <td>
                        {device.currentLoopId
                          ? device.currentLoopId === publishedLoopId
                            ? "Current published loop"
                            : device.currentLoopId
                          : "None"}
                      </td>
                      <td>{device.lastSyncAt ? new Date(device.lastSyncAt).toLocaleString() : "Never"}</td>
                      <td>
                        {device.lastHeartbeatAt
                          ? new Date(device.lastHeartbeatAt).toLocaleString()
                          : "Never"}
                      </td>
                      <td>{device.storageFreeMb ? `${device.storageFreeMb} MB` : "n/a"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="stack">
            {devices.slice(0, 5).map((device) => (
              <div className="card inset-card" key={`${device.id}-heartbeats`}>
                <strong>{device.serialNumber} recent heartbeats</strong>
                <div className="chart-list">
                  {device.heartbeats.length === 0 ? (
                    <span className="muted">No heartbeat data yet.</span>
                  ) : (
                    device.heartbeats.map((heartbeat) => (
                      <div className="activity-item" key={heartbeat.id}>
                        <strong>{new Date(heartbeat.receivedAt).toLocaleString()}</strong>
                        <div className="muted">
                          {heartbeat.playerStatus ?? "unknown"} / {heartbeat.networkType ?? "unknown"} /
                          {heartbeat.signalStrength ?? "n/a"} dBm
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {registerOpen ? (
        <Modal eyebrow="Fleet" onClose={() => setRegisterOpen(false)} title="Register device">
          <form className="stack" onSubmit={handleSubmit}>
            <div className="asset-upload-grid">
              <label className="field">
                <span>Serial Number</span>
                <input
                  onChange={(event) =>
                    setForm((current) => ({ ...current, serialNumber: event.target.value }))
                  }
                  required
                  value={form.serialNumber}
                />
              </label>

              <label className="field">
                <span>Cab License Number</span>
                <input
                  onChange={(event) =>
                    setForm((current) => ({ ...current, cabLicenseNumber: event.target.value }))
                  }
                  value={form.cabLicenseNumber}
                />
              </label>

              <label className="field">
                <span>Driver Name</span>
                <input
                  onChange={(event) =>
                    setForm((current) => ({ ...current, driverName: event.target.value }))
                  }
                  value={form.driverName}
                />
              </label>

              <label className="field">
                <span>HP Taxi Cab ID</span>
                <input
                  onChange={(event) =>
                    setForm((current) => ({ ...current, hpTaxiCabId: event.target.value }))
                  }
                  value={form.hpTaxiCabId}
                />
              </label>
            </div>

            <label className="field">
              <span>Notes</span>
              <textarea
                onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
                rows={4}
                value={form.notes}
              />
            </label>

            <div className="button-row">
              <button className="button button-primary" disabled={saving} type="submit">
                {saving ? "Registering..." : "Register Device"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
