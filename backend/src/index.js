require('dotenv').config();

const express = require('express');
const cors = require('cors');
const prisma = require('./lib/prisma');
const monitorRoutes = require('./routes/monitors');
const { startScheduler } = require('./scheduler/checker');

const app = express();
const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────
app.use('/api/monitors', monitorRoutes);

// Health check — useful for Docker / load balancer readiness probes.
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// 404 handler for unmatched routes.
app.use((_req, res) => res.status(404).json({ error: 'Route not found.' }));

// ─────────────────────────────────────────────────────────────────────────────
// Start server + scheduler
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  // Verify the DB connection before accepting traffic.
  await prisma.$connect();
  console.log('[db] Connected to SQLite via Prisma.');

  const server = app.listen(PORT, () => {
    console.log(`[server] Uptime Monitor API running on http://localhost:${PORT}`);
  });

  const schedulerTask = startScheduler();

  // ── Graceful shutdown ────────────────────────────────────────────────────
  // Stop cron + close the DB connection cleanly on process exit.
  // This lets any in-flight DB writes complete before the process dies.
  const shutdown = async (signal) => {
    console.log(`\n[server] ${signal} received — shutting down gracefully...`);
    schedulerTask.stop();
    server.close(async () => {
      await prisma.$disconnect();
      console.log('[server] Shutdown complete.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
