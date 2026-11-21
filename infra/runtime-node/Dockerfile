# Customer bot runtime.
#
# Pure-JavaScript Discord bots only: dependency installation runs with
# `--ignore-scripts`, so native addons that need node-gyp cannot be built.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_IGNORE_SCRIPTS=true

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 bot \
    && useradd --uid 10001 --gid bot --create-home --home-dir /home/bot --shell /usr/sbin/nologin bot \
    && mkdir -p /app /home/bot/.npm /tmp \
    && chown -R 10001:10001 /app /home/bot /tmp

WORKDIR /app
USER 10001:10001

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.js"]
