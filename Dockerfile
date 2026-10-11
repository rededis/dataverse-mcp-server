# syntax=docker/dockerfile:1
# The HTTP server image (ADR-0001 §1): the esbuild bundle of src/server/index.ts
# on distroless Node 24, nothing else. Build with
#   docker build --build-arg SERVER_VERSION=0.1.0 -t dataverse-mcp-server-http .
# Without SERVER_VERSION the server reports the package.json version with -dev.
# Base images are pinned by the digest of their multi-arch index.

# The bundle is plain JavaScript, the same on every platform: build it once on
# the builder's own platform, so a multi-platform build runs nothing under
# emulation (the runtime stage has no RUN).
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# No .git here: HUSKY=0 skips the prepare script's hook install.
RUN HUSKY=0 npm ci --no-audit --no-fund
COPY tsconfig.json LICENSE ./
COPY scripts ./scripts
COPY src ./src
ARG SERVER_VERSION
RUN SERVER_VERSION="$SERVER_VERSION" npm run build:server

# No shell, uid 65532. Node is /nodejs/bin/node and not on PATH.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e
WORKDIR /app
# server.js, server.js.map, LICENSE and licenses/ (third-party licence texts).
COPY --from=build /app/build/server/ ./
# Inside a container the server must listen beyond loopback. Publish the port
# on the host's loopback unless it should be reachable: -p 127.0.0.1:3000:3000.
ENV DATAVERSE_SERVER_HOST=0.0.0.0
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# The server handles SIGTERM and SIGINT itself and starts no child processes,
# so it runs as PID 1 without an init.
ENTRYPOINT ["/nodejs/bin/node", "--enable-source-maps", "/app/server.js"]
