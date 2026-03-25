FROM node:20-bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
  ffmpeg \
  openssl \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

RUN npm install
RUN npm run db:generate
RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start", "--workspace", "@orison/web"]

