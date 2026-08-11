# AI Development Log

This project was built with AI assistance. This log documents the tools used, the exact prompts given, and what the AI contributed vs. what required human judgment or correction.

---

## AI Stack

| | |
|---|---|
| **Model** | Claude Sonnet 4.6 (Thinking) |
| **Interface** | [Antigravity](https://antigravity.dev) — agentic IDE assistant |
| **Mode** | Planning + Execution (the AI proposed plans, waited for approval, then built) |

---

## Prompts Used (Verbatim)

### 1 — Project kickoff

> We are Building a MVP for an Uptime Monitor here as a fresh project, work as a Senior dev, make sure to point out things where we can improve, I would be providing up with the requirement for frontend and backend.

**What the AI did:** Waited for requirements rather than making assumptions. Asked 3 clarifying questions (auth, checker service, port preference) before touching any code.

---

### 2 — Backend scaffold

> Build a Nodejs + Express backend (in plain Javascript)
>
> use Prisma ORM with SQLite for the db
>
> for schema, we can two schemas,
> 1. Monitor : id, name, createdAt, isActive, currentStatus(bool, default = true), noOfConsecutiveFails( integer, 0 = default)
> 2. Check : id, monitorID( foreign key, onDelete Cascade), statusCode (integer, nullable), reponseTime (integer ms, nullable), isUp (bool), errortype( timeout, dns_failure, connection-refused, bad status or null on success), checkedAt (date and time)
>
> for routes:
> - POST /api/monitors - body { name and url }, validate here if it is a well formed url or not
> - GET /api/monitors - get all the urls with current status and most recent check
> - GET - if many, get a paginated check history with limit 20
> - DELETE /api/monitors/:id
>
> for scheduler:
> use Node-cron every 60 seconds
> - fetch all active monitors, ping them concurrently and not sequentially
> - keep clarity in each result with the status codes
> - write a check row for every ping, regardless of any outcome
> - after every check update the monitor, on failure, increment consecutiveFails; on success, reset consecutiveFails to 0. Only flip currentStatus to false after consecutiveFails reaches 2. Flip currentStatus back to true immediately on a single success.

**What the AI caught / added beyond the spec:**
- `url` field was missing from the Monitor schema — flagged and added
- `errorType` stored as `String?` instead of an enum (SQLite has no native enum support)
- Composite index on `(monitorId, checkedAt DESC)` for fast pagination
- Singleton Prisma client pattern to prevent connection exhaustion on nodemon hot-reloads
- Graceful `SIGTERM`/`SIGINT` handlers stopping cron + disconnecting Prisma before process exit
- `/health` endpoint for Docker/load balancer readiness probes
- `Promise.allSettled` (not `Promise.all`) so one failing ping can't block the rest
- `cors` middleware added pre-emptively for future frontend connection

---

### 3 — Skip-tick guard

> skip a tick if the previous one hasn't finished yet.

**What the AI built:** A module-level `isRunning` boolean mutex in the scheduler. If the previous `Promise.allSettled` hasn't resolved by the time the next cron tick fires, the new tick logs a warning and returns immediately — no overlapping runs, no DB pile-up under slow networks.

---

### 4 — Frontend scaffold

> let start with the frontend
>
> use Vite + react (in plain JavaScript) dashboard for the uptime monitor backend above.
> use Plain React State + hand-written CSS
>
> One Page
> - a form at the top to add a monitor (name + url), POST req
> - a list or grid of all the monitors, each showing name url, a status badge, green for UP and red for Down on currentStatus, also the latest response time in ms, a delete
> - poll get req every 15 secs using setInterval inside a UseEffect
> - clean vanilla css, use dark theme which we used in the portfolio and keep the colors from the portfolio site
> - don't use any external library

**What the AI added beyond the spec:**
- Tab visibility check — `document.visibilityState === 'hidden'` skips polls when the tab is in the background (saves unnecessary requests)
- Optimistic UI — add/delete reflect in the list immediately without waiting for the next 15s poll
- Skeleton shimmer loader on initial fetch (3 placeholder cards instead of a blank screen)
- `aria-label` and `role="alert"` for accessibility
- `timeAgo()` helper on the card footer ("42s ago", "3m ago")
- Live "X up · Y down" counter and blinking "live" indicator in the header
- Subtle CSS grid background texture and glassmorphism sticky header (portfolio aesthetic)
- `VITE_API_BASE` env var wired up so the same build works for both local dev (`localhost:3001`) and Docker (`/api` via nginx proxy) without code changes

---

### 5 — Docker

> create a root docker-compose file to spin up both frontend and backend and also write the separate dockerfiles

**Architecture decision the AI made (and explained):**
Rather than publishing both ports and letting the browser call `localhost:3001` directly, the AI chose an nginx reverse proxy pattern — frontend container handles all traffic on port 80 and proxies `/api/*` to `backend:3001` over the internal Docker bridge network. This eliminates CORS entirely and mirrors how a production ALB would be configured.

**Files created:**
- `docker-compose.yml` — named volume for SQLite persistence, `depends_on: service_healthy` so nginx waits for the backend healthcheck
- `backend/Dockerfile` — `node:22-slim`, generates Prisma client, runs `migrate deploy` on every startup (idempotent)
- `frontend/Dockerfile` — multi-stage: Node builder (`vite build`) → `nginx:stable-alpine`
- `frontend/nginx.conf` — `/api` proxy, SPA fallback, gzip, 1-year cache headers for content-hashed Vite assets

---

## Course Corrections

Design decisions that were reconsidered during development, written up as engineering findings.

---

### Finding 1 — `isUp` (raw ping result) vs `currentStatus` (debounced state)

**The problem with a naïve implementation:**

The obvious first pass stores each ping's `isUp` directly on the Monitor row and reflects it in the dashboard. This means one dropped packet — a momentary TCP timeout, a brief GCP zone hiccup, a server restarting mid-deploy — immediately flips the badge from green to red and would trigger an alert. In a production monitor used for real services, this is the primary source of alert fatigue.

**The distinction introduced:**

Two separate concepts were kept explicitly separate in the schema:

```
Check.isUp         — the raw result of this individual ping (true/false, always written)
Monitor.currentStatus — the debounced, confirmed state shown in the dashboard
```

`currentStatus` only changes under specific conditions tracked by `noOfConsecutiveFails`:

```
Ping passes  →  consecutiveFails = 0
                currentStatus    = true   ← recovers immediately on first success

Ping fails   →  consecutiveFails += 1
                if consecutiveFails >= 2  →  currentStatus = false   ← confirmed DOWN
                else                      →  currentStatus unchanged  ← still showing UP
```

**Why this threshold is correct for an MVP:**
- Recovery is instant (one success) because a recovered service is a confirmed good state.
- Degradation requires two consecutive failures because two failures 60 seconds apart are extremely unlikely to be coincidental noise — they indicate a real outage.
- `noOfConsecutiveFails` resets on any success, so a pattern of fail/pass/fail/pass never crosses the threshold. Only a sustained outage does.

**What the dashboard would have looked like without this:**
Every single scheduled check would be visible as a status flip if any ping took >10s or hit a transient DNS issue. The badge would be unreliable — the opposite of what a monitor is for.

---

### Finding 2 — Vite dev server in Docker causes OOM kill (exit 137)

**The problem:**

The first mental model for Dockerizing the frontend is: copy the source, run `npm run dev`, expose port 5173. This works on a developer laptop but is a category error in a container.

Vite's dev server (`vite dev`) is a **build tool running in watch mode**, not a static file server. It:
- Holds the entire module graph in memory
- Runs esbuild transforms on every request
- Maintains HMR WebSocket connections
- Incrementally rebuilds on file changes (pointless in a container with no file changes)

Under any meaningful load — or simply on a memory-constrained host — the Node process grows unbounded until the OOM killer sends `SIGKILL`. The container exits with code `137` (`128 + SIGKILL`), Docker restarts it, and the cycle repeats.

**The correct model — what `frontend/Dockerfile` does instead:**

```dockerfile
# Stage 1: build tool runs once, produces a static artifact
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build          # ← vite runs here, exits cleanly, ~150ms

# Stage 2: serve the artifact — no Node process at all
FROM nginx:stable-alpine AS runner
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
```

After the build stage, **Node.js is gone from the final image**. nginx serves the pre-built static files with a ~18 MB memory footprint and effectively zero CPU between requests. The `dist/` folder produced by Vite contains content-hashed filenames (`index-BHbrp2C6.css`) which are cached aggressively by the nginx config with `Cache-Control: public, immutable, max-age=31536000`.

**The broader principle:**
Build tools belong in CI/CD pipelines or build stages, not in runtime containers. A container's job is to serve a finished artifact, not to produce one.

---

## Bugs Encountered & Fixed During Docker Spin-Up

This is where human-in-the-loop mattered most.

### Attempt 1 — `node:22-alpine` → ❌

```
Error: Could not parse schema engine response:
SyntaxError: Unexpected token 'E', "Error load"... is not valid JSON
```

**Root cause:** Prisma's query engine is a compiled Rust binary that links against OpenSSL. Alpine uses `musl` libc and doesn't ship OpenSSL — Prisma couldn't load the engine at all.

**Fix tried:** Switched base image to `node:22-slim` (Debian bookworm slim).

---

### Attempt 2 — `node:22-slim` → ❌

```
prisma:warn Prisma failed to detect the libssl/openssl version to use.
Error: Schema engine error:
```

**Root cause:** `node:22-slim` is stripped Debian — OpenSSL is also not pre-installed. The Prisma warning even includes the exact fix command.

**Fix:** Added `openssl` to the `apt-get install` line in the Dockerfile.

---

### Attempt 3 — `node:22-slim` + `apt-get install openssl` → ✅

```
uptime-backend  | [db] Connected to SQLite via Prisma.
uptime-backend  | [checker] Scheduler started. Checks will run every 60 seconds.
uptime-backend  | [server] Uptime Monitor API running on http://localhost:3001
uptime-frontend | nginx worker processes started
```

Both containers healthy. nginx proxy confirmed working. Scheduler confirmed firing.

---

## Final Container Memory Footprint

```
uptime-frontend (nginx)   18.2 MB   0.00% CPU
uptime-backend  (Node.js) 38.8 MB   0.02% CPU
─────────────────────────────────────────
Total                     ~57 MB    out of 7.5 GB (0.75%)
```

---

## Things the AI Flagged for Future Improvement

These were called out proactively throughout the session, not prompted:

- [ ] **Prisma v7** available (project uses v5.22.0) — worth upgrading before adding features
- [ ] **Cursor-based pagination** instead of offset — more performant at scale
- [ ] **`PING_TIMEOUT_MS` and `FAIL_THRESHOLD`** hardcoded as constants — should be env-configurable
- [ ] **`GET /api/monitors/:id`** single-monitor endpoint missing (only list + checks exist)
- [ ] **Auth / user-scoping** — monitors are global; in a real product each user owns their monitors
- [ ] **SQLite → Postgres** for any multi-replica or multi-user scenario
- [ ] **Port 3001 exposed** in docker-compose — should be removed in production so backend is only reachable through nginx
- [ ] **`npm audit`** shows 2 moderate vulnerabilities — run `npm audit fix` when ready
- [ ] **Error type fallback** in checker.js — unknown network errors default to `dns_failure`; expand classification as real-world cases are observed
