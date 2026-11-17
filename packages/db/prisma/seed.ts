import { randomUUID } from "node:crypto";

import { hash } from "bcryptjs";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Creates the first admin user if it does not exist yet. Safe to run on every deploy:
// - It never changes an existing user (a changed admin password or name stays changed).
// - Railway runs it as the pre-deploy step BEFORE the new container applies the schema with
//   `prisma db push`. On a fresh database there are no tables yet, so it skips; the container
//   start command runs it again after `db push`, which creates the admin on the first deploy.
// - The Prisma client here is generated from the NEW schema and its model queries name every
//   column, which fails against the old schema on any release that adds a column. So it uses SQL
//   that names only columns present in every release; new User columns must have DB defaults.
// CMS settings are not seeded: lib/cms-settings.ts supplies defaults for anything not saved.
async function main() {
  const [{ exists }] = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT to_regclass('public."User"') IS NOT NULL AS "exists"
  `;
  if (!exists) {
    console.log("seed: the database has no tables yet (schema not applied); nothing to do");
    return;
  }

  const adminEmail = process.env.DEFAULT_ADMIN_EMAIL ?? "admin@orisonscreens.com";
  const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD ?? "ChangeMe123!";

  const created = await prisma.$executeRaw`
    INSERT INTO "User" ("id", "email", "passwordHash", "name", "role", "createdAt", "updatedAt")
    VALUES (${`seed_${randomUUID()}`}, ${adminEmail}, ${await hash(adminPassword, 10)}, 'Orison Admin', 'ADMIN'::"Role", NOW(), NOW())
    ON CONFLICT ("email") DO NOTHING
  `;
  console.log(created > 0 ? `seed: created admin ${adminEmail}` : `seed: admin ${adminEmail} already exists; left unchanged`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
