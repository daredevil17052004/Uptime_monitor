# ─────────────────────────────────────────────────────────────────────────────
# Frontend Dockerfile — multi-stage
#
# Stage 1 (builder): Install deps + run `vite build`.
#   VITE_API_BASE is injected as a build arg. When building via docker-compose
#   it is set to `/api` so the nginx proxy handles routing. In local dev it
#   defaults to the direct backend URL via the .env file.
#
# Stage 2 (runner): Serve the static dist/ with nginx + proxy /api → backend.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Build ─────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# VITE_API_BASE is baked into the bundle at build time by Vite.
# docker-compose passes /api here; local .env passes the full localhost URL.
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=$VITE_API_BASE

RUN npm run build

# ── Stage 2: Serve ─────────────────────────────────────────────────────────
FROM nginx:stable-alpine AS runner

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy custom config (SPA fallback + /api proxy)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
