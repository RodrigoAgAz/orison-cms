import { DevicesRegistry } from "@/components/devices-registry";
import { requireUser } from "@/lib/auth";
import { getDevicesData, resolveDeviceStatus } from "@/lib/queries";

export default async function DevicesPage() {
  await requireUser();
  const { devices, publishedLoopId } = await getDevicesData();

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Fleet</span>
          <h1>Registered Devices</h1>
          <p className="muted">Track sync state, cab assignments, heartbeats, and device storage.</p>
        </div>
      </div>

      <DevicesRegistry
        devices={devices.map((device) => ({
          ...device,
          lastSyncAt: device.lastSyncAt?.toISOString() ?? null,
          lastHeartbeatAt: device.lastHeartbeatAt?.toISOString() ?? null,
          status: resolveDeviceStatus(device, publishedLoopId),
          heartbeats: device.heartbeats.map((heartbeat) => ({
            ...heartbeat,
            receivedAt: heartbeat.receivedAt.toISOString(),
          })),
        }))}
        publishedLoopId={publishedLoopId}
      />
    </div>
  );
}
