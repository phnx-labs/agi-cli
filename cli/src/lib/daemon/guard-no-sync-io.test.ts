import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';


const BANNED = /\b(execFileSync|execSync|spawnSync|readFileSync|writeFileSync|appendFileSync|statSync|lstatSync|existsSync|readdirSync|mkdirSync|rmSync|unlinkSync|renameSync|openSync|readSync|writeSync|sleepSync|lockSync|withFileLock)\b/;

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
      if (two === '//') break;
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

describe('daemon tick call sites use the async, non-blocking helper variants', () => {
  const daemonDir = __dirname;
  const read = (rel: string) => stripNonCode(fs.readFileSync(path.join(daemonDir, rel), 'utf-8')).join('\n');

  it('watchdog tick reads config + emits asynchronously (not getConfigValue/emit)', () => {
    const src = read('watchdog-service.ts');
    expect(src).toMatch(/getConfigValueAsync\(/);
    expect(src).toMatch(/emitAsync\(/);
    expect(src).not.toMatch(/\bgetConfigValue\(/);
    expect(src).not.toMatch(/\bemit\(/);
  });

  it('usage-sync tick awaits the async own-state publish, whose writers are all the async variants', () => {
    expect(read('usage-sync-service.ts')).toMatch(/await publishOwnFleetState\(/);
    const helper = stripNonCode(fs.readFileSync(path.join(daemonDir, '..', 'accounting', 'usage-sync.ts'), 'utf-8')).join('\n');
    expect(helper).toMatch(/await publishUsageSnapshotToSharedStore\(/);
    expect(helper).toMatch(/await publishSessionMirrorToSharedStore\(/);
    expect(helper).toMatch(/await publishReservedAuthVerdict\(/);
    expect(helper).toMatch(/updateFleetSharedDeviceStateAsync\(/);
  });

  it('usage-sync exchange applies each peer reply through async file locks, never the sleepSync ones', () => {
    const libDir = path.join(daemonDir, '..');
    const helper = stripNonCode(fs.readFileSync(path.join(libDir, 'accounting', 'usage-sync.ts'), 'utf-8')).join('\n');
    expect(helper).toMatch(/await applyPeerFleetState\(/);
    expect(helper).toMatch(/await storePeerFleetSharedDeviceState\(/);
    expect(helper).toMatch(/await ingestPeerClaudeUsageRows\(/);
    const store = stripNonCode(fs.readFileSync(path.join(libDir, 'fleet-shared-state.ts'), 'utf-8')).join('\n');
    expect(store).toMatch(/export async function storePeerFleetSharedDeviceState[\s\S]*?return updateFleetSharedDeviceStateAsync\(/);
    const usage = stripNonCode(fs.readFileSync(path.join(libDir, 'accounting', 'usage.ts'), 'utf-8')).join('\n');
    const ingest = usage.slice(usage.indexOf('export async function ingestPeerClaudeUsageRows'));
    const body = ingest.slice(0, ingest.indexOf('\n}\n') + 1);
    expect(body).toMatch(/await withFileLockAsync\(/);
    expect(body).not.toMatch(/\bwithFileLock\(/);
  });

  it('heartbeat tick uses the async run reaper, not the sync monitorRunningJobs', () => {
    const src = read('heartbeat-service.ts');
    expect(src).toMatch(/await reapExitedRunningJobs\(/);
    expect(src).not.toMatch(/\bmonitorRunningJobs\(/);
  });

  it("daemon log()'s event-stream mirror is fire-and-forget async (emitAsync)", () => {
    expect(read('daemon.ts')).toMatch(/void emitAsync\(/);
  });

  it('host-run async finalize (tick path) emits through the async lock, not sync emitRoutineEnd (PHNX-3727)', () => {
    expect(read('runner.ts')).toMatch(/reconcileHostTaskAsync\(task\), \(m\) => \{ void emitRoutineEndAsync\(m\)/);
  });
});
