const { Router } = require('express');
const prisma = require('../lib/prisma');

const router = Router();
const PAGE_SIZE = 20;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the string is a well-formed http/https URL.
 * Uses the built-in URL constructor — no regex needed.
 */
function isValidHttpUrl(str) {
  try {
    const parsed = new URL(str);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/monitors
// Body: { name: string, url: string }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { name, url } = req.body;

  if (!name || typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: 'name is required and must be a non-empty string.' });
  }

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required.' });
  }

  if (!isValidHttpUrl(url.trim())) {
    return res.status(400).json({
      error: 'url must be a well-formed http or https URL (e.g. https://example.com).',
    });
  }

  try {
    const monitor = await prisma.monitor.create({
      data: {
        name: name.trim(),
        url: url.trim(),
      },
    });

    return res.status(201).json(monitor);
  } catch (err) {
    console.error('[POST /monitors]', err);
    return res.status(500).json({ error: 'Failed to create monitor.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/monitors
// Returns all monitors, each with their single most-recent check attached.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (_req, res) => {
  try {
    const monitors = await prisma.monitor.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        checks: {
          orderBy: { checkedAt: 'desc' },
          take: 1,
        },
      },
    });

    // Flatten: expose lastCheck directly instead of nesting an array.
    const result = monitors.map(({ checks, ...monitor }) => ({
      ...monitor,
      lastCheck: checks[0] ?? null,
    }));

    return res.json(result);
  } catch (err) {
    console.error('[GET /monitors]', err);
    return res.status(500).json({ error: 'Failed to fetch monitors.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/monitors/:id/checks
// Paginated check history for a single monitor.
// Query params: ?page=1  (default 1, page size 20)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/checks', async (req, res) => {
  const { id } = req.params;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const skip = (page - 1) * PAGE_SIZE;

  try {
    // Verify the monitor exists first.
    const monitor = await prisma.monitor.findUnique({ where: { id } });
    if (!monitor) {
      return res.status(404).json({ error: 'Monitor not found.' });
    }

    const [checks, total] = await prisma.$transaction([
      prisma.check.findMany({
        where: { monitorId: id },
        orderBy: { checkedAt: 'desc' },
        skip,
        take: PAGE_SIZE,
      }),
      prisma.check.count({ where: { monitorId: id } }),
    ]);

    return res.json({
      data: checks,
      pagination: {
        page,
        pageSize: PAGE_SIZE,
        total,
        totalPages: Math.ceil(total / PAGE_SIZE),
      },
    });
  } catch (err) {
    console.error('[GET /monitors/:id/checks]', err);
    return res.status(500).json({ error: 'Failed to fetch check history.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/monitors/:id
// Hard delete — Check rows are cascade-deleted by Prisma schema.
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await prisma.monitor.delete({ where: { id } });
    return res.status(204).send();
  } catch (err) {
    // Prisma error code P2025 = record not found
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Monitor not found.' });
    }
    console.error('[DELETE /monitors/:id]', err);
    return res.status(500).json({ error: 'Failed to delete monitor.' });
  }
});

module.exports = router;
