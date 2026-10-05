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
const DIST_ROOT = path.resolve(__dirname, '../../dist');
const distUrl = (rel: string): string => pathToFileURL(path.join(DIST_ROOT, rel)).href;

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
const STATE_SPEC = distUrl('lib/state.js');
const COLD_OPTS = { time: 3000, iterations: 12 } as const;

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

const SINK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-events-bench-'));
const SINK = path.join(SINK_DIR, 'events.jsonl');
_resetForTest(SINK);

afterAll(() => {
  _resetForTest();
  try { fs.rmSync(SINK_DIR, { recursive: true, force: true }); } catch {  }
});

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

for (let i = 0; i < 8; i++) emit('command.start', START_PAYLOAD);

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
