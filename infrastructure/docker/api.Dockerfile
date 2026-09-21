# Node API gateway.
#
# Two stages: a builder that installs the whole workspace and bundles the API
# with esbuild (so the runtime image needs no workspace resolution), and a
# slim runtime that carries only the bundle and the migration/seed sources.

# ---- builder ---------------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/units/package.json packages/units/
COPY packages/hydrology-core/package.json packages/hydrology-core/
COPY packages/config/package.json packages/config/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN npm install --workspaces --include-workspace-root --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/
COPY database/ database/

RUN npm run build --workspace @hydro/api

# ---- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# curl is used by the compose healthcheck fallback and by operators debugging
# a running container; nothing in the application shells out.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/database ./database

# Non-root by default.
RUN useradd --system --create-home --uid 10001 hydro \
  && mkdir -p /app/.storage \
  && chown -R hydro:hydro /app
USER hydro

EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://localhost:4000/api/health || exit 1

CMD ["node", "dist/server.cjs"]
