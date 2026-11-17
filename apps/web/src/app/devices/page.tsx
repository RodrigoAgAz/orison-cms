import { DevicesRegistry } from "@/components/devices-registry";
import { PageErrorNotice } from "@/components/page-error-notice";
import { requireUser } from "@/lib/auth";
import { getDevicesData } from "@/lib/fleet-data";

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

const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;

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
          <span className="eyebrow">Cabs</span>
          <h1>Cabs</h1>
          <p className="muted">What each cab plays, whether it is up to date, and how its screen and connection are doing.</p>
        </div>
      </div>

      <PageErrorNotice message={result.error} title="Cabs unavailable" />

      <DevicesRegistry
        devices={result.cabs.map((cab) => ({
          id: cab.id,
          serialNumber: cab.serialNumber,
          cabLicenseNumber: cab.cabLicenseNumber,
          driverName: cab.driverName,
          hpTaxiCabId: cab.hpTaxiCabId,
          groupId: cab.groupId,
          isActive: cab.isActive,
          isDisabled: cab.isDisabled,
          disabledReason: cab.disabledReason,
          status: cab.status,
          online: cab.online,
          currentLoopId: cab.currentLoopId,
          currentLoopName: cab.currentLoopName,
          expectedLoopId: cab.expectedLoopId,
          expectedLoopName: cab.expectedLoopName,
          expectedSourceLabel: cab.expectedSourceLabel,
          sync: {
            state: cab.sync.state,
            label: cab.sync.label,
            error: cab.sync.error,
            since: iso(cab.sync.since),
            nextRetryAt: iso(cab.sync.nextRetryAt),
            failedLoopName: cab.syncFailedLoopName,
          },
          lastSyncAt: iso(cab.lastSyncAt),
          lastHeartbeatAt: iso(cab.lastHeartbeatAt),
          playerStatusNow: cab.playerStatusNow,
          playbackTrigger: cab.playbackTrigger,
          signalPercent: cab.signalPercent,
          signalDbm: cab.signalDbm,
          networkType: cab.networkType,
          storageFreeMb: cab.storageFreeMb,
          firmwareVersion: cab.firmwareVersion,
        }))}
        fleetControl={result.fleetControl}
        groups={result.groups}
        page={result.page}
        pageSize={result.pageSize}
        selectedGroupId={result.selectedGroupId}
        total={result.total}
      />
    </div>
  );
}
