# ─────────────────────────────────────────────────────────────────────────────
# Backend Dockerfile
# Single stage — keeps it simple for the MVP.
#
# SQLite note: the DB file lives at /data/uptime.db, which is declared as a
# named volume in docker-compose so it survives container restarts.
# The prisma/migrations folder is baked into the image; `migrate deploy` runs
# them against the volume on every startup (idempotent — already-applied
# migrations are skipped).
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-slim

# Install wget (healthcheck) + openssl (required by Prisma's query/schema engine binaries).
# node:22-slim is stripped Debian — OpenSSL is NOT included by default.
RUN apt-get update \
 && apt-get install -y --no-install-recommends wget openssl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── 1. Install deps (all, not --omit=dev: prisma CLI lives in devDeps) ──────
COPY package*.json ./
RUN npm ci

# ── 2. Copy schema + generate Prisma Client ──────────────────────────────────
COPY prisma ./prisma
RUN npx prisma generate

# ── 3. Copy application source ───────────────────────────────────────────────
COPY src ./src

# ── 4. Persistent data directory for SQLite ──────────────────────────────────
# This path is overridden by DATABASE_URL in docker-compose.
RUN mkdir -p /data

EXPOSE 3001

ENV NODE_ENV=production
# DATABASE_URL is injected by docker-compose — set as fallback only.
ENV DATABASE_URL="file:/data/uptime.db"

# Run migrations (idempotent) then start the server.
# `exec` replaces the shell so Node gets PID 1 and receives SIGTERM cleanly.
CMD ["sh", "-c", "npx prisma migrate deploy && exec node src/index.js"]
