/** Benchmark for the `--device` passthrough bootstrap. RUSH-2374 gates the passthrough.js import
 * on hasHostRoutingFlag; this prices module graph and body to catch regressions. Side-effect-
 * free branches only. Run by hand: `npx vitest bench --run src/lib/hosts/passthrough.bench.ts`. */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { bench, describe } from 'vitest';
import { maybeRunOnHost, flagValue } from './passthrough.js';
import { hasHostRoutingFlag } from './routing-flag.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/lib/hosts -> cli
const cliRoot = path.resolve(here, '../../..');
const distPassthrough = path.join(cliRoot, 'dist/lib/hosts/passthrough.js');
const distRoutingFlag = path.join(cliRoot, 'dist/lib/hosts/routing-flag.js');

// Fail loud rather than silently skipping: a cold-import number measured
// against a missing artifact would be meaningless.
if (!fs.existsSync(distPassthrough)) {
  throw new Error(
    `passthrough.bench.ts needs the built artifact at ${distPassthrough}. ` +
      `Build it first: bash scripts/build.sh (from cli).`,
  );
}
if (!fs.existsSync(distRoutingFlag)) {
  throw new Error(
    `passthrough.bench.ts needs the built artifact at ${distRoutingFlag}. ` +
      `Build it first: bash scripts/build.sh (from cli).`,
  );
}

/** Spawn a fresh node and return only after it exits — one full cold start. */
function coldNode(source: string): void {
  execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    stdio: 'ignore',
    cwd: cliRoot,
  });
}

const distUrl = pathToFileURL(distPassthrough).href;
const routingFlagUrl = pathToFileURL(distRoutingFlag).href;

describe('cold module graph (per CLI invocation, out-of-process)', () => {
  bench(
    'node baseline (no import)',
    () => {
      coldNode('void 0;');
    },
    { iterations: 20, time: 0 },
  );

  bench(
    'node + import dist/lib/hosts/routing-flag.js (the bootstrap gate)',
    () => {
      coldNode(`await import(${JSON.stringify(routingFlagUrl)});`);
    },
    { iterations: 20, time: 0 },
  );

  bench(
    'node + import dist/lib/hosts/passthrough.js (routed path only)',
    () => {
      coldNode(`await import(${JSON.stringify(distUrl)});`);
    },
    { iterations: 20, time: 0 },
  );
});

/** Which of passthrough.ts's static imports carry the module graph, each imported alone in a
 * fresh process. Subgraphs overlap, so they do not sum to the whole; all are reached only after
 * a routing flag is found. */
const HEAVY_IMPORTS: Array<[string, string]> = [
  ['lib/smart-launch.js', 'smart-launch.js'],
  ['lib/hosts/dispatch.js', 'hosts/dispatch.js'],
  ['lib/hosts/registry.js', 'hosts/registry.js'],
  ['lib/machine-id.js (leaf, was session/sync/config.js)', 'machine-id.js'],
  ['lib/session/sync/config.js (pre-fix path — for delta)', 'session/sync/config.js'],
  ['lib/devices/health-report.js', 'devices/health-report.js'],
  ['lib/startup/command-registry.js', 'startup/command-registry.js'],
];

describe('cold import per static dependency (out-of-process)', () => {
  for (const [label, rel] of HEAVY_IMPORTS) {
    const target = path.join(cliRoot, 'dist/lib', rel);
    bench(
      label,
      () => {
        coldNode(`await import(${JSON.stringify(pathToFileURL(target).href)});`);
      },
      { iterations: 20, time: 0 },
    );
  }
});

/** Realistic no-flag invocations (the 100% local case); each returns false at passthrough.ts:473
 * after four `flagValue` scans. */
const NO_FLAG_ARGVS: Array<[string, string[]]> = [
  ['view', ['view']],
  ['sync claude --yes', ['sync', 'claude', '--yes']],
  ['skills list', ['skills', 'list']],
  ['doctor', ['doctor']],
  [
    'run claude (long argv)',
    ['run', 'claude', '--mode', 'edit', '--name', 'bench', '--profile', 'default', '-p', 'do the thing', '--json'],
  ],
];

describe('hasHostRoutingFlag — bootstrap gate (warm, leaf)', () => {
  for (const [label, argv] of NO_FLAG_ARGVS) {
    bench(`agents ${label}`, () => {
      hasHostRoutingFlag(argv);
    });
  }
});

describe('maybeRunOnHost — no routing flag (warm graph)', () => {
  for (const [label, argv] of NO_FLAG_ARGVS) {
    bench(`agents ${label}`, async () => {
      await maybeRunOnHost(argv[0], argv);
    });
  }
});

describe('maybeRunOnHost — routing flag present, side-effect-free returns', () => {
  // OWN_HOST_COMMANDS member -> returns false at passthrough.ts early exit.
  bench('agents sessions --device box (own-host early return)', async () => {
    await maybeRunOnHost('sessions', ['sessions', '--device', 'box']);
  });

  // Not a known top-level command -> returns false at unknown-command gate.
  bench('agents sessoins --device box (unknown-command return)', async () => {
    await maybeRunOnHost('sessoins', ['sessoins', '--device', 'box']);
  });
});

describe('flagValue — the three argv scans maybeRunOnHost always runs when loaded', () => {
  const short = ['view'];
  const long = NO_FLAG_ARGVS[4][1];

  bench('flagValue x3 over ["view"]', () => {
    flagValue(short, 'device', 'D');
    flagValue(short, 'hosts');
    flagValue(short, 'devices');
  });

  bench('flagValue x3 over an 11-token argv', () => {
    flagValue(long, 'device', 'D');
    flagValue(long, 'hosts');
    flagValue(long, 'devices');
  });
});
