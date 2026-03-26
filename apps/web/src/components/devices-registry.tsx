"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Modal } from "@/components/modal";
import { PaginationControls } from "@/components/pagination-controls";
import { StatusDot } from "@/components/status-dot";
import { useToast } from "@/components/toast-provider";

type DeviceItem = {
  id: string;
  serialNumber: string;
  cabLicenseNumber: string | null;
  driverName: string | null;
  currentLoopId: string | null;
  expectedLoopId: string | null;
  lastSyncAt: string | null;
  lastHeartbeatAt: string | null;
  storageFreeMb: number | null;
  hpTaxiCabId: string | null;
  notes: string | null;
  isActive: boolean;
  isDisabled: boolean;
  disabledReason: string | null;
  groupId: string | null;
  group: {
    id: string;
    name: string;
  } | null;
  status: "online" | "outdated" | "offline" | "inactive";
  heartbeats: Array<{
    id: string;
    receivedAt: string;
    playerStatus: string | null;
    networkType: string | null;
    signalStrength: number | null;
  }>;
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
  publishedLoopId: string | null;
  fleetControl: {
    disabled: boolean;
    reason: string | null;
  };
  selectedGroupId: string;
  page: number;
  pageSize: number;
  total: number;
};

export function DevicesRegistry({
  devices,
  groups,
  publishedLoopId,
  fleetControl,
  selectedGroupId,
  page,
  pageSize,
  total,
}: Props) {
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
    refreshPage();
  }

  async function createGroup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setGroupSaving(true);

    const response = await fetch("/api/device-groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: groupForm.name,
        description: groupForm.description || null,
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      toast({
        title: "Group creation failed",
        message: body?.error ?? "Unable to create the device group.",
        tone: "error",
      });
      setGroupSaving(false);
      return;
    }

    toast({
      title: "Group created",
      message: `${groupForm.name} is available for device assignment.`,
      tone: "success",
    });
    setGroupForm({
      name: "",
      description: "",
    });
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
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: nextName,
        description: nextDescription?.trim() || null,
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      toast({
        title: "Group update failed",
        message: body?.error ?? "Unable to update the group.",
        tone: "error",
      });
      return;
    }

    toast({
      title: "Group updated",
      message: `${group.name} was updated.`,
      tone: "success",
    });
    refreshPage();
  }

  async function deleteGroup(group: DeviceGroup) {
    const confirmed = window.confirm(`Delete group "${group.name}"?`);
    if (!confirmed) {
      return;
    }

    const response = await fetch(`/api/device-groups/${group.id}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      toast({
        title: "Group deletion failed",
        message: body?.error ?? "Unable to delete the group.",
        tone: "error",
      });
      return;
    }

    toast({
      title: "Group deleted",
      message: `${group.name} was removed.`,
      tone: "success",
    });
    refreshPage();
  }

  async function assignGroup(deviceId: string, groupId: string) {
    setBusyDeviceId(deviceId);

    const response = await fetch(`/api/devices/${deviceId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        groupId: groupId || null,
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      toast({
        title: "Device update failed",
        message: body?.error ?? "Unable to update the device group.",
        tone: "error",
      });
      setBusyDeviceId(null);
      return;
    }

    toast({
      title: "Device updated",
      message: "Group assignment saved.",
      tone: "success",
    });
    setBusyDeviceId(null);
    refreshPage();
  }

  async function toggleDeviceDisabled(device: DeviceItem) {
    setBusyDeviceId(device.id);

    try {
      if (device.isDisabled) {
        const response = await fetch(`/api/devices/${device.id}/enable`, {
          method: "PUT",
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? "Unable to enable the device.");
        }

        toast({
          title: "Device enabled",
          message: `${device.serialNumber} can receive playback again.`,
          tone: "success",
        });
      } else {
        const reason = window.prompt("Disable reason (optional)", device.disabledReason ?? "") ?? "";
        const response = await fetch(`/api/devices/${device.id}/disable`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            reason: reason.trim() || null,
          }),
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? "Unable to disable the device.");
        }

        toast({
          title: "Device disabled",
          message: `${device.serialNumber} was disabled remotely.`,
          tone: "success",
        });
      }

      refreshPage();
    } catch (error) {
      toast({
        title: "Device update failed",
        message: error instanceof Error ? error.message : "Unable to update the device.",
        tone: "error",
      });
    } finally {
      setBusyDeviceId(null);
    }
  }

  async function toggleFleetDisabled() {
    setFleetBusy(true);

    try {
      if (fleetControl.disabled) {
        const response = await fetch("/api/devices/enable-all", {
          method: "PUT",
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? "Unable to enable the fleet.");
        }

        toast({
          title: "Fleet enabled",
          message: "All devices can resume playback.",
          tone: "success",
        });
      } else {
        const reason = window.prompt("Disable all devices reason (optional)", fleetControl.reason ?? "") ?? "";
        const response = await fetch("/api/devices/disable-all", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            reason: reason.trim() || null,
          }),
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? "Unable to disable the fleet.");
        }

        toast({
          title: "Fleet disabled",
          message: "The emergency kill-switch is now active.",
          tone: "success",
        });
      }

      refreshPage();
    } catch (error) {
      toast({
        title: "Fleet update failed",
        message: error instanceof Error ? error.message : "Unable to change fleet state.",
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
            <h2>Fleet Segments</h2>
          </div>
          <div className="button-row">
            <button className="button button-secondary" onClick={() => setGroupModalOpen(true)} type="button">
              Create Group
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
                "Enable All Devices"
              ) : (
                "Disable All Devices"
              )}
            </button>
          </div>
        </div>

        {fleetControl.disabled ? (
          <div className="alert alert-warning">
            Fleet kill-switch active{fleetControl.reason ? `: ${fleetControl.reason}` : "."}
          </div>
        ) : null}

        {groups.length === 0 ? (
          <div className="empty-state compact">
            <strong>No device groups yet</strong>
            <p>Create named fleet segments like Airport Runs or HP Fleet A, then assign cabs from the table below.</p>
          </div>
        ) : (
          <div className="chart-list">
            {groups.map((group) => (
              <div className="activity-item" key={group.id}>
                <div>
                  <strong>{group.name}</strong>
                  <div className="muted">
                    {group.description || "No description"} / {group._count.devices} device
                    {group._count.devices === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="button-row">
                  <button
                    className="button button-secondary"
                    onClick={() => void renameGroup(group)}
                    type="button"
                  >
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
            <span className="eyebrow">Device Registry</span>
            <h2>Cab Units</h2>
          </div>
          <div className="button-row">
            <label className="field compact-field">
              <span>Filter by group</span>
              <select value={selectedGroupId} onChange={(event) => applyGroupFilter(event.target.value)}>
                <option value="ALL">All Devices</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="button button-primary" onClick={() => setRegisterOpen(true)} type="button">
              Register Device
            </button>
          </div>
        </div>

        {devices.length === 0 ? (
          <div className="empty-state">
            <strong>No devices registered yet</strong>
            <p>
              Register your first cab screen, assign it to a group, and the CMS will start tracking
              sync, heartbeats, storage, and playback health.
            </p>
            <button className="button button-primary" onClick={() => setRegisterOpen(true)} type="button">
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
                    <th>Group</th>
                    <th>Current Loop</th>
                    <th>Last Heartbeat</th>
                    <th>Storage Free</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {devices.map((device) => (
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
                        <div className="stack-sm">
                          <StatusDot label={device.status} status={device.status} />
                          {device.isDisabled ? (
                            <span className="muted">Disabled{device.disabledReason ? `: ${device.disabledReason}` : ""}</span>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <select
                          disabled={busyDeviceId === device.id}
                          onChange={(event) => void assignGroup(device.id, event.target.value)}
                          value={device.groupId ?? ""}
                        >
                          <option value="">All Devices</option>
                          {groups.map((group) => (
                            <option key={group.id} value={group.id}>
                              {group.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {device.currentLoopId
                          ? device.expectedLoopId && device.currentLoopId === device.expectedLoopId
                            ? "Assigned loop synced"
                            : device.currentLoopId === publishedLoopId
                              ? "Current published loop"
                              : device.currentLoopId
                          : "None"}
                      </td>
                      <td>
                        {device.lastHeartbeatAt
                          ? new Date(device.lastHeartbeatAt).toLocaleString()
                          : "Never"}
                      </td>
                      <td>{device.storageFreeMb ? `${device.storageFreeMb} MB` : "n/a"}</td>
                      <td>
                        <button
                          className={device.isDisabled ? "button button-secondary" : "button button-danger"}
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
                            "Enable"
                          ) : (
                            "Disable"
                          )}
                        </button>
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
      </div>

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
                {saving ? (
                  <span className="button-inline">
                    <span aria-hidden className="button-spinner" />
                    Registering device
                  </span>
                ) : (
                  "Register Device"
                )}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {groupModalOpen ? (
        <Modal eyebrow="Groups" onClose={() => setGroupModalOpen(false)} title="Create device group">
          <form className="stack" onSubmit={createGroup}>
            <label className="field">
              <span>Group Name</span>
              <input
                onChange={(event) => setGroupForm((current) => ({ ...current, name: event.target.value }))}
                required
                value={groupForm.name}
              />
            </label>

            <label className="field">
              <span>Description</span>
              <textarea
                onChange={(event) =>
                  setGroupForm((current) => ({ ...current, description: event.target.value }))
                }
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
                  "Create Group"
                )}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
