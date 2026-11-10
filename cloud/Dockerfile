# TeamBot Cloud (control plane + router). Build from the repository root:
#   docker build -f cloud/Dockerfile -t teambot-cloud .
# Instances use the normal TeamBot image (root Dockerfile, `docker build -t teambot .`).
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run cloud:build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
# Docker CLI (Apache-2.0, static binary) to drive the instances through the mounted Docker socket.
ARG DOCKER_CLI_VERSION=27.3.1
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates curl \
    && curl -fsSL "https://download.docker.com/linux/static/stable/$(uname -m)/docker-${DOCKER_CLI_VERSION}.tgz" \
       | tar -xz --strip-components=1 -C /usr/local/bin docker/docker \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    CLOUD_HOST=0.0.0.0 \
    CLOUD_PORT=8080 \
    CLOUD_DATA=/data \
    CLOUD_PROVISIONER=docker
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/cloud ./dist/cloud
COPY LICENSE NOTICE ./
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/cloud/main.js"]
