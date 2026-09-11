import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Structural guard (PHNX-3695): no synchronous system call may sit on a daemon
 * SERVICE tick/start path.
 *
 * The daemon drives every background service on ONE Node event loop
 * (`ServiceSupervisor`, supervisor.ts). A synchronous `execFileSync` /
 * `readFileSync` / … inside a `DaemonService`'s `onStart`/`onTick` body freezes
 * that loop for the whole duration of the call — and while it is frozen the
 * supervisor's per-tick deadline timer CANNOT fire and the browser IPC server
 * CANNOT answer, which is the "accept but never reply" wedge (browser/ipc.ts,
 * PHNX-3411). Async equivalents (`fs/promises`, `execFileBounded`) keep the loop
 * live.
 *
 * ## What this guard covers, and what it deliberately does NOT
 *
 * (1) It scans the `DaemonService` implementation files — the tick/start SURFACE,
 * the entry points the supervisor calls directly — and fails with `file:line`
 * if any banned synchronous call survives in their code (comments and string
 * literals are stripped so a doc mention like "async existsSync" is not a hit).
 *
 * (2) The tick bodies hand work to helper functions in OTHER modules, and a full
 * transitive call-graph scan is intractable here: every daemon service
 * transitively imports most of the codebase, so a naive reachability scan flags
 * every `execFileSync`/`readFileSync` anywhere as "tick-reachable" — useless. So
 * for the HOT helpers the ticks call directly, this guard instead PINS that the
 * tick call site uses the async, non-blocking variant (`emitAsync`,
 * `getConfigValueAsync`, `await publish…`, `await reap…`) rather than the
 * synchronous one whose file lock / `ps` / YAML read would freeze the loop. A
 * regression that swaps an async call back to its sync twin fails here.
 *
 * (3) What is OUT of scope, by design: startup/lifecycle code in daemon.ts
 * (pid/lock, install-time launchctl/systemctl) — it runs before the loop serves
 * clients. And CONDITIONAL, rare-transition synchronous fs — the report
 * extraction / transcript archival inside `reconcileRunningRecord`, self-heal's
 * 6h repair sweep, catchup's overdue-dispatch — which runs only when a run
 * actually ends or a job is dispatched, not on the every-tick scan. Those, plus
 * a few small bounded per-tick reads (the pid registry, `captureProcessStartTime`
 * fingerprints, opt-in watchdog per-session stats), are named as accepted
 * residue in `daemon/AGENTS.md` with a follow-up; they are not thread-halting
 * 30s locks or whole-process-table `ps` scans, which this PR removed.
 */

// Synchronous fs / child_process / lock calls that block the event loop.
const BANNED = /\b(execFileSync|execSync|spawnSync|readFileSync|writeFileSync|appendFileSync|statSync|lstatSync|existsSync|readdirSync|mkdirSync|rmSync|unlinkSync|renameSync|openSync|readSync|writeSync|sleepSync|lockSync|withFileLock)\b/;

/** Blank out block comments, line comments and string/template literals, preserving line count so reported line numbers stay accurate. */
function stripNonCode(source: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of source.split('\n')) {
    let line = '';
    let i = 0;
    let inStr: string | null = null;
    while (i < raw.length) {
      const two = raw.slice(i, i + 2);
      if (inBlock) {
        if (two === '*/') { inBlock = false; i += 2; } else { i += 1; }
        continue;
      }
      if (inStr) {
        if (raw[i] === '\\') { i += 2; continue; }
        if (raw[i] === inStr) inStr = null;
        i += 1;
        continue;
      }
      if (two === '/*') { inBlock = true; i += 2; continue; }
      if (two === '//') break; // rest of line is a comment
      if (raw[i] === '"' || raw[i] === "'" || raw[i] === '`') { inStr = raw[i]; i += 1; continue; }
      line += raw[i];
      i += 1;
    }
    out.push(line);
  }
  return out;
}

function serviceFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('-service.ts') && !f.endsWith('.test.ts'))
    .map((f) => path.join(dir, f));
}

describe('daemon service tick paths are free of synchronous IO', () => {
  const daemonDir = __dirname;

  it('finds at least the known service files (guard is actually scanning something)', () => {
    const files = serviceFiles(daemonDir).map((f) => path.basename(f));
    expect(files).toContain('heartbeat-service.ts');
    expect(files).toContain('self-heal-service.ts');
    expect(files).toContain('state-dir-check-service.ts');
    expect(files.length).toBeGreaterThan(10);
  });

  it('has no synchronous fs/exec call in any DaemonService onStart/onTick body', () => {
    const offenders: string[] = [];
    for (const file of serviceFiles(daemonDir)) {
      const codeLines = stripNonCode(fs.readFileSync(file, 'utf-8'));
      codeLines.forEach((line, idx) => {
        const m = line.match(BANNED);
        if (m) offenders.push(`${path.relative(process.cwd(), file)}:${idx + 1} — ${m[1]}`);
      });
    }
    expect(offenders, `synchronous IO on a daemon tick surface freezes the event loop (PHNX-3695):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the scanner actually flags a synthetic synchronous call (guard is not vacuous)', () => {
    const sample = [
      '// readFileSync in a comment must NOT count',
      'const x = "spawnSync in a string must NOT count";',
      'const y = fs.readFileSync(p); // this real call MUST count',
    ].join('\n');
    const hits = stripNonCode(sample)
      .map((line, idx) => ({ line, idx }))
      .filter(({ line }) => BANNED.test(line));
    expect(hits.length).toBe(1);
    expect(hits[0].idx).toBe(2);
  });
});

// (2) The hot helpers each tick calls directly must be invoked through their
// ASYNC, non-blocking variant. A full transitive scan is intractable (see the
// docblock), so these pin the specific tick call sites: swap any of these back
// to its synchronous twin — whose file lock / `ps` / YAML read freezes the
// shared event loop — and this fails (PHNX-3695).
describe('daemon tick call sites use the async, non-blocking helper variants', () => {
  const daemonDir = __dirname;
  const read = (rel: string) => stripNonCode(fs.readFileSync(path.join(daemonDir, rel), 'utf-8')).join('\n');

  it('watchdog tick reads config + emits asynchronously (not getConfigValue/emit)', () => {
    const src = read('watchdog-service.ts');
    expect(src).toMatch(/getConfigValueAsync\(/);
    expect(src).toMatch(/emitAsync\(/);
    expect(src).not.toMatch(/\bgetConfigValue\(/); // the sync YAML read
    expect(src).not.toMatch(/\bemit\(/);           // the sleepSync-locked emitter
  });

  it('usage-sync tick awaits the async fleet-state publishes (usage + auth verdict)', () => {
    // Both fleet-state fields publish from the single git committer (PHNX-4051),
    // so both must use the async, non-blocking variant on this tick.
    expect(read('usage-sync-service.ts')).toMatch(/await publishUsageSnapshotToSharedStore\(/);
    expect(read('usage-sync-service.ts')).toMatch(/await publishReservedAuthVerdict\(/);
  });

  it('browser-task-reap tick awaits the async idle-config read', () => {
    expect(read('browser-task-reap-service.ts')).toMatch(/await resolveBrowserTaskIdleMs\(/);
  });

  it('heartbeat tick uses the async run reaper, not the sync monitorRunningJobs', () => {
    const src = read('heartbeat-service.ts');
    expect(src).toMatch(/await reapExitedRunningJobs\(/);
    expect(src).not.toMatch(/\bmonitorRunningJobs\(/);
  });

  it("daemon log()'s event-stream mirror is fire-and-forget async (emitAsync)", () => {
    // Every ctx.log on every tick routes here; the sync emit()'s file lock would
    // otherwise freeze the loop.
    expect(read('daemon.ts')).toMatch(/void emitAsync\(/);
  });

  it('host-run async finalize (tick path) emits through the async lock, not sync emitRoutineEnd (PHNX-3727)', () => {
    // reapExitedRunningJobs → finalizeHostRunAsync → applyHealedHostRun. The heal
    // ends by emitting routine-end, which acquires the event-log file lock; on the
    // tick that MUST be emitRoutineEndAsync (withFileLockAsync). Reverting the
    // injected emitter to the default synchronous emitRoutineEnd would freeze the
    // loop up to 30s when a host:-placed run finishes under lock contention — the
    // residual guard-no-sync-io's *-service.ts scan cannot see (it lives in
    // runner.ts). Scope the pin to the finalizeHostRunAsync call site
    // specifically: the bare `void emitRoutineEndAsync(m)` also appears at the
    // pre-existing PHNX-3695 local-pid tick path (reconcileRunningRecord), so
    // match the unique injected-emitter argument tying reconcileHostTaskAsync to
    // the async emitter — reverting THIS fix to the sync default fails here.
    expect(read('runner.ts')).toMatch(/reconcileHostTaskAsync\(task\), \(m\) => \{ void emitRoutineEndAsync\(m\)/);
  });
});
