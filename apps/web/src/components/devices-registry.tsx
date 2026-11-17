"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Modal } from "@/components/modal";
import { PaginationControls } from "@/components/pagination-controls";
import { StatusDot } from "@/components/status-dot";
import { useToast } from "@/components/toast-provider";
import { formatSignal, screenActivityLabel } from "@/lib/device-status";
import { formatLondonDateTime } from "@/lib/london-time";

type DeviceItem = {
  id: string;
  serialNumber: string;
  cabLicenseNumber: string | null;
  driverName: string | null;
  hpTaxiCabId: string | null;
  groupId: string | null;
  isActive: boolean;
  isDisabled: boolean;
  disabledReason: string | null;
  status: "online" | "outdated" | "offline" | "inactive";
  online: boolean;
  currentLoopId: string | null;
  currentLoopName: string | null;
  expectedLoopId: string | null;
  expectedLoopName: string | null;
  expectedSourceLabel: string | null;
  sync: {
    state: "failing" | "downloading" | "waiting" | "current" | "unknown";
    label: string;
    error: string | null;
    since: string | null;
    nextRetryAt: string | null;
    failedLoopName: string | null;
  };
  lastSyncAt: string | null;
  lastHeartbeatAt: string | null;
  playerStatusNow: string | null;
  playerStateNow: string | null;
  playbackTrigger: string | null;
  signalPercent: number | null;
  signalDbm: number | null;
  networkType: string | null;
  storageFreeMb: number | null;
  firmwareVersion: string | null;
};

type DeviceGroup = {
  id: string;
  name: string;
  description: string | null;
  _count: {
    devices: number;
  };
};

type Props = {
  devices: DeviceItem[];
  groups: DeviceGroup[];
  fleetControl: {
    disabled: boolean;
    reason: string | null;
  };
  selectedGroupId: string;
  page: number;
  pageSize: number;
  total: number;
};

const statusLabels: Record<DeviceItem["status"], string> = {
  online: "Online",
  outdated: "Online, updating",
  offline: "Offline",
  inactive: "Inactive",
};

function triggerLabel(trigger: string | null) {
  switch (trigger) {
    case "always":
      return "Plays continuously (no passenger detection)";
    case "keyboard":
      return "Journeys start from a key press";
    default:
      return "Journeys start from the button/door input";
  }
}

async function errorMessage(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export function DevicesRegistry({ devices, groups, fleetControl, selectedGroupId, page, pageSize, total }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [registerOpen, setRegisterOpen] = useState(false);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [groupSaving, setGroupSaving] = useState(false);
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);
  const [fleetBusy, setFleetBusy] = useState(false);
  const [form, setForm] = useState({
    serialNumber: "",
    cabLicenseNumber: "",
    driverName: "",
    hpTaxiCabId: "",
    notes: "",
  });
  const [groupForm, setGroupForm] = useState({
    name: "",
    description: "",
  });

  function refreshPage() {
    router.refresh();
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);

    const response = await fetch("/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serialNumber: form.serialNumber,
        cabLicenseNumber: form.cabLicenseNumber || null,
        driverName: form.driverName || null,
        hpTaxiCabId: form.hpTaxiCabId || null,
        notes: form.notes || null,
      }),
    });

    if (!response.ok) {
      toast({
        title: "Cab not registered",
        message: await errorMessage(response, "Unable to register the cab."),
        tone: "error",
      });
      setSaving(false);
      return;
    }

    toast({
      title: "Cab registered",
      message: `${form.serialNumber} is now in the list of cabs.`,
      tone: "success",
    });
    setRegisterOpen(false);
    setSaving(false);
    setForm({ serialNumber: "", cabLicenseNumber: "", driverName: "", hpTaxiCabId: "", notes: "" });
    refreshPage();
  }

  async function createGroup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setGroupSaving(true);

    const response = await fetch("/api/device-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: groupForm.name, description: groupForm.description || null }),
    });

    if (!response.ok) {
      toast({
        title: "Group not created",
        message: await errorMessage(response, "Unable to create the group."),
        tone: "error",
      });
      setGroupSaving(false);
      return;
    }

    toast({
      title: "Group created",
      message: `${groupForm.name} can now be chosen for cabs.`,
      tone: "success",
    });
    setGroupForm({ name: "", description: "" });
    setGroupModalOpen(false);
    setGroupSaving(false);
    refreshPage();
  }

  async function renameGroup(group: DeviceGroup) {
    const nextName = window.prompt("Group name", group.name)?.trim();
    if (!nextName || nextName === group.name) {
      return;
    }

    const nextDescription = window.prompt("Optional description", group.description ?? "") ?? group.description;

    const response = await fetch(`/api/device-groups/${group.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nextName, description: nextDescription?.trim() || null }),
    });

    if (!response.ok) {
      toast({
        title: "Group not renamed",
        message: await errorMessage(response, "Unable to update the group."),
        tone: "error",
      });
      return;
    }

    toast({ title: "Group renamed", message: `${group.name} is now ${nextName}.`, tone: "success" });
    refreshPage();
  }

  async function deleteGroup(group: DeviceGroup) {
    const confirmed = window.confirm(`Delete group "${group.name}"?`);
    if (!confirmed) {
      return;
    }

    const response = await fetch(`/api/device-groups/${group.id}`, { method: "DELETE" });

    if (!response.ok) {
      toast({
        title: "Group not deleted",
        message: await errorMessage(response, "Unable to delete the group."),
        tone: "error",
      });
      return;
    }

    toast({ title: "Group deleted", message: `${group.name} was removed.`, tone: "success" });
    refreshPage();
  }

  async function assignGroup(deviceId: string, groupId: string) {
    setBusyDeviceId(deviceId);

    const response = await fetch(`/api/devices/${deviceId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: groupId || null }),
    });

    if (!response.ok) {
      toast({
        title: "Group not changed",
        message: await errorMessage(response, "Unable to change the cab's group."),
        tone: "error",
      });
      setBusyDeviceId(null);
      return;
    }

    toast({ title: "Group changed", message: "The cab's group was saved.", tone: "success" });
    setBusyDeviceId(null);
    refreshPage();
  }

  async function toggleDeviceDisabled(device: DeviceItem) {
    let reason: string | null = null;
    if (!device.isDisabled) {
      reason = window.prompt("Reason for pausing (optional)", device.disabledReason ?? "");
      if (reason === null) {
        return;
      }
    }
    setBusyDeviceId(device.id);

    try {
      const response = device.isDisabled
        ? await fetch(`/api/devices/${device.id}/enable`, { method: "PUT" })
        : await fetch(`/api/devices/${device.id}/disable`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: reason?.trim() || null }),
          });

      if (!response.ok) {
        throw new Error(
          await errorMessage(response, device.isDisabled ? "Unable to resume the cab." : "Unable to pause the cab."),
        );
      }

      toast(
        device.isDisabled
          ? { title: "Cab resumed", message: `${device.serialNumber} plays again from its next heartbeat.`, tone: "success" }
          : { title: "Cab paused", message: `${device.serialNumber} stops playing at its next heartbeat.`, tone: "success" },
      );
      refreshPage();
    } catch (error) {
      toast({
        title: "Cab not changed",
        message: error instanceof Error ? error.message : "Unable to change the cab.",
        tone: "error",
      });
    } finally {
      setBusyDeviceId(null);
    }
  }

  async function toggleFleetDisabled() {
    let reason: string | null = null;
    if (!fleetControl.disabled) {
      reason = window.prompt("Reason for pausing all cabs (optional)", fleetControl.reason ?? "");
      if (reason === null) {
        return;
      }
    }
    setFleetBusy(true);

    try {
      const response = fleetControl.disabled
        ? await fetch("/api/devices/enable-all", { method: "PUT" })
        : await fetch("/api/devices/disable-all", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: reason?.trim() || null }),
          });

      if (!response.ok) {
        throw new Error(
          await errorMessage(response, fleetControl.disabled ? "Unable to resume all cabs." : "Unable to pause all cabs."),
        );
      }

      toast(
        fleetControl.disabled
          ? { title: "All cabs resumed", message: "Cabs play again from their next heartbeat.", tone: "success" }
          : { title: "All cabs paused", message: "Every cab stops playing at its next heartbeat.", tone: "success" },
      );
      refreshPage();
    } catch (error) {
      toast({
        title: "Pause not changed",
        message: error instanceof Error ? error.message : "Unable to change the pause.",
        tone: "error",
      });
    } finally {
      setFleetBusy(false);
    }
  }

  function applyGroupFilter(nextGroupId: string) {
    const params = new URLSearchParams();
    if (nextGroupId && nextGroupId !== "ALL") {
      params.set("group", nextGroupId);
    }
    router.push(params.toString() ? `/devices?${params.toString()}` : "/devices");
  }

  return (
    <div className="stack-lg">
      <div className="card stack">
        <div className="card-header">
          <div>
            <span className="eyebrow">Groups</span>
            <h2>Groups of cabs</h2>
          </div>
          <div className="button-row">
            <button className="button button-secondary" onClick={() => setGroupModalOpen(true)} type="button">
              Create group
            </button>
            <button
              className={fleetControl.disabled ? "button button-secondary" : "button button-danger"}
              disabled={fleetBusy}
              onClick={() => void toggleFleetDisabled()}
              type="button"
            >
              {fleetBusy ? (
                <span className="button-inline">
                  <span aria-hidden className="button-spinner" />
                  Working
                </span>
              ) : fleetControl.disabled ? (
                "Resume all cabs"
              ) : (
                "Pause all cabs"
              )}
            </button>
          </div>
        </div>

        {fleetControl.disabled ? (
          <div className="alert alert-warning">
            All cabs are paused{fleetControl.reason ? `: ${fleetControl.reason}` : "."}
          </div>
        ) : null}

        {groups.length === 0 ? (
          <div className="empty-state compact">
            <strong>No groups yet</strong>
            <p>A group lets a set of cabs play its own loop. Create one, then choose it for cabs in the table below.</p>
          </div>
        ) : (
          <div className="chart-list">
            {groups.map((group) => (
              <div className="activity-item" key={group.id}>
                <div>
                  <strong>{group.name}</strong>
                  <div className="muted">
                    {group.description || "No description"} / {group._count.devices} cab
                    {group._count.devices === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="button-row">
                  <button className="button button-secondary" onClick={() => void renameGroup(group)} type="button">
                    Rename
                  </button>
                  <button className="button button-danger" onClick={() => void deleteGroup(group)} type="button">
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card stack">
        <div className="card-header">
          <div>
            <span className="eyebrow">Cabs</span>
            <h2>Every cab</h2>
          </div>
          <div className="button-row">
            <label className="field compact-field">
              <span>Show</span>
              <select value={selectedGroupId} onChange={(event) => applyGroupFilter(event.target.value)}>
                <option value="ALL">All cabs</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="button button-primary" onClick={() => setRegisterOpen(true)} type="button">
              Register a cab
            </button>
          </div>
        </div>

        {devices.length === 0 ? (
          <div className="empty-state">
            <strong>No cabs yet</strong>
            <p>
              A cab appears here by itself when it sends its first heartbeat. You can also register one in advance with
              its serial number.
            </p>
            <button className="button button-primary" onClick={() => setRegisterOpen(true)} type="button">
              Register a cab
            </button>
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="data-table cab-table">
                <thead>
                  <tr>
                    <th>Cab</th>
                    <th>Status</th>
                    <th>Group</th>
                    <th>Loop</th>
                    <th>Update</th>
                    <th>Screen</th>
                    <th>Signal / storage</th>
                  </tr>
                </thead>
                <tbody>
                  {devices.map((device) => (
                    <tr key={device.id}>
                      <td>
                        <div className="cab-cell-lines">
                          <strong>{device.serialNumber}</strong>
                          <span className="muted">Licence {device.cabLicenseNumber ?? "not set"}</span>
                          {device.driverName ? <span className="muted">Driver {device.driverName}</span> : null}
                          {device.hpTaxiCabId ? <span className="muted">HP Taxi ID {device.hpTaxiCabId}</span> : null}
                        </div>
                      </td>
                      <td>
                        <div className="cab-cell-lines">
                          <StatusDot label={statusLabels[device.status]} status={device.status} />
                          {device.isDisabled ? (
                            <span className="text-warning">
                              Paused{device.disabledReason ? `: ${device.disabledReason}` : ""}
                            </span>
                          ) : null}
                          <span className="muted">Last heartbeat {formatLondonDateTime(device.lastHeartbeatAt)}</span>
                          <button
                            className={`cab-pause-button ${device.isDisabled ? "button button-secondary" : "button button-danger"}`}
                            disabled={busyDeviceId === device.id}
                            onClick={() => void toggleDeviceDisabled(device)}
                            type="button"
                          >
                            {busyDeviceId === device.id ? (
                              <span className="button-inline">
                                <span aria-hidden className="button-spinner" />
                                Working
                              </span>
                            ) : device.isDisabled ? (
                              "Resume"
                            ) : (
                              "Pause"
                            )}
                          </button>
                        </div>
                      </td>
                      <td>
                        <select
                          className="cab-group-select"
                          disabled={busyDeviceId === device.id}
                          onChange={(event) => void assignGroup(device.id, event.target.value)}
                          value={device.groupId ?? ""}
                        >
                          <option value="">No group</option>
                          {groups.map((group) => (
                            <option key={group.id} value={group.id}>
                              {group.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <div className="cab-cell-lines">
                          <span>
                            Plays{" "}
                            {device.currentLoopName ??
                              (device.currentLoopId ? "a loop that no longer exists" : "nothing yet")}
                          </span>
                          <span className="muted">
                            {device.expectedLoopId && device.currentLoopId === device.expectedLoopId
                              ? `As it should (${device.expectedSourceLabel ?? "assigned"})`
                              : `Should play ${device.expectedLoopName ?? "nothing"}${
                                  device.expectedSourceLabel ? ` (${device.expectedSourceLabel})` : ""
                                }`}
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="cab-cell-lines">
                          <span className={device.sync.state === "failing" ? "text-danger" : undefined}>
                            {device.sync.label}
                          </span>
                          {device.sync.state === "failing" ? (
                            <span className="text-danger">
                              {device.sync.failedLoopName ? `${device.sync.failedLoopName}: ` : ""}
                              {device.sync.error}
                            </span>
                          ) : null}
                          {device.sync.state === "failing" && device.sync.nextRetryAt ? (
                            <span className="muted">Tries again {formatLondonDateTime(device.sync.nextRetryAt)}</span>
                          ) : null}
                          {device.sync.state === "waiting" ? (
                            <span className="muted">This cab&apos;s firmware does not report why.</span>
                          ) : null}
                          <span className="muted">Last updated {formatLondonDateTime(device.lastSyncAt, "never recorded")}</span>
                        </div>
                      </td>
                      <td>
                        <div className="cab-cell-lines">
                          <span>{screenActivityLabel(device.playerStatusNow, device.playbackTrigger, device.online, device.playerStateNow)}</span>
                          <span className="muted">{triggerLabel(device.playbackTrigger)}</span>
                        </div>
                      </td>
                      <td>
                        <div className="cab-cell-lines">
                          <span>
                            {formatSignal(device.signalPercent, device.signalDbm)}
                            {device.networkType && device.networkType !== "unknown" ? ` · ${device.networkType}` : ""}
                          </span>
                          <span className="muted">
                            {typeof device.storageFreeMb === "number" ? `${device.storageFreeMb} MB free` : "Storage unknown"}
                          </span>
                          <span className="muted">Firmware {device.firmwareVersion ?? "unknown"}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <PaginationControls
              page={page}
              pageSize={pageSize}
              pathname="/devices"
              query={selectedGroupId !== "ALL" ? { group: selectedGroupId } : undefined}
              total={total}
            />
            <p className="muted small-print">Times are London time.</p>
          </>
        )}
      </div>

      {registerOpen ? (
        <Modal eyebrow="Cabs" onClose={() => setRegisterOpen(false)} title="Register a cab">
          <form className="stack" onSubmit={handleSubmit}>
            <div className="asset-upload-grid">
              <label className="field">
                <span>Serial number</span>
                <input
                  onChange={(event) => setForm((current) => ({ ...current, serialNumber: event.target.value }))}
                  required
                  value={form.serialNumber}
                />
              </label>

              <label className="field">
                <span>Cab licence number</span>
                <input
                  onChange={(event) => setForm((current) => ({ ...current, cabLicenseNumber: event.target.value }))}
                  value={form.cabLicenseNumber}
                />
              </label>

              <label className="field">
                <span>Driver name</span>
                <input
                  onChange={(event) => setForm((current) => ({ ...current, driverName: event.target.value }))}
                  value={form.driverName}
                />
              </label>

              <label className="field">
                <span>HP Taxi cab ID</span>
                <input
                  onChange={(event) => setForm((current) => ({ ...current, hpTaxiCabId: event.target.value }))}
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
                {saving ? (
                  <span className="button-inline">
                    <span aria-hidden className="button-spinner" />
                    Registering cab
                  </span>
                ) : (
                  "Register cab"
                )}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {groupModalOpen ? (
        <Modal eyebrow="Groups" onClose={() => setGroupModalOpen(false)} title="Create a group">
          <form className="stack" onSubmit={createGroup}>
            <label className="field">
              <span>Group name</span>
              <input
                onChange={(event) => setGroupForm((current) => ({ ...current, name: event.target.value }))}
                required
                value={groupForm.name}
              />
            </label>

            <label className="field">
              <span>Description</span>
              <textarea
                onChange={(event) => setGroupForm((current) => ({ ...current, description: event.target.value }))}
                rows={4}
                value={groupForm.description}
              />
            </label>

            <div className="button-row">
              <button className="button button-primary" disabled={groupSaving} type="submit">
                {groupSaving ? (
                  <span className="button-inline">
                    <span aria-hidden className="button-spinner" />
                    Creating group
                  </span>
                ) : (
                  "Create group"
                )}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
