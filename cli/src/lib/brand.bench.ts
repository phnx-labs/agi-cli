import { describe, bench } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  resolveBrandName,
  activeBrandName,
  isBranded,
  disabledCommandsForActiveBrand,
} from './brand.js';
import { readMeta } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

delete process.env.AGENTS_BRAND;

const BENCH_BRAND = 'benchbrand';
const setBranded = () => { process.env.AGENTS_BRAND = BENCH_BRAND; };
const clearBranded = () => { delete process.env.AGENTS_BRAND; };

describe('brand runtime compute — bootstrap.ts brand path (unbranded fast path) (unbranded fast path)', () => {
  bench('resolveBrandName() — env read + regex test, AGENTS_BRAND unset (brand.ts:34-38)', () => {
    resolveBrandName();
  });

  bench('activeBrandName() — unbranded, returns null (brand.ts:41-44)', () => {
    activeBrandName();
  });

  bench('isBranded() — unbranded (brand.ts:47-49)', () => {
    isBranded();
  });

  bench('disabledCommandsForActiveBrand() — THE index.ts:1244 call, unbranded: short-circuits before readMeta, `new Set([])` (brand.ts:102-105 -> brand.ts:86)', () => {
    disabledCommandsForActiveBrand();
  });
});

describe('brand runtime compute — branded invocation (AGENTS_BRAND set): the readMeta hop', () => {
  bench('resolveBrandName() — branded, regex-validated name returned (brand.ts:36)', () => {
    resolveBrandName();
  }, { setup: setBranded, teardown: clearBranded });

  bench('disabledCommandsForActiveBrand() — branded: activeBrandName -> getBrandConfig -> listBrands -> readMeta().brands (brand.ts:102 -> brand.ts:70 -> state.ts:1124), meta cache warm after first call', () => {
    disabledCommandsForActiveBrand();
  }, { setup: setBranded, teardown: clearBranded });

  bench('readMeta() alone — the branded add-on, warm stamp-keyed cache hit (state.ts:1130-1134, ~2 stat syscalls + spread)', () => {
    readMeta();
  });
});

const distUrl = (p: string): string =>
  pathToFileURL(path.resolve(__dirname, '../../dist/lib', p)).href;

function coldImport(specs: string[]): void {
  const src = specs.map((s) => `await import(${JSON.stringify(s)});`).join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src || ';'], {
    stdio: 'ignore',
  });
  if (r.status !== 0) {
    throw new Error(
      `cold import failed (status ${r.status}, signal ${r.signal}): ${String(r.stderr).slice(0, 400)}`,
    );
  }
}

const EAGER_MINUS_BRAND = [
  'startup/dev-build.js',
  'secrets/sync-commands.js',
  'self-update.js',
  'startup/command-registry.js',
  'help.js',
  'whats-new.js',
  'platform/index.js',
  'cli-entry.js',
  'events.js',
  'event-provenance.js',
  'format.js',
  'state.js',
].map(distUrl);
const EAGER_WITH_BRAND = [...EAGER_MINUS_BRAND, distUrl('brand.js')];

const COLD = { time: 0, iterations: 20, warmupIterations: 3 } as const;

describe('cold module import — isolate what the brand.js edge costs (real node subprocess per sample)', () => {
  bench('baseline: empty `node -e` process (fork+exec+runtime, no user import)', () => {
    coldImport([]);
  }, COLD);

  bench('import dist/lib/brand.js — brand.js + its full transitive (state.js + agent-cli-commands.js; no agents.js after RUSH-2331) into a fresh process', () => {
    coldImport([distUrl('brand.js')]);
  }, COLD);

  bench('import dist/lib/state.js alone — already paid at index.ts:513 regardless of brand', () => {
    coldImport([distUrl('state.js')]);
  }, COLD);

  bench('import dist/lib/agents.js alone — REGRESSION BASELINE; brand no longer imports this after RUSH-2331', () => {
    coldImport([distUrl('agents.js')]);
  }, COLD);

  bench('import dist/lib/types.js alone — the third brand.js import (mostly type-only)', () => {
    coldImport([distUrl('types.js')]);
  }, COLD);
});

describe('cold module import — brand.js MARGINAL cost on top of the rest of the eager graph', () => {
  bench('EAGER_MINUS_BRAND: the 12 other index.ts eager local imports, no brand edge', () => {
    coldImport(EAGER_MINUS_BRAND);
  }, COLD);

  bench('EAGER_WITH_BRAND: same 12 + dist/lib/brand.js (index.ts:514) — delta vs above is brand.js\'s true marginal startup cost, net of any transitive sharing', () => {
    coldImport(EAGER_WITH_BRAND);
  }, COLD);
});
