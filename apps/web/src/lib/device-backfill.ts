// One-off, idempotent: cabs that have not sent a heartbeat since the Device row started keeping
// the latest player state (statusReportedAt null) get it from their newest stored heartbeat, so
// the lists are right straight after the upgrade instead of after each cab's next heartbeat.
// One index lookup per such cab; does nothing once every cab has reported.

import { prisma } from "@orison/db";

export async function backfillDeviceStatus() {
  return prisma.$executeRaw`
    UPDATE "Device" d
    SET "playerStatus" = h."playerStatus",
        "uptimeSeconds" = h."uptimeSeconds",
        "networkType" = h."networkType",
        "signalPercent" = CASE WHEN h."signalStrength" BETWEEN 0 AND 100 THEN h."signalStrength" END,
        "signalDbm" = CASE WHEN h."signalStrength" < 0 THEN h."signalStrength" END,
        "statusReportedAt" = h."receivedAt"
    FROM "Device" d2
    CROSS JOIN LATERAL (
      SELECT "playerStatus", "uptimeSeconds", "networkType", "signalStrength", "receivedAt"
      FROM "DeviceHeartbeat"
      WHERE "deviceId" = d2.id AND "playerStatus" IS NOT NULL
      ORDER BY "receivedAt" DESC
      LIMIT 1
    ) h
    WHERE d.id = d2.id AND d."statusReportedAt" IS NULL
  `;
}
