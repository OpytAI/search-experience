# Docs image: Bun + Vite build, product package from a pinned GitHub Release (not Bazel).
# Build from monorepo root (see deploy/docker-compose.yml context).
#
# Prerequisites:
#   - Cut a GitHub release that publishes release.tar + SHA256SUMS (e.g. v0.1.0)
#     before `docker compose build`. A missing tag fails the build intentionally.
#   - Prefer RELEASE_TAR_SHA256 for an independent pin of release.tar contents.
#     SHA256SUMS downloaded from the same URL only detects transport corruption.

ARG BUN_VERSION=1.3.11

FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app

# Pin the product package. Prefer RELEASE_TAG (e.g. v0.1.0) or full RELEASE_BASE URL.
# Do not default to /releases/latest — that pairs docs source with a moving runtime.
ARG RELEASE_TAG=v0.1.0
ARG RELEASE_BASE=
# Optional but recommended for production: independent SHA-256 of release.tar.
ARG RELEASE_TAR_SHA256=
# When "1", require RELEASE_TAR_SHA256 (prod profile). Local smoke may leave unset.
ARG REQUIRE_RELEASE_TAR_SHA256=0

# Workspace install surface (catalog + docs workspace + product sources for @search).
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY docs/package.json docs/
RUN bun install --frozen-lockfile

COPY docs/ docs/
COPY src/ src/

# Stage pinned release.tar into docs/public/agentos-search/ (gitignored in the repo).
# Extract only under a temp dir and move the expected agentos-search/ tree (path-safety).
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && BASE="${RELEASE_BASE:-https://github.com/OpytAI/search-experience/releases/download/${RELEASE_TAG}}" \
  && curl -fsSL -o /tmp/release.tar "${BASE}/release.tar" \
  && curl -fsSL -o /tmp/SHA256SUMS "${BASE}/SHA256SUMS" \
  && (cd /tmp && sha256sum -c SHA256SUMS) \
  && if [ "$REQUIRE_RELEASE_TAR_SHA256" = "1" ] && [ -z "$RELEASE_TAR_SHA256" ]; then \
       echo "RELEASE_TAR_SHA256 is required when REQUIRE_RELEASE_TAR_SHA256=1" >&2; exit 1; \
     fi \
  && if [ -n "$RELEASE_TAR_SHA256" ]; then \
       echo "$RELEASE_TAR_SHA256  /tmp/release.tar" | sha256sum -c -; \
     fi \
  && mkdir -p /tmp/release-extract docs/public \
  && tar -xf /tmp/release.tar -C /tmp/release-extract \
  && test -d /tmp/release-extract/agentos-search \
  && test -f /tmp/release-extract/agentos-search/agentos-search.mjs \
  && # Reject unexpected top-level members outside agentos-search/
     for entry in /tmp/release-extract/* /tmp/release-extract/.[!.]*; do \
       [ -e "$entry" ] || continue; \
       base=$(basename "$entry"); \
       if [ "$base" != "agentos-search" ]; then \
         echo "unexpected archive member: $base" >&2; exit 1; \
       fi; \
     done \
  && mv /tmp/release-extract/agentos-search docs/public/agentos-search \
  && rm -rf /tmp/release.tar /tmp/SHA256SUMS /tmp/release-extract

WORKDIR /app/docs
# Bun runtime resolves package exports the way the monorepo expects (Node can fail on lit).
RUN bun --bun ./node_modules/vite/bin/vite.js build

FROM nginx:1.27-alpine AS runtime
COPY deploy/nginx-docs.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/docs/dist /usr/share/nginx/html
EXPOSE 80
