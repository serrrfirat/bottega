# bottega app image (issue #12): one image, two entrypoints.
#
# The `server` (src/server/index.ts) and `executor` (src/executor.ts)
# services in docker-compose.yml share this image and differ only in
# entrypoint. The base image ships no git — the executor shells out to
# `git` for clone/checkout/push (issue #11), so git is installed here.
#
# Runtime user: the base image's `bun` user (uid 1000). Named volumes
# (data, workspaces) copy image ownership on first mount, so /app/data and
# /workspaces are pre-created and owned by bun — the app can write the
# SQLite store, sessions, transcripts, and workspaces without root.
FROM oven/bun:1

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

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
