/** Benchmark for the pid-registry read path used by `agents sessions --active`: readPidSessionEntry
 * and listPidSessionEntries over a temp HOME seeded with 60 real-shaped entries. No mocking; HOME
 * is set before the dynamic import. Not in `vitest run`; use `npx vitest bench --run` from cli. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, bench } from 'vitest';

const SEED_COUNT = 60;

// Redirect state.ts's HOME-derived paths to a throwaway dir BEFORE importing the
// module under test, then seed a realistic by-pid registry.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-pidbench-'));
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

const BY_PID = path.join(TMP, '.agents', '.cache', 'terminals', 'by-pid');
fs.mkdirSync(BY_PID, { recursive: true });
const AGENTS = ['claude', 'codex', 'grok', 'kimi', 'droid', 'antigravity'];
const seededPids: number[] = [];
for (let i = 0; i < SEED_COUNT; i++) {
  const pid = 100000 + i;
  seededPids.push(pid);
  const entry = {
    pid,
    agent: AGENTS[i % AGENTS.length],
    sessionId: `${'0'.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`,
    cwd: `/home/muqsit/src/github.com/muqsitnawaz/repo-${i % 7}`,
    actor: 'muqsit@zion',
    initiatedBy: i % 3 === 0 ? 'agent' : 'human',
    launchId: `launch-${i}-${'a'.repeat(8)}`,
    tmuxPane: `%${i}`,
    startedAtMs: 1_750_000_000_000 + i * 1000,
  };
  fs.writeFileSync(path.join(BY_PID, `${pid}.json`), JSON.stringify(entry), 'utf8');
}

const { readPidSessionEntry, listPidSessionEntries } = await import('./pid-registry.js');
const midPid = seededPids[Math.floor(SEED_COUNT / 2)];

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe(`pid-registry read path (${SEED_COUNT} seeded launches)`, () => {
  bench('readPidSessionEntry — single pid read + parse (pid-registry.ts:111)', () => {
    readPidSessionEntry(midPid);
  });

  bench('listPidSessionEntries — readdir + read + parse every entry (pid-registry.ts:136)', () => {
    listPidSessionEntries();
  });
});
