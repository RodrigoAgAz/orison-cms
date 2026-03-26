import { prisma, type Prisma } from "@orison/db";

const FLEET_CONTROL_KEY = "fleet-control";

type FleetControlState = {
  disabled: boolean;
  reason: string | null;
};

export async function getFleetControlState(): Promise<FleetControlState> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: FLEET_CONTROL_KEY },
  });

  if (!row) {
    return {
      disabled: false,
      reason: null,
    };
  }

  const value = (row.value ?? {}) as Prisma.JsonObject;

  return {
    disabled: Boolean(value.disabled),
    reason: typeof value.reason === "string" ? value.reason : null,
  };
}

export async function setFleetControlState(state: FleetControlState) {
  return prisma.systemSetting.upsert({
    where: { key: FLEET_CONTROL_KEY },
    update: {
      value: state,
    },
    create: {
      key: FLEET_CONTROL_KEY,
      value: state,
    },
  });
}
