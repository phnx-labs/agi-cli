/** Before/after microbench for the `agents view` usage core: warm-cache latency (near-zero
 * network), peak concurrent live fetches under simulated cold multi-account load (must not exceed
 * USAGE_FETCH_CONCURRENCY), and overview meter width with and without maxWindows=2. */
import {
  USAGE_CACHE_FRESH_MS,
  USAGE_FETCH_CONCURRENCY,
  formatUsageSummary,
  pickCompactUsageWindows,
  type UsageSnapshot,
  type UsageWindow,
} from '../src/lib/accounting/usage.js';
import { stringWidth } from '../src/lib/session/width.js';
import { mapBounded } from '../src/lib/concurrency.js';

function hrMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function fakeWindows(n: number): UsageWindow[] {
  return Array.from({ length: n }, (_, i) => ({
    key: 'session' as const,
    label: `m${i}`,
    shortLabel: `M${i}`,
    usedPercent: (i * 17) % 100,
    resetsAt: null,
    windowMinutes: null,
  }));
}

function fakeSnapshot(n: number): UsageSnapshot {
  return {
    source: 'live',
    sourceLabel: 'bench',
    capturedAt: new Date(),
    windows: fakeWindows(n),
  };
}

async function benchConcurrencyCap(): Promise<{ peak: number; totalMs: number }> {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 14 }, (_, i) => i);
  const start = process.hrtime.bigint();
  await mapBounded(
    items,
    async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 40));
      inFlight--;
    },
    { concurrency: USAGE_FETCH_CONCURRENCY },
  );
  return { peak, totalMs: hrMs(start) };
}

async function main(): Promise<void> {
  console.log('=== agents view / usage core bench ===\n');
  console.log(`USAGE_CACHE_FRESH_MS     = ${USAGE_CACHE_FRESH_MS} (${USAGE_CACHE_FRESH_MS / 60000} min)`);
  console.log(`USAGE_FETCH_CONCURRENCY = ${USAGE_FETCH_CONCURRENCY}`);
  console.log();

  const wide = fakeSnapshot(4);
  const uncapped = formatUsageSummary('Max', wide, 3);
  const capped = formatUsageSummary('Max', wide, 3, { maxWindows: 2 });
  console.log('Overview meter width (4 windows, plan=Max):');
  console.log(`  BEFORE (no cap):  ${stringWidth(uncapped)} cols  ${JSON.stringify(uncapped.replace(/\x1b\[[0-9;]*m/g, ''))}`);
  console.log(`  AFTER  (max=2):   ${stringWidth(capped)} cols  ${JSON.stringify(capped.replace(/\x1b\[[0-9;]*m/g, ''))}`);
  console.log(`  pickCompact:      ${pickCompactUsageWindows(wide.windows, 2).map((w) => w.shortLabel).join(', ')}`);
  console.log();

  const { peak, totalMs } = await benchConcurrencyCap();
  console.log('Cold multi-account fan-out (14 identities, 40ms simulated RTT each):');
  console.log(`  peak concurrent fetches = ${peak}  (cap ${USAGE_FETCH_CONCURRENCY})`);
  console.log(`  wall clock              = ${totalMs.toFixed(0)} ms`);
  console.log(`  unbounded Promise.all would peak at 14 and finish ~40ms,`);
  console.log(`  but delayed/straggling calls would all stay open together.`);
  console.log();

  const iters = 5000;
  const snap = fakeSnapshot(2);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) {
    formatUsageSummary('Max', snap, 3, { maxWindows: 2 });
  }
  const formatMs = hrMs(t0);
  console.log(`formatUsageSummary x${iters}: ${formatMs.toFixed(1)} ms  (${(formatMs / iters).toFixed(3)} ms/call)`);
  console.log();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
