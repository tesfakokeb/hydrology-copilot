# React frontend, built to static assets and served by nginx.

# ---- builder ---------------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

ARG VITE_API_BASE=""
ARG VITE_BASEMAP_STYLE=""
ENV VITE_API_BASE=$VITE_API_BASE
ENV VITE_BASEMAP_STYLE=$VITE_BASEMAP_STYLE

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
COPY apps/web/ apps/web/

RUN npm run build --workspace @hydro/web

# ---- runtime ---------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY infrastructure/docker/web-nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
