/**
 * Benchmark: the event-emission + provenance bootstrap that index.ts pays.
 *
 * `index.ts:213-214` imports `{ emit, emitFriction, redactArgs }` from
 * `./lib/events.js` and `{ stampProvenance }` from `./lib/event-provenance.js`
 * EAGERLY — top-level, before commander parses argv (`program.parseAsync()` at
 * index.ts:1440 is reached only after all module evaluation). Every `agents`
 * process pays the module-graph evaluation cost, including the `--version` /
 * `--help` fast paths that never emit an event. The `emit`/`redactArgs`/
 * `stampProvenance` RUNTIME cost is then paid on every real command: the root
 * program's `preAction` hook calls `redactArgs(process.argv.slice(2, 22))` +
 * `emit('command.start', …)` (index.ts:292-300) and `postAction` calls
 * `emit('command.end', …)` + `stampProvenance()` (index.ts:314-337);
 * `emitFriction` is the `_internal friction` path (index.ts:942).
 *
 * WHY THIS FILE, NOT index.bench.ts. `src/lib/index.bench.ts` already lists
 * `events.js` and `event-provenance.js` in its `EAGER_MINUS_BRAND` cold-import
 * spec list (index.bench.ts:464-465) but times them ONLY inside the 12-module
 * `EAGER_MINUS_BRAND` / `EAGER_WITH_BRAND` bundles — no per-module row isolates
 * these two, and its docblock (index.bench.ts:295-300) says the per-import
 * cold-child breakdown is owned by the open sibling PR #2280, so adding those
 * rows there would collide. And the RUNTIME cost of `emit` / `emitFriction` /
 * `redactArgs` / `stampProvenance` — the actual functions this hot path calls —
 * is measured in NO bench today. Both belong beside their source
 * (`events.ts` / `event-provenance.ts`), which is here.
 *
 * NO MOCKING. Group A spawns real cold `node` processes importing the real
 * BUILT `dist/lib/*.js` artifacts (the module graph a shipped install evaluates,
 * incl. the third-party edges `proper-lockfile` via fs-atomic.ts and `yaml` via
 * state.ts). Group B calls the real exported functions against a real temp
 * events sink — `emit()` takes the real proper-lockfile lock, appends to a real
 * file, runs the real rotate/prune size checks — on realistic argv/payloads
 * matching index.ts's own call sites.
 */
import { describe, bench, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { emit, emitFriction, redactArgs, _resetForTest } from './feed/events.js';
import { stampProvenance, resetEventProvenanceForTest } from './event-provenance.js';
import { resetActorCache } from './actor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** dist/ of THIS checkout — src/lib/ is two levels under cli, dist is a sibling of src. */
const DIST_ROOT = path.resolve(__dirname, '../../dist');
const distUrl = (rel: string): string => pathToFileURL(path.join(DIST_ROOT, rel)).href;

/**
 * Import `specs` in a fresh Node process. Node caches an ESM module for the life
 * of a process, so only a fresh process yields an honest module-LOAD number; a
 * second in-process `import()` would time a Map lookup. Every Group-A row spawns
 * the identical shape, so the constant Node spawn floor cancels between rows and
 * (row - FLOOR) is that graph's own evaluation cost. Throws on a non-zero exit
 * so a moved/mistyped specifier — which exits FASTER than the floor and would
 * otherwise read as the quickest row — cannot post a false number.
 */
function coldEval(specs: string[]): void {
  const src = specs.map((s) => `await import(${JSON.stringify(s)});`).join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (r.status !== 0) {
    throw new Error(
      `cold import failed (status ${r.status}, signal ${r.signal}): ${String(r.stderr).slice(0, 400)}`,
    );
  }
}

const EVENTS_SPEC = distUrl('lib/events.js');
const PROVENANCE_SPEC = distUrl('lib/event-provenance.js');
/**
 * state.js is ALREADY eager via index.ts:513, and it is the source of the two
 * heavy third-party edges the event modules also pull: `yaml` (state.ts:29) and
 * `proper-lockfile` (state.ts:31 → fs-atomic.ts:4). So the honest "cost this hot
 * path ADDS to startup" is (state + events + provenance) − (state alone), not
 * the isolated events.js number — most of which is shared, already-paid graph.
 */
const STATE_SPEC = distUrl('lib/state.js');
const COLD_OPTS = { time: 3000, iterations: 12 } as const;

/**
 * Prove both dist specs resolve at MODULE scope — a throw here aborts the whole
 * file where vitest reports it (a real Failed Suite), before any row is timed.
 * A throw inside a `bench` callback is swallowed by tinybench and merely posts
 * `NaN` for that row (see index.bench.ts:412-421), so this preflight is what
 * makes a bad/stale dist build loud instead of silently mis-measured.
 */
(function preflightColdImports(): void {
  coldEval([EVENTS_SPEC]);
  coldEval([PROVENANCE_SPEC]);
  coldEval([EVENTS_SPEC, PROVENANCE_SPEC]);
  coldEval([STATE_SPEC]);
  coldEval([STATE_SPEC, EVENTS_SPEC, PROVENANCE_SPEC]);
})();

describe('cold module-graph evaluation — index.ts:213-214 eager imports, paid before parse on EVERY invocation incl. --version/--help', () => {
  bench('FLOOR: bare `node --input-type=module -e ""` — the spawn cost every row below also pays; subtract it', () => {
    coldEval([]);
  }, COLD_OPTS);

  bench('lib/event-provenance.js alone (index.ts:214). Graph: actor.js, machine-id.js, session/provenance.js, state.js (yaml) (event-provenance.ts:1-4, actor.ts:23-27)', () => {
    coldEval([PROVENANCE_SPEC]);
  }, COLD_OPTS);

  bench('lib/events.js alone (index.ts:213). Heavier graph: fs-atomic.js (proper-lockfile), state.js (yaml), event-provenance.js, actor.js (events.ts:15-23)', () => {
    coldEval([EVENTS_SPEC]);
  }, COLD_OPTS);

  bench('BOTH together — the exact index.ts:213-214 pair. events.js already pulls event-provenance.js, so this is the real marginal cost of the two-line import block', () => {
    coldEval([EVENTS_SPEC, PROVENANCE_SPEC]);
  }, COLD_OPTS);
});

describe('MARGINAL cost over the already-eager baseline — state.js is loaded regardless (index.ts:513) and owns the yaml + proper-lockfile edges the event modules share', () => {
  bench('BASELINE: lib/state.js alone — already eager via index.ts:513; pulls yaml (state.ts:29) + fs-atomic → proper-lockfile (state.ts:31)', () => {
    coldEval([STATE_SPEC]);
  }, COLD_OPTS);

  bench('state.js + events.js + event-provenance.js — subtract the baseline above for the TRUE marginal cost the event bootstrap adds once state.js is already loaded', () => {
    coldEval([STATE_SPEC, EVENTS_SPEC, PROVENANCE_SPEC]);
  }, COLD_OPTS);
});

// ─── Group B: runtime cost of the four hot-path functions ────────────────────
//
// Real temp events sink so emit() exercises the actual append/lock/rotate path,
// not a stub. _resetForTest(path) sets _eventsPathOverride (events.ts:1490-1497)
// so both the active log and the prune marker live under this temp dir — same
// seam events.test.ts uses (events.test.ts:42). Warm-up emits below write the
// prune marker + prime the provenance/chmod caches so every TIMED emit measures
// steady state, not the one-time first-append prune (events.ts:1229-1240).
const SINK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-events-bench-'));
const SINK = path.join(SINK_DIR, 'events.jsonl');
_resetForTest(SINK);

afterAll(() => {
  _resetForTest();
  try { fs.rmSync(SINK_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

/**
 * A realistic `agents run` argv (index.ts:298 audits `process.argv.slice(2, 22)`).
 * Exercises the real redaction branches: a `--prompt` over 200 chars → sha256
 * marker (events.ts:557, 582), a `--session`/`--device` passthrough, and a
 * secret-shaped path caught by SECRET_PATH (events.ts:588).
 */
const REALISTIC_ARGV = [
  'run', 'claude', '--mode', 'auto',
  '--prompt', 'Benchmark the event-emission bootstrap in cli: read index.ts:213-214, events.ts and event-provenance.ts end to end, commit a vitest bench beside the source that exercises the real emit/redactArgs/stampProvenance path against a temp sink, then propose optimizations from the measured numbers.',
  '--session', 'ce1e00cb-61dc-4c62-b30e-f053ef6ce990',
  '--device', 'yosemite-s1',
  '--remote-cwd', '/home/muqsit/src/github.com/muqsitnawaz/agents-cli',
];

const START_PAYLOAD = {
  module: 'run',
  command: 'run claude',
  args: redactArgs(REALISTIC_ARGV),
  cwd: process.cwd(),
} as const;
const END_PAYLOAD = { module: 'run', command: 'run claude', durationMs: 1234 } as const;

// Prime the sink (prune marker + provenance/chmod caches) so timed emits are steady state.
for (let i = 0; i < 8; i++) emit('command.start', START_PAYLOAD);

/**
 * Time-bounded (300ms) so the cumulative sink stays well under the 10 MiB
 * gzip-rotation threshold (events.ts:107) and no rotation skews a sample —
 * verified empirically: no `events.*.jsonl.gz` archive is created across runs.
 */
const EMIT_OPTS = { time: 300, iterations: 20, warmupTime: 100 } as const;

describe('redactArgs — index.ts:298, preAction on every command. Real regex passes over a realistic 22-arg `agents run` line, incl. the >200-char --prompt sha256 branch', () => {
  bench('redactArgs(process.argv.slice(2, 22)) on the realistic argv', () => {
    redactArgs(REALISTIC_ARGV);
  });
});

describe('stampProvenance — the shared identity floor every emit() spreads (events.ts:706) and postAction calls directly (index.ts:337)', () => {
  bench('WARM: cached origin + cached machineId — the steady-state cost paid by every emit after the first (event-provenance.ts:53-62)', () => {
    stampProvenance();
  });

  bench('COLD: every sample genuinely cold — reset both caches IN the timed body (the resets set 3 vars to undefined, ~ns), so each call re-runs os.userInfo() + resolveActor() → readMeta() (agents.yaml disk read + yaml parse, actor.ts:82-88,154) + os.hostname()', () => {
    resetEventProvenanceForTest();
    resetActorCache();
    stampProvenance();
  });
});

describe('emit — the real append path (index.ts:292, 314). proper-lockfile lock + appendFileSync + rotate/prune size checks against a real temp sink (events.ts:696-744)', () => {
  bench("emit('command.start', {module,command,args,cwd}) — the preAction record (index.ts:292-300)", () => {
    emit('command.start', START_PAYLOAD);
  }, EMIT_OPTS);

  bench("emit('command.end', {module,command,durationMs}) — the postAction record (index.ts:314-318)", () => {
    emit('command.end', END_PAYLOAD);
  }, EMIT_OPTS);

  bench("emitFriction('guard', 'git.reset-hard', {command,error}) — the _internal friction path (index.ts:942, events.ts:1037-1047)", () => {
    emitFriction('guard', 'git.reset-hard', { command: 'git reset --hard origin/main', error: 'blocked by git-guard' });
  }, EMIT_OPTS);
});

describe('the composed per-command runtime tax — what preAction + postAction actually run around one command (index.ts:292-337)', () => {
  bench('redactArgs(argv) + emit(command.start) + emit(command.end) + stampProvenance() — the full audit envelope, two real appends', () => {
    const args = redactArgs(REALISTIC_ARGV);
    emit('command.start', { module: 'run', command: 'run claude', args, cwd: process.cwd() });
    emit('command.end', END_PAYLOAD);
    stampProvenance();
  }, EMIT_OPTS);
});
