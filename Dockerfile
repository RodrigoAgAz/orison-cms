# Production image of the Orison CMS (Railway builds this file; the app answers on port 3000 and
# Railway health-checks /login).
#
# Ubuntu 24.04 with Ubuntu's own ffmpeg (6.1.1) and Node 22: the same system the media code (loop
# compiler, asset normalisation, HDR handling) was developed and tested on. Node is the official
# release tarball, pinned and checked against the sha256 published in
# https://nodejs.org/dist/v<NODE_VERSION>/SHASUMS256.txt. To move to a newer Node 22 release,
# change all three NODE_* values together.

FROM ubuntu:24.04 AS base

ARG NODE_VERSION=22.23.4
ARG NODE_SHA256_X64=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce
ARG NODE_SHA256_ARM64=6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl openssl xz-utils \
  && case "$(dpkg --print-architecture)" in \
       amd64) NODE_ARCH=x64; NODE_SHA256="$NODE_SHA256_X64" ;; \
       arm64) NODE_ARCH=arm64; NODE_SHA256="$NODE_SHA256_ARM64" ;; \
       *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
     esac \
  && curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
  && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
  && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
  && rm -f /tmp/node.tar.xz \
  && apt-get clean && rm -rf /var/lib/apt/lists/* \
  && node --version

# --- build: install everything, generate the Prisma client, build Next, then drop dev-only packages.
FROM base AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

# Exactly what the lockfile says. Dev dependencies (TypeScript, type packages) are needed to build,
# so they are installed whatever NODE_ENV the build sees.
RUN npm ci --include=dev --no-audit --no-fund

RUN npm run db:generate

RUN npm run build && rm -rf apps/web/.next/cache

# What production runs needs no dev dependency: tsx (the seed, also run by Railway's pre-deploy
# `npx tsx packages/db/prisma/seed.ts`) and the prisma CLI (`db push`) are dependencies of @orison/db.
RUN npm prune --omit=dev --no-audit --no-fund

# --- runtime
FROM base AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && apt-get clean && rm -rf /var/lib/apt/lists/* \
  && ffmpeg -hide_banner -version | head -n 1

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app /app

EXPOSE 3000

# Apply the schema, then create the first admin if there is none (on a brand-new database the
# pre-deploy seed ran before any table existed and skipped), then start the web app. Media jobs
# (asset processing, loop compiles, uploads) run inside this web process. The Prisma client was
# generated at build time, so `db push` does not generate it again.
CMD ["sh", "-c", "npx prisma db push --skip-generate --schema packages/db/prisma/schema.prisma && npm run db:seed && npm run start --workspace @orison/web"]
