# bottega app image (issues #12, #62): one image, two entrypoints.
#
# The `server` (src/server/index.ts) and `executor` (src/executor.ts)
# services in docker-compose.yml share this image and differ only in
# entrypoint. The image inherits the curated CLI set v1 (gh, jq, curl,
# git) from the tools image (issue #58), so `kind: cli` extension tools
# and the executor's git shell-outs (issue #11) resolve on PATH in BOTH
# entrypoints.
#
# Build order matters: the tools image must be built FIRST, because the
# app image builds FROM it:
#   docker build -f Dockerfile.tools -t bottega-tools:ci .
#   docker build -t bottega:local .
# CI builds in this order (docker job, .github/workflows/ci.yml); a
# missing bottega-tools:ci fails the app build with a pull error.
#
# Runtime user: the tools base image's `bun` user (uid 1000). Named
# volumes (data, workspaces) copy image ownership on first mount, so
# /app/data and /workspaces are pre-created and owned by bun — the app
# can write the SQLite store, sessions, transcripts, and workspaces
# without root.
FROM bottega-tools:ci

# The tools base ends with `USER bun`; the build steps below need root
# (bun install writes /app, chown changes ownership).
USER root

WORKDIR /app

# Dependencies first (layer caching): bun installs the locked production
# deps; the app runs TypeScript directly, no build step.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

RUN mkdir -p /app/data /workspaces \
    && chown -R bun:bun /app /workspaces
USER bun

# No CMD: compose sets the entrypoint per service (server vs executor).
