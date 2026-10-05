#!/usr/bin/env bun
/** Benchmarks the staleness library against a real cwd and agent@version: `bun
 * scripts/bench-staleness.ts <cwd> <agent> <version> [--iters=N]` (defaults: PWD, claude, its
 * default version, 50). Reports min/median/p95/max/mean per scenario plus resource counts. */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  buildManifest,
  isStale,
  loadManifest,
  saveManifest,
  type SyncManifest,
} from '../src/lib/staleness/index.js';
import { commandsChecker }   from '../src/lib/staleness/checkers/commands.js';
import { skillsChecker }     from '../src/lib/staleness/checkers/skills.js';
import { hooksChecker }      from '../src/lib/staleness/checkers/hooks.js';
import { mcpChecker }        from '../src/lib/staleness/checkers/mcp.js';
import { subagentsChecker }  from '../src/lib/staleness/checkers/subagents.js';
import { workflowsChecker }  from '../src/lib/staleness/checkers/workflows.js';
import { pluginsChecker }    from '../src/lib/staleness/checkers/plugins.js';

// ─── arg parsing ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith('--')).map((a) => {
    const eq = a.indexOf('=');
    return eq === -1 ? [a.slice(2), 'true'] : [a.slice(2, eq), a.slice(eq + 1)];
  })
);

const cwd     = positional[0] ?? process.cwd();
const agent   = (positional[1] as 'claude' | 'codex' | 'gemini') ?? 'claude';
const version = positional[2] ?? '2.1.138';
const iters   = Number(flags.iters ?? '50');

// ─── helpers ─────────────────────────────────────────────────────────────────
function ns(): bigint { return process.hrtime.bigint(); }
function us(d: bigint): number { return Number(d) / 1000; }

const fmt = (v: number) => v < 1000 ? `${v.toFixed(1)}µs` : `${(v / 1000).toFixed(2)}ms`;

/** Time a function once with no warmup — measures the cold path. */
function benchCold(label: string, fn: () => void): void {
  const t = ns();
  fn();
  const cold = us(ns() - t);
  console.log(`  ${label.padEnd(36)} cold=${fmt(cold)}`);
}

function bench(label: string, fn: () => void, n = iters): void {
  // warmup
  fn(); fn(); fn();
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = ns();
    fn();
    samples.push(us(ns() - t));
  }
  samples.sort((a, b) => a - b);
  const min = samples[0];
  const max = samples[samples.length - 1];
  const median = samples[Math.floor(n * 0.5)];
  const p95 = samples[Math.floor(n * 0.95)];
  const mean = samples.reduce((s, v) => s + v, 0) / n;
  console.log(
    `  ${label.padEnd(36)} ` +
    `min=${fmt(min).padEnd(8)} ` +
    `p50=${fmt(median).padEnd(8)} ` +
    `p95=${fmt(p95).padEnd(8)} ` +
    `max=${fmt(max).padEnd(8)} ` +
    `mean=${fmt(mean)}`
  );
}

// ─── resource counts (for context) ───────────────────────────────────────────
const counts = {
  commands:  commandsChecker.listNames(cwd).length,
  skills:    skillsChecker.listNames(cwd).length,
  hooks:     hooksChecker.listNames(cwd).length,
  mcp:       mcpChecker.listNames(cwd).length,
  subagents: subagentsChecker.listNames(cwd).length,
  workflows: workflowsChecker.listNames(cwd).length,
  plugins:   pluginsChecker.listNames(cwd).length,
};
const total = Object.values(counts).reduce((a, b) => a + b, 0);

console.log(`bench: ${agent}@${version}`);
console.log(`cwd:   ${cwd}`);
console.log(`iters: ${iters}`);
console.log('resources:', counts, `(total ${total})`);
console.log();

// ─── scenarios ───────────────────────────────────────────────────────────────
// 1. Cold buildManifest — full fingerprint walk
console.log('buildManifest (cold full-tree fingerprint walk):');
let m: SyncManifest | null = null;
bench('  build', () => { m = buildManifest(agent, version, cwd); });
saveManifest(agent, version, m!);
console.log();

// 2a. isStale cold: the first call in a fresh process, what each of a 50-concurrent-agent burst's
// processes pays. The layer memoization is cold here; later calls in the same process take the
// warm path measured below.
console.log('isStale (cold — first call in a fresh process):');
const loaded = loadManifest(agent, version)!;
// Reset module-level layer cache before the cold measurement.
const { clearLayerCache } = await import('../src/lib/staleness/layers.js');
clearLayerCache();
benchCold('  isStale (cold first call)', () => { isStale(loaded, agent, version, cwd); });
console.log();

// 2b. isStale (warm, clean) — subsequent calls in the same process
console.log('isStale (warm, clean — within same process):');
bench('  isStale (clean)', () => { isStale(loaded, agent, version, cwd); });
console.log();

// 3. isStale (warm, mutated) — single file touched
//    We mutate a synthetic temp file inside the user layer, so we don't
//    perturb actual sources. Reset between iterations to keep the path stable.
console.log('isStale (warm, single content change):');
const probeRel = 'commands/__bench-probe.md';
const userBase = path.join(process.env.HOME ?? os.homedir(), '.agents');
const probePath = path.join(userBase, probeRel);
const probeDir = path.dirname(probePath);
fs.mkdirSync(probeDir, { recursive: true });
fs.writeFileSync(probePath, 'probe v0\n');
const withProbe = buildManifest(agent, version, cwd);
bench('  isStale (after content swap)', () => {
  // Rewrite with different size each iter so mtime+size differ; sha256 catches it.
  fs.writeFileSync(probePath, 'probe v' + Math.random() + '\n');
  isStale(withProbe, agent, version, cwd);
});
fs.unlinkSync(probePath);
console.log();

// 4. isStale (warm, name-set diff) — file added vs. manifest
console.log('isStale (warm, name-set diff — file added):');
bench('  isStale (added name)', () => {
  const p = path.join(userBase, `commands/__bench-add-${process.pid}.md`);
  fs.writeFileSync(p, 'added\n');
  try { isStale(withProbe, agent, version, cwd); }
  finally { fs.unlinkSync(p); }
});
console.log();

// 5. Cleanup — restore the original manifest the user had pinned
console.log('done.');
