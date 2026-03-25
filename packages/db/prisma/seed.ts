import { hash } from "bcryptjs";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const adminEmail = process.env.DEFAULT_ADMIN_EMAIL ?? "admin@orisonscreens.com";
  const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD ?? "ChangeMe123!";

  const passwordHash = await hash(adminPassword, 10);

  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      name: "Orison Admin",
      passwordHash,
      role: "ADMIN",
    },
    create: {
      email: adminEmail,
      name: "Orison Admin",
      passwordHash,
      role: "ADMIN",
    },
  });

  await prisma.systemSetting.upsert({
    where: { key: "cms" },
    update: {},
    create: {
      key: "cms",
      value: {
        defaultFillerTemplate: [
          { category: "FILLER_WEATHER", durationMs: 15000 },
          { category: "FILLER_NEWS", durationMs: 15000 },
          { category: "FILLER_BRANDED", durationMs: 18000 },
        ],
        syncIntervalSeconds: 1800,
        heartbeatIntervalSeconds: 300,
        notificationEmails: ["jack@orisonscreens.com"],
      },
    },
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

