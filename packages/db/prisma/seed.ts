import { randomUUID } from "node:crypto";

import { hash } from "bcryptjs";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const adminEmail = process.env.DEFAULT_ADMIN_EMAIL ?? "admin@orisonscreens.com";
  const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD ?? "ChangeMe123!";

  const passwordHash = await hash(adminPassword, 10);

  // Railway runs this script as the pre-deploy step, BEFORE the new container applies the schema
  // with `prisma db push`. The Prisma client here is generated from the new schema, and its model
  // queries name every column of the model, so `prisma.user.upsert()` fails with "column does not
  // exist" on any release that adds a column. Use SQL that names only the columns it needs, all of
  // which exist in every release; new columns must have database defaults.
  await prisma.$executeRaw`
    INSERT INTO "User" ("id", "email", "passwordHash", "name", "role", "createdAt", "updatedAt")
    VALUES (${`seed_${randomUUID()}`}, ${adminEmail}, ${passwordHash}, 'Orison Admin', 'ADMIN'::"Role", NOW(), NOW())
    ON CONFLICT ("email") DO UPDATE
    SET "name" = EXCLUDED."name",
        "passwordHash" = EXCLUDED."passwordHash",
        "role" = EXCLUDED."role",
        "updatedAt" = NOW()
  `;

  const defaultCmsSettings = {
    defaultFillerTemplate: [
      { category: "FILLER_WEATHER", durationMs: 15000 },
      { category: "FILLER_NEWS", durationMs: 15000 },
      { category: "FILLER_BRANDED", durationMs: 18000 },
    ],
    syncIntervalSeconds: 1800,
    heartbeatIntervalSeconds: 300,
    notificationEmails: ["jack@orisonscreens.com"],
  };

  await prisma.$executeRaw`
    INSERT INTO "SystemSetting" ("key", "value", "updatedAt")
    VALUES ('cms', ${JSON.stringify(defaultCmsSettings)}::jsonb, NOW())
    ON CONFLICT ("key") DO NOTHING
  `;
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

