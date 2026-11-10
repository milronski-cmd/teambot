# TeamBot server (self-host / cloud). Multi-user "server" mode; data in /data.
# Build:  docker build -t teambot .
# Run:    docker compose up -d   (see docker-compose.yml)
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# Local stand-in for node-webpmux (see packages/node-webpmux-stub/README.md); npm ci needs it before COPY . .
COPY packages/node-webpmux-stub ./packages/node-webpmux-stub
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    TEAMBOT_MODE=server \
    TEAMBOT_DATA=/data \
    TEAMBOT_HOST=0.0.0.0 \
    TEAMBOT_PORT=4747
WORKDIR /app
# WhatsApp (QR) runs WhatsApp Web in a headless Chromium. Off by default (image size); enable with
#   docker build --build-arg WITH_CHROMIUM=1 -t teambot .   (TeamBot finds /usr/bin/chromium itself)
ARG WITH_CHROMIUM=0
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates git $(if [ "$WITH_CHROMIUM" = "1" ]; then echo chromium; fi) \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node LICENSE NOTICE ./
USER node
VOLUME ["/data"]
EXPOSE 4747
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.TEAMBOT_PORT||4747)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/main.js"]
