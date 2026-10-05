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
const DIST_ROOT = path.resolve(__dirname, '../../dist');
const distUrl = (rel: string): string => pathToFileURL(path.join(DIST_ROOT, rel)).href;

const STATE_SPEC = distUrl('lib/state.js');
const EVENTS_SPEC = distUrl('lib/events.js');
const PROVENANCE_SPEC = distUrl('lib/event-provenance.js');

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
