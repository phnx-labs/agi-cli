/** Benchmark of the state.ts bootstrap every `agents` invocation pays (index.ts:532 imports four
 * path helpers eagerly) plus their runtime cost. A fresh Worker per sample (cold ESM registry)
 * replaces spawnSync's ~17ms process-spawn noise. No mocking: real built dist and real $HOME. */
import { describe, bench } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  getUpdateCheckPath,
  getMigratedSentinelPath,
  getUserAgentsDir,
  getRuntimeStateDir,
} from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** dist/ of THIS checkout — src/lib/ is two levels under cli, dist is a sibling of src. */
const DIST_ROOT = path.resolve(__dirname, '../../dist');
const distUrl = (rel: string): string => pathToFileURL(path.join(DIST_ROOT, rel)).href;

const STATE_SPEC = distUrl('lib/state.js');
const EVENTS_SPEC = distUrl('lib/events.js');
const PROVENANCE_SPEC = distUrl('lib/event-provenance.js');

/** Import `specs` in order inside a fresh worker thread and resolve when all settle. Throws on a
 * worker error or rejected import, so a moved/mistyped specifier cannot post a fast wrong number
 * (as `events.bench.ts`'s `coldEval` guards). */
function workerColdEval(specs: string[]): Promise<void> {
  const importLines = specs.map((s) => `await import(${JSON.stringify(s)});`).join('\n');
  const src = `
    const { parentPort } = require('node:worker_threads');
    (async () => {
      ${importLines}
      parentPort.postMessage({ ok: true });
    })().catch((err) => {
      parentPort.postMessage({ ok: false, error: String((err && err.stack) || err) });
    });
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(src, { eval: true });
    const cleanup = (fn: () => void) => {
      worker.terminate().finally(fn);
    };
    worker.once('message', (msg: { ok: boolean; error?: string }) => {
      if (msg.ok) cleanup(resolve);
      else cleanup(() => reject(new Error(msg.error)));
    });
    worker.once('error', (err) => cleanup(() => reject(err)));
  });
}

const COLD_OPTS = { time: 3000, iterations: 12 } as const;

/** Prove every spec resolves: a throw here fails the suite loudly before timing, while a throw
 * inside a `bench` callback is swallowed by tinybench and posts `NaN`, so this makes a stale or
 * missing dist build loud. */
await (async function preflightColdImports(): Promise<void> {
  await workerColdEval([]);
  await workerColdEval([STATE_SPEC]);
  await workerColdEval([STATE_SPEC, EVENTS_SPEC, PROVENANCE_SPEC]);
})();

describe('cold module-graph evaluation, worker-thread isolated — index.ts:532 eager import of state.js, paid before parse on EVERY invocation incl. --version/--help', () => {
  bench('FLOOR: empty worker thread, no import — the thread-creation cost every row below also pays; subtract it', () => {
    return workerColdEval([]);
  }, COLD_OPTS);

  bench('lib/state.js alone (index.ts:532). Pulls yaml (state.ts:29) + fs-atomic -> proper-lockfile (state.ts:31)', () => {
    return workerColdEval([STATE_SPEC]);
  }, COLD_OPTS);

  bench('CROSS-CHECK: state.js + events.js + event-provenance.js — same three-module set events.bench.ts times via spawnSync, timed here via worker thread instead', () => {
    return workerColdEval([STATE_SPEC, EVENTS_SPEC, PROVENANCE_SPEC]);
  }, COLD_OPTS);
});

// Group B: runtime cost of the four getters index.ts calls at startup, in-process against the real
// `$HOME/.agents`.
describe('runtime cost of the four state.ts getters index.ts:532 imports and calls at startup (index.ts:544,555,1372,1429)', () => {
  bench("getUpdateCheckPath() — index.ts:544, called at module scope on every invocation", () => {
    getUpdateCheckPath();
  });

  bench("getUserAgentsDir() — index.ts:1372, called at module scope on every invocation (firstRun/metaFilePath check)", () => {
    getUserAgentsDir();
  });

  bench("getMigratedSentinelPath() — index.ts:1429, called at module scope unless AGENTS_SKIP_MIGRATION=1", () => {
    getMigratedSentinelPath();
  });

  bench("getRuntimeStateDir() — index.ts:555, called inside maybeWarnMultiInstall() (gated, not module-scope)", () => {
    getRuntimeStateDir();
  });

  bench('all four in sequence — the actual per-invocation call pattern index.ts exercises', () => {
    getUpdateCheckPath();
    getUserAgentsDir();
    getMigratedSentinelPath();
    getRuntimeStateDir();
  });
});
