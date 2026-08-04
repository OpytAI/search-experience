# Docs image: Bun + Vite build, product package from GitHub Releases (not Bazel).
# Build from monorepo root (see deploy/docker-compose.yml context).

ARG BUN_VERSION=1.3.11

FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app

ARG RELEASE_BASE=https://github.com/OpytAI/search-experience/releases/latest/download

# Workspace install surface (catalog + docs workspace + product sources for @search).
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY docs/package.json docs/
RUN bun install --frozen-lockfile

COPY docs/ docs/
COPY src/ src/

# Stage latest release.tar into docs/public/agentos-search/ (gitignored in the repo).
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL -o /tmp/release.tar "${RELEASE_BASE}/release.tar" \
  && curl -fsSL -o /tmp/SHA256SUMS "${RELEASE_BASE}/SHA256SUMS" \
  && (cd /tmp && sha256sum -c SHA256SUMS) \
  && mkdir -p docs/public \
  && tar -xf /tmp/release.tar -C docs/public \
  && test -f docs/public/agentos-search/agentos-search.mjs \
  && rm -f /tmp/release.tar /tmp/SHA256SUMS

WORKDIR /app/docs
# Bun runtime resolves package exports the way the monorepo expects (Node can fail on lit).
RUN bun --bun ./node_modules/vite/bin/vite.js build

FROM nginx:1.27-alpine AS runtime
COPY deploy/nginx-docs.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/docs/dist /usr/share/nginx/html
EXPOSE 80
