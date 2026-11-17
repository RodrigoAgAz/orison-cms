FROM node:20-bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
  ffmpeg \
  openssl \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install exactly what the lockfile says (npm ci fails if package.json and the lockfile disagree).
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

RUN npm ci

RUN npm run db:generate

RUN npm run build

EXPOSE 3000

# Apply the schema, then create the first admin if there is none (on a brand-new database the
# pre-deploy seed ran before any table existed and skipped), then start the web app. Media jobs
# (asset processing, loop compiles, phone uploads) run inside this web process.
CMD ["sh", "-c", "npx prisma db push --schema packages/db/prisma/schema.prisma && npm run db:seed && npm run start --workspace @orison/web"]
