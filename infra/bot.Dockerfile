# Management Discord bot image. Build from the repository root:
#   docker build -f infra/bot.Dockerfile -t hostbot/bot:latest .
FROM node:22-bookworm-slim AS build

WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/bot/package.json apps/bot/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --no-audit --no-fund

COPY packages/shared packages/shared
COPY apps/bot apps/bot
RUN npm run build -w @hostbot/bot

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/bot/package.json apps/bot/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev --no-audit --no-fund

COPY --from=build /repo/apps/bot/dist apps/bot/dist

CMD ["node", "apps/bot/dist/index.js"]
