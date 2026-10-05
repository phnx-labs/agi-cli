/** Benchmark for the SessionStart-hook state reader (hook-sessions.ts), joined on the ~3s `agents
 * sessions --active` poll. Real functions on real JSON files; HOME is set BEFORE the dynamic
 * import. Seeds: 60 files for `terminals/sessions/`, the measured 5021 for `state/sessions/`. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, bench } from 'vitest';

// Redirect state.ts's HOME-derived paths to a throwaway dir BEFORE importing the
// module under test (see pid-registry.bench.ts for the same pattern + rationale).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-hooksessbench-'));
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

const TERMINALS_SESSIONS_DIR = path.join(TMP, '.agents', '.cache', 'terminals', 'sessions');
const STATE_SESSIONS_DIR = path.join(TMP, '.agents', '.cache', 'state', 'sessions');
fs.mkdirSync(TERMINALS_SESSIONS_DIR, { recursive: true });
fs.mkdirSync(STATE_SESSIONS_DIR, { recursive: true });

const AGENTS = ['claude', 'codex', 'grok', 'kimi', 'droid', 'antigravity'];

// -- terminals/sessions/: counterfactual scale (real fleet count is 0) --
const TERMINALS_SEED_COUNT = 60;
const seededTerminalsPids: number[] = [];
let midLaunchId = '';
for (let i = 0; i < TERMINALS_SEED_COUNT; i++) {
  const pid = 200000 + i;
  seededTerminalsPids.push(pid);
  const launchId = `launch-${i}-${'a'.repeat(8)}`;
  if (i === Math.floor(TERMINALS_SEED_COUNT / 2)) midLaunchId = launchId;
  const record = {
    session_id: `${'1'.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`,
    agent: AGENTS[i % AGENTS.length],
    cwd: `/home/muqsit/src/github.com/muqsitnawaz/repo-${i % 7}`,
    pid,
    launch_id: launchId,
    terminal_id: `%${i}`,
    ts: 1_780_000_000 + i,
  };
  fs.writeFileSync(path.join(TERMINALS_SESSIONS_DIR, `${pid}.json`), JSON.stringify(record), 'utf8');
}

// -- state/sessions/: seeded at THIS box's REAL measured graveyard size --
const STATE_SEED_COUNT = 5021;
const midStatePid = 300000 + Math.floor(STATE_SEED_COUNT / 2);
for (let i = 0; i < STATE_SEED_COUNT; i++) {
  const pid = 300000 + i;
  const record = { session_id: `${'2'.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`, cwd: '/home/muqsit', pid, ts: 1_780_000_000 + i };
  fs.writeFileSync(path.join(STATE_SESSIONS_DIR, `${pid}.json`), JSON.stringify(record), 'utf8');
}

const { loadHookSessionIndex, readStateSessionRecord, resolveHookSessionRecord, resolveHookSessionId } = await import('./hook-sessions.js');

const index = loadHookSessionIndex();
const midTerminalsPid = seededTerminalsPids[Math.floor(TERMINALS_SEED_COUNT / 2)];

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe(`loadHookSessionIndex — terminals/sessions/ scan (hook-sessions.ts:126, ${TERMINALS_SEED_COUNT} seeded files — counterfactual scale; REAL fleet count is 0, writer package not deployed)`, () => {
  bench('readdirSync + read+parse every entry', () => {
    loadHookSessionIndex();
  });
});

describe(`readStateSessionRecord — targeted single-pid read (hook-sessions.ts:81, state/sessions/ seeded at THIS box's REAL measured scale: ${STATE_SEED_COUNT} files)`, () => {
  bench('HIT — pid present, no staleness check', () => {
    readStateSessionRecord(midStatePid);
  });

  bench('HIT — pid present, WITH startedAtMs freshness check (the exec.ts/active.ts call shape)', () => {
    readStateSessionRecord(midStatePid, (1_780_000_000 + Math.floor(STATE_SEED_COUNT / 2)) * 1000);
  });

  bench('MISS — untracked pid (the common case, hook-sessions.ts:90)', () => {
    readStateSessionRecord(999_999_999);
  });
});

describe('resolveHookSessionRecord / resolveHookSessionId — priority-chain Map lookup over the pre-built index (hook-sessions.ts:183,207)', () => {
  bench('direct pid hit (no launchId/terminalId — active.ts:1637 fallback shape)', () => {
    resolveHookSessionRecord(index, { pid: midTerminalsPid, kind: AGENTS[Math.floor(TERMINALS_SEED_COUNT / 2) % AGENTS.length] });
  });

  bench('launchId hit (priority path exec.ts:1708/active.ts:1534 take first)', () => {
    resolveHookSessionId(index, { pid: 0, kind: AGENTS[Math.floor(TERMINALS_SEED_COUNT / 2) % AGENTS.length], launchId: midLaunchId });
  });

  bench('miss — all keys absent (a hookless harness, or the hook hasn\'t landed yet)', () => {
    resolveHookSessionRecord(index, { pid: 1, kind: 'claude' });
  });
});
