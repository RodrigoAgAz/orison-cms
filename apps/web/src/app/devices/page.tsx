import { DevicesRegistry } from "@/components/devices-registry";
import { PageErrorNotice } from "@/components/page-error-notice";
import { requireUser } from "@/lib/auth";
import { getDevicesData, resolveDeviceStatus } from "@/lib/queries";

type Props = {
  searchParams?: {
    page?: string;
    group?: string;
  };
};

function parsePage(value: string | undefined) {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

export default async function DevicesPage({ searchParams }: Props) {
  await requireUser();
  const result = await getDevicesData({
    page: parsePage(searchParams?.page),
    pageSize: 12,
    groupId: searchParams?.group,
  });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <span className="eyebrow">Fleet</span>
          <h1>Registered Devices</h1>
          <p className="muted">Track sync state, cab assignments, heartbeats, and device storage.</p>
        </div>
      </div>

      <PageErrorNotice message={result.error} title="Device registry unavailable" />

      <DevicesRegistry
        devices={result.devices.map((device) => ({
          ...device,
          lastSyncAt: device.lastSyncAt?.toISOString() ?? null,
          lastHeartbeatAt: device.lastHeartbeatAt?.toISOString() ?? null,
          status: resolveDeviceStatus(device, device.expectedLoopId),
          heartbeats: device.heartbeats.map((heartbeat) => ({
            ...heartbeat,
            receivedAt: heartbeat.receivedAt.toISOString(),
          })),
        }))}
        fleetControl={result.fleetControl}
        groups={result.groups}
        page={result.page}
        pageSize={result.pageSize}
        publishedLoopId={result.publishedLoopId}
        selectedGroupId={result.selectedGroupId}
        total={result.total}
      />
    </div>
  );
}
