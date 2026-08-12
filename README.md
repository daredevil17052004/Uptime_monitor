# Uptime Monitor

Real-time HTTP uptime monitoring with a Node.js/Express backend, React dashboard, and a 60-second cron scheduler. Runs fully in Docker — one command.

![alt text](public/image.png)
---

## 1. Setup

```bash
docker compose up --build
```

**`http://localhost`** is the single entry point.

nginx (port 80) proxies all `/api/*` traffic to the backend container internally — the browser never talks to port 3001 directly. No CORS configuration needed.

```
Browser → localhost:80
            ├── /api/*  → nginx proxy → backend:3001
            └── /*      → static React SPA (pre-built by Vite)
```

> Direct backend access is also available at `http://localhost:3001` for debugging.

---

## 2. Test It in 5 Minutes

Open `http://localhost` and add these three monitors to exercise every status path:

| Name | URL | Expected outcome |
|---|---|---|
| Example | `https://example.com` | 🟢 **UP** — 2xx response, fast |
| DNS Failure | `http://this-domain-does-not-exist-xyz123.invalid` | 🔴 **DOWN** — `dns_failure` after 2 checks |
| Bad Status | `https://httpstat.us/500` | 🔴 **DOWN** — `bad_status` after 2 checks |

Wait **~2 minutes** (two 60-second cron ticks) for the DOWN monitors to flip status. On the first failed check, the card still shows `UP` — this is the debounce in action (see §3).

---

## 3. Debounce — No Instant Status Flips

A single failed check does **not** immediately mark a monitor as DOWN. Transient blips (brief network issues, a restarting pod) would cause too much noise.

**The rules, applied after every check:**

```
✅ Check passes  →  consecutiveFails = 0
                    currentStatus    = true  (UP, immediately)

❌ Check fails   →  consecutiveFails += 1
                    if consecutiveFails >= 2 → currentStatus = false  (DOWN)
                    otherwise               → currentStatus unchanged  (still UP)
```

**In plain English:**
- It takes **2 consecutive failures** to flip a monitor to DOWN.
- It takes **1 success** to flip it back to UP.
- Recovery is instant; degradation requires confirmation.

---

## 4. Status Logic & Error Classification

Every check writes one row to the `Check` table regardless of outcome.

### What counts as UP?

Any HTTP response with status **< 400** (2xx redirect chains included). The check is considered successful and `errorType` is stored as `null`.

### Error types for DOWN checks

| `errorType` | Trigger | Typical cause |
|---|---|---|
| `bad_status` | HTTP response received, but status **≥ 400** | 4xx client error, 5xx server error |
| `timeout` | No response within **10 seconds** (AbortController) | Slow server, firewall dropping packets |
| `dns_failure` | `ENOTFOUND` or `EAI_AGAIN` thrown by Node fetch | Domain doesn't exist, DNS misconfigured |
| `connection_refused` | `ECONNREFUSED` thrown by Node fetch | Port closed, server not listening |

### Status code → errorType mapping

```
2xx / 3xx              → isUp: true,  errorType: null
4xx / 5xx              → isUp: false, errorType: 'bad_status'
AbortError (>10s)      → isUp: false, errorType: 'timeout'
ENOTFOUND / EAI_AGAIN  → isUp: false, errorType: 'dns_failure'
ECONNREFUSED           → isUp: false, errorType: 'connection_refused'
```

---

## 5. Production Deployment Sketch — AWS ECS Fargate + RDS Postgres

### Architecture

```
Route 53 → ALB (HTTPS/443)
             ├── /api/*  → ECS Fargate  (backend task)
             └── /*      → ECS Fargate  (frontend/nginx task)
                                ↓
                         RDS Postgres (private subnet)
```

### SQLite → Postgres Migration

Prisma makes this a two-line change in `backend/prisma/schema.prisma`:

```diff
 datasource db {
-  provider = "sqlite"
-  url      = env("DATABASE_URL")
+  provider = "postgresql"
+  url      = env("DATABASE_URL")
 }
```

Then run `npx prisma migrate dev --name switch-to-postgres`. Schema and all queries stay identical — Prisma handles the dialect.

Set `DATABASE_URL` in your ECS task definition:
```
postgresql://user:password@your-rds-endpoint:5432/uptime
```

### Terraform Snippet (core resources)

```hcl
# ── ECS Cluster ─────────────────────────────────────────────────────────────
resource "aws_ecs_cluster" "uptime" {
  name = "uptime-monitor"
}

# ── Backend Task Definition ──────────────────────────────────────────────────
resource "aws_ecs_task_definition" "backend" {
  family                   = "uptime-backend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256   # 0.25 vCPU
  memory                   = 512   # MB

  container_definitions = jsonencode([{
    name  = "backend"
    image = "${aws_ecr_repository.backend.repository_url}:latest"
    portMappings = [{ containerPort = 3001 }]
    environment = [
      { name = "NODE_ENV",      value = "production" },
      { name = "DATABASE_URL",  value = var.database_url },
      { name = "PORT",          value = "3001" }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = "/ecs/uptime-backend"
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "ecs"
      }
    }
  }])
}

# ── Frontend Task Definition ─────────────────────────────────────────────────
resource "aws_ecs_task_definition" "frontend" {
  family                   = "uptime-frontend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512

  container_definitions = jsonencode([{
    name  = "frontend"
    image = "${aws_ecr_repository.frontend.repository_url}:latest"
    portMappings = [{ containerPort = 80 }]
  }])
}

# ── RDS Postgres ─────────────────────────────────────────────────────────────
resource "aws_db_instance" "uptime" {
  identifier        = "uptime-db"
  engine            = "postgres"
  engine_version    = "16"
  instance_class    = "db.t4g.micro"  # ~$13/month
  allocated_storage = 20
  db_name           = "uptime"
  username          = var.db_user
  password          = var.db_password

  # Private subnet — not publicly accessible
  db_subnet_group_name   = aws_db_subnet_group.uptime.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  skip_final_snapshot    = false
}

# ── ALB Listener Rules ───────────────────────────────────────────────────────
# Route /api/* to backend target group, everything else to frontend
resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }
  condition {
    path_pattern { values = ["/api/*"] }
  }
}
```

### What you still need to add

- `aws_ecr_repository` for both images + a CI/CD pipeline (`docker build → ecr push → ecs deploy`)
- `aws_lb`, `aws_lb_listener`, `aws_lb_target_group` for the ALB
- VPC, subnets, security groups
- ACM certificate for HTTPS
- Secrets Manager or Parameter Store for `DATABASE_URL` (don't put it in task env plaintext in production)

---

## Project Structure

```
uptime/
├── docker-compose.yml        # Single-command local setup
├── backend/
│   ├── Dockerfile            # node:22-slim + openssl + Prisma
│   ├── prisma/
│   │   └── schema.prisma     # Monitor + Check models
│   └── src/
│       ├── index.js          # Express entry point + graceful shutdown
│       ├── routes/monitors.js
│       ├── scheduler/checker.js  # node-cron + concurrent pinger
│       └── lib/prisma.js     # Singleton Prisma client
└── frontend/
    ├── Dockerfile            # Multi-stage: Vite build → nginx:stable-alpine
    ├── nginx.conf            # /api proxy + SPA fallback + gzip
    └── src/
        └── App.jsx           # Single-page dashboard, 15s polling
```
