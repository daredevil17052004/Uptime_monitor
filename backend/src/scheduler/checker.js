const cron = require('node-cron');
const prisma = require('../lib/prisma');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const PING_TIMEOUT_MS = 10_000; // 10 seconds per request

// Error type values — kept as constants to avoid magic strings.
const ERROR_TYPE = {
  TIMEOUT: 'timeout',
  DNS_FAILURE: 'dns_failure',
  CONNECTION_REFUSED: 'connection_refused',
  BAD_STATUS: 'bad_status',
};

// Consecutive failures required before flipping currentStatus to false.
const FAIL_THRESHOLD = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Ping a single URL and return a structured result.
// Never throws — all errors are caught and classified here.
// ─────────────────────────────────────────────────────────────────────────────
async function pingUrl(url) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);

  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // Follow redirects by default (Node fetch follows up to 20).
      redirect: 'follow',
    });

    clearTimeout(timeoutHandle);
    const responseTime = Date.now() - startedAt;

    // Treat 4xx / 5xx as failures with a specific error type.
    if (!response.ok) {
      return {
        isUp: false,
        statusCode: response.status,
        responseTime,
        errorType: ERROR_TYPE.BAD_STATUS,
      };
    }

    return {
      isUp: true,
      statusCode: response.status,
      responseTime,
      errorType: null,
    };
  } catch (err) {
    clearTimeout(timeoutHandle);
    const responseTime = Date.now() - startedAt;

    // Classify the error type from the thrown exception.
    let errorType;

    if (err.name === 'AbortError') {
      errorType = ERROR_TYPE.TIMEOUT;
    } else {
      // Node fetch wraps network errors; the underlying cause has the error code.
      const code = err.cause?.code ?? err.code;

      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        errorType = ERROR_TYPE.DNS_FAILURE;
      } else if (code === 'ECONNREFUSED') {
        errorType = ERROR_TYPE.CONNECTION_REFUSED;
      } else {
        // Unknown network error — default to dns_failure as the safest bucket.
        // TODO: expand classification as more real-world cases are observed.
        errorType = ERROR_TYPE.DNS_FAILURE;
        console.warn(`[checker] Unclassified fetch error for ${url}:`, err.message, 'code:', code);
      }
    }

    return {
      isUp: false,
      statusCode: null,
      responseTime,
      errorType,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Run a single check cycle for all active monitors.
// ─────────────────────────────────────────────────────────────────────────────
async function runChecks() {
  const monitors = await prisma.monitor.findMany({
    where: { isActive: true },
    select: { id: true, url: true, noOfConsecutiveFails: true, currentStatus: true },
  });

  if (monitors.length === 0) {
    console.log('[checker] No active monitors to check.');
    return;
  }

  console.log(`[checker] Pinging ${monitors.length} monitor(s)...`);

  // Ping all monitors concurrently. Promise.allSettled ensures every monitor
  // is processed even if an individual ping rejects unexpectedly.
  const results = await Promise.allSettled(
    monitors.map(async (monitor) => {
      const pingResult = await pingUrl(monitor.url);

      // ── 1. Write a Check row regardless of outcome ──────────────────────
      await prisma.check.create({
        data: {
          monitorId: monitor.id,
          statusCode: pingResult.statusCode,
          responseTime: pingResult.responseTime,
          isUp: pingResult.isUp,
          errorType: pingResult.errorType,
          // checkedAt defaults to now() in the schema
        },
      });

      // ── 2. Compute new monitor state ─────────────────────────────────────
      let newConsecutiveFails;
      let newCurrentStatus;

      if (pingResult.isUp) {
        newConsecutiveFails = 0;
        newCurrentStatus = true; // Flip back immediately on a single success.
      } else {
        newConsecutiveFails = monitor.noOfConsecutiveFails + 1;
        // Only mark as DOWN after reaching the fail threshold.
        newCurrentStatus = newConsecutiveFails >= FAIL_THRESHOLD ? false : monitor.currentStatus;
      }

      // ── 3. Update the Monitor row ─────────────────────────────────────────
      await prisma.monitor.update({
        where: { id: monitor.id },
        data: {
          noOfConsecutiveFails: newConsecutiveFails,
          currentStatus: newCurrentStatus,
        },
      });

      // Structured log for easy debugging / future log ingestion.
      console.log(
        `[checker] ${monitor.url} → ${pingResult.isUp ? 'UP' : 'DOWN'} ` +
          `| status: ${pingResult.statusCode ?? 'N/A'} ` +
          `| ${pingResult.responseTime}ms ` +
          `| error: ${pingResult.errorType ?? 'none'} ` +
          `| consecutiveFails: ${newConsecutiveFails}`
      );
    })
  );

  // Log any unexpected Promise rejections (shouldn't happen, but defensive).
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(`[checker] Unexpected failure for monitor index ${i}:`, result.reason);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduler — fires every 60 seconds.
//
// Skip-tick guard: if the previous cycle hasn't finished, the new cron tick
// is skipped entirely. This prevents overlapping runs from piling up under
// slow networks or a large number of monitors.
// ─────────────────────────────────────────────────────────────────────────────
let isRunning = false;

function startScheduler() {
  const task = cron.schedule('*/60 * * * * *', async () => {
    if (isRunning) {
      console.warn('[checker] Previous check cycle still running — skipping this tick.');
      return;
    }

    isRunning = true;
    try {
      await runChecks();
    } catch (err) {
      console.error('[checker] Unhandled error in check cycle:', err);
    } finally {
      isRunning = false;
    }
  });

  console.log('[checker] Scheduler started. Checks will run every 60 seconds.');
  return task;
}

module.exports = { startScheduler };
