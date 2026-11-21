# API server image. Build from the repository root:
#   docker build -f infra/api.Dockerfile -t hostbot/api:latest .
FROM node:22-bookworm-slim AS build

WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/bot/package.json apps/bot/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --no-audit --no-fund

COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @hostbot/api

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    DATA_DIR=/srv/hostbot/data \
    PORT=3001 \
    HOST=0.0.0.0

WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/bot/package.json apps/bot/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev --no-audit --no-fund

COPY --from=build /repo/apps/api/dist apps/api/dist

EXPOSE 3001
CMD ["node", "apps/api/dist/index.js"]
