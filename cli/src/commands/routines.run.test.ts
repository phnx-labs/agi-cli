import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { buildRunsJson, groupRoutineJobsByProject } from './routines.js';
import type { JobConfig } from '../lib/scheduling/routines.js';
import type { RunMeta } from '../lib/scheduling/routines.js';
import {
  describeRoutines,
  makeHome,
  run,
  readRoutineYaml,
  baseJob,
  registry,
  isProcessAlive,
  writeRunMeta,
  createDaemonHarness,
  REPO_ROOT,
  TSX_IMPORT,
  CLI_ENTRYPOINT,
} from './routines.test-fixture.js';

// `routines run`/`edit`/`cleanup` execution slice (RUSH-2819), plus unit tests for
// `buildRunsJson`, `groupRoutineJobsByProject`, bare-command routing and launch-target parity,
// split from routines.test.ts for vitest parallelism. Fixtures: routines.test-fixture.ts.

const { startIsolatedDaemon, stopIsolatedDaemon, registerLeakDetector, makeDaemonHome } = createDaemonHarness('run');
registerLeakDetector();

describeRoutines('routines edit transaction', () => {
  it('leaves the live definition and activation unchanged when edited YAML is invalid', () => {
    const home = makeHome({
      jobs: [{ name: 'atomic-edit', schedule: '0 3 * * *', command: 'true', enabled: true }],
    });
    const routinePath = path.join(home, '.agents', 'routines', 'atomic-edit.yml');
    const before = fs.readFileSync(routinePath, 'utf-8');
    const editor = path.join(home, 'invalid-editor.sh');
    fs.writeFileSync(editor, '#!/bin/sh\nprintf "name: [invalid" > "$1"\n', { mode: 0o755 });
    try {
      const result = run(home, ['edit', 'atomic-edit', '--yaml'], { EDITOR: editor });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Routine not saved');
      expect(fs.readFileSync(routinePath, 'utf-8')).toBe(before);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines add one-shot-looking --schedule', () => {
  it('warns, persists runOnce, and keeps JSON stdout parseable', async () => {
    const home = makeDaemonHome({ registry });
    let daemon: ReturnType<typeof startIsolatedDaemon> | undefined;
    let pid: number | null = null;
    try {
      daemon = startIsolatedDaemon(home);
      pid = await daemon.pidPromise;
      expect(pid).not.toBeNull();

      const res = run(home, [
        'add', 'date-cron',
        '--schedule', '0 14 31 12 *',
        '--agent', 'claude',
        '--prompt', 'hi',
        '--json',
      ]);
      expect(res.status).toBe(0);
      expect(JSON.parse(res.stdout.trim())).toMatchObject({
        jobId: 'date-cron',
        schedule: '0 14 31 12 *',
      });
      expect(res.stderr).toContain('treating it as one-shot');

      const doc = readRoutineYaml(home, 'date-cron');
      expect(doc).not.toBeNull();
      expect(doc!.runOnce).toBe(true);
    } finally {
      if (daemon) await stopIsolatedDaemon(daemon.child);
      if (typeof pid === 'number') expect(isProcessAlive(pid)).toBe(false);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines cleanup', () => {
  it('removes completed expired one-shot-looking routines', () => {
    const year = new Date().getFullYear();
    const job = { ...baseJob, name: 'stale-followup', schedule: '0 0 1 1 *' };
    const home = makeHome({ jobs: [job], registry });
    writeRunMeta(home, 'stale-followup', `${year}-01-02T00-00-00-000Z`, {
      jobName: 'stale-followup',
      runId: `${year}-01-02T00-00-00-000Z`,
      agent: 'claude',
      pid: null,
      status: 'completed',
      startedAt: `${year}-01-02T00:00:00.000Z`,
      completedAt: `${year}-01-02T00:00:01.000Z`,
      exitCode: 0,
    });
    try {
      const dryRun = run(home, ['cleanup', '--dry-run']);
      expect(dryRun.status).toBe(0);
      expect(dryRun.stdout).toContain('stale-followup');
      expect(readRoutineYaml(home, 'stale-followup')).not.toBeNull();

      const res = run(home, ['cleanup']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Removed stale-followup');
      expect(readRoutineYaml(home, 'stale-followup')).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines run wrong-host exact output', () => {
  it('prints the canonical message and suggestion then exits nonzero', () => {
    const job = { ...baseJob, devices: ['yosemite-s0', 'mac-mini'] };
    const home = makeHome({ jobs: [job], registry });
    try {
      const res = run(home, ['run', 'test-job'], { AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status).not.toBe(0);
      const output = res.stdout + res.stderr;
      expect(output).toContain("Job 'test-job' can only run on: yosemite-s0, mac-mini");
      // The suggested host is the OWNER (lowest normalized name), not the first
      // entry as written — the old suggestion pointed at a box that would refuse
      // the run for exactly the same reason.
      expect(output).toContain('  agents routines run test-job --device mac-mini');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines run --device SELF follows the normal local eligibility path', () => {
  it('passes device eligibility when self is in the allowlist', () => {
    const job = { ...baseJob, devices: ['zion'] };
    const home = makeHome({ jobs: [job], registry });
    try {
      const res = run(home, ['run', 'test-job', '--device', 'zion'], { AGENTS_SYNC_MACHINE_ID: 'zion' });
      // Eligibility passes; the run then fails because no claude version is
      // configured in the isolated HOME. The important thing is it did not fail
      // with the device-mismatch message.
      const output = res.stdout + res.stderr;
      expect(output).not.toContain("Job 'test-job' can only run on");
      expect(output).toMatch(/no version of claude configured|not installed|spawn failed/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

/** POSIX single-quote a string so it is safe to embed in a `/bin/sh -c` script. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Read a run's status from meta.json, tolerating a torn read of a file another process is mid-
 * write on (writeRunMeta is not atomic). Returns null for absent, empty or not-yet-valid JSON so
 * the caller polls again. */
function readRunStatus(runsDir: string, runId: string): string | null {
  const metaPath = path.join(runsDir, runId, 'meta.json');
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8')).status ?? null;
  } catch {
    return null;
  }
}

describeRoutines('routines run --json', () => {
  it('emits the real run id and status for a command routine', () => {
    const home = makeHome({
      jobs: [{
        name: 'command-job',
        schedule: '0 3 * * *',
        command: 'printf ok',
        mode: 'auto',
        effort: 'auto',
        timeout: '10m',
        enabled: true,
        prompt: '',
      }],
      registry,
    });
    try {
      const res = run(home, ['run', 'command-job', '--json']);
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      expect(parsed).toMatchObject({
        jobId: 'command-job',
        jobName: 'command-job',
        status: 'completed',
        exitCode: 0,
        errorMessage: null,
      });
      expect(typeof parsed.runId).toBe('string');
      expect(parsed.runId.length).toBeGreaterThan(0);
      expect(parsed.logPath).toContain(parsed.runId);
      expect(parsed.reportPath).toBeNull();

      const runsRes = run(home, ['runs', 'command-job', '--json']);
      expect(runsRes.status).toBe(0);
      const runs = JSON.parse(runsRes.stdout.trim());
      expect(runs.runs).toHaveLength(1);
      expect(runs.runs[0]).toMatchObject({
        runId: parsed.runId,
        status: 'completed',
        exitCode: 0,
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('two independent CLI processes do not serialize overlapping foreground runs', async () => {
    // The overlap window must stay open until the test is done probing it: a fixed `sleep N` raced
    // source-mode CLI startup (10-15s+ on loaded CI) and flaked. The job blocks on a stop-file the
    // test creates only after asserting the second process was skipped.
    const stopFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agents-routines-overlap-')), 'stop');
    const home = makeHome({
      jobs: [{
        name: 'overlap-job',
        schedule: '0 3 * * *',
        command: `i=0; while [ ! -f ${shSingleQuote(stopFile)} ] && [ "$i" -lt 1200 ]; do sleep 0.05; i=$((i + 1)); done`,
        mode: 'auto',
        effort: 'auto',
        timeout: '10m',
        enabled: true,
        prompt: '',
      }],
      registry,
    });
    const childEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENTS_DEVICES_DIR: path.join(home, '.agents', '.history', 'devices'),
      AGENTS_SKIP_MIGRATION: '1',
    };
    const releaseFirst = () => {
      try {
        fs.writeFileSync(stopFile, '');
      } catch {
        // best-effort — the temp dir may already be gone
      }
    };
    try {
      const first = spawn('node', ['--import', TSX_IMPORT, CLI_ENTRYPOINT, 'routines', 'run', 'overlap-job', '--json'], {
        cwd: REPO_ROOT,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let firstStdout = '';
      let firstStderr = '';
      first.stdout.setEncoding('utf8');
      first.stderr.setEncoding('utf8');
      first.stdout.on('data', (chunk) => { firstStdout += chunk; });
      first.stderr.on('data', (chunk) => { firstStderr += chunk; });

      // Wait until the first process writes meta.json with status 'running', the signal that the
      // claim is held. Because the job blocks on stopFile, the claim cannot expire under the
      // second process however slow its startup is.
      const runsDir = path.join(home, '.agents', '.history', 'runs', 'overlap-job');
      const deadline = Date.now() + 30_000;
      let observedRunning = false;
      while (Date.now() < deadline) {
        const runIds = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((entry) => !entry.startsWith('.')) : [];
        if (runIds.some((runId) => readRunStatus(runsDir, runId) === 'running')) {
          observedRunning = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(observedRunning).toBe(true);

      // The claim stays held (stopFile absent) for as long as this process
      // needs — no race against a fixed sleep duration.
      const second = run(home, ['run', 'overlap-job', '--json']);
      expect(second.status, second.stderr).toBe(1);
      // Assert on raw stdout before parsing so a startup failure (empty/partial
      // output) surfaces as the actual stdout+stderr rather than a bare SyntaxError.
      expect(
        second.stdout.trim(),
        `second process stdout was not valid JSON — stdout: ${JSON.stringify(second.stdout)} stderr: ${JSON.stringify(second.stderr)}`,
      ).toMatch(/^\{/);
      expect(JSON.parse(second.stdout.trim())).toMatchObject({
        jobName: 'overlap-job',
        status: 'skipped',
      });

      releaseFirst();
      const firstExit = await new Promise<number | null>((resolve) => first.once('close', resolve));
      expect(firstExit, firstStderr).toBe(0);
      expect(
        firstStdout.trim(),
        `first process stdout was not valid JSON — stdout: ${JSON.stringify(firstStdout)} stderr: ${JSON.stringify(firstStderr)}`,
      ).toMatch(/^\{/);
      expect(JSON.parse(firstStdout.trim())).toMatchObject({
        jobName: 'overlap-job',
        status: 'completed',
      });
    } finally {
      // Unblock the first process's job even if an assertion above threw,
      // so a failed run doesn't leave an orphaned child spinning for 60s.
      releaseFirst();
      fs.rmSync(path.dirname(stopFile), { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});

describeRoutines('buildRunsJson', () => {
  const meta = (runId: string, status: RunMeta['status'], startedAt: string): RunMeta => ({
    jobName: 'test-job',
    runId,
    pid: null,
    status,
    startedAt,
    completedAt: null,
    exitCode: null,
  });

  it('projects each run to the rich JSON fields used by routines runs --json', () => {
    const runs = [
      meta('r1', 'completed', '2026-07-20T00:00:00Z'),
      meta('r2', 'failed', '2026-07-21T00:00:00Z'),
    ];
    expect(buildRunsJson(runs)).toEqual([
      {
        jobId: 'test-job',
        jobName: 'test-job',
        runId: 'r1',
        status: 'completed',
        startedAt: '2026-07-20T00:00:00Z',
        completedAt: null,
        exitCode: null,
        errorMessage: null,
        duration: null,
      },
      {
        jobId: 'test-job',
        jobName: 'test-job',
        runId: 'r2',
        status: 'failed',
        startedAt: '2026-07-21T00:00:00Z',
        completedAt: null,
        exitCode: null,
        errorMessage: null,
        duration: null,
      },
    ]);
  });

  it('returns an empty array for no runs', () => {
    expect(buildRunsJson([])).toEqual([]);
  });
});

describeRoutines('groupRoutineJobsByProject — named projects never collide with special buckets', () => {
  const mk = (name: string, projects?: string[]): JobConfig =>
    ({ ...baseJob, name, ...(projects ? { projects } : {}) }) as unknown as JobConfig;

  it('keeps a project named "Operations" separate from the no-project Operations special', () => {
    const known = new Set(['Operations']);
    const jobs = [
      mk('in-operations-project', ['Operations']), // named project literally "Operations"
      mk('no-project'),                             // untagged -> special Operations bucket
    ];
    const groups = groupRoutineJobsByProject(jobs, known);
    const named = groups.find((g) => g.key === 'named:Operations');
    const special = groups.find((g) => g.key === 'special:operations');
    // Two distinct buckets, both titled "Operations", never merged.
    expect(named).toBeDefined();
    expect(special).toBeDefined();
    expect(named!.jobs.map((j) => j.name)).toEqual(['in-operations-project']);
    expect(special!.jobs.map((j) => j.name)).toEqual(['no-project']);
    // The named project sorts before the special that shares its title.
    expect(groups.indexOf(named!)).toBeLessThan(groups.indexOf(special!));
  });

  it('keeps a project named "Cross-project" separate from the multi-project span special', () => {
    const known = new Set(['Cross-project', 'a', 'b']);
    const jobs = [
      mk('in-crossproject-project', ['Cross-project']), // named project literally "Cross-project"
      mk('spans-two', ['a', 'b']),                       // multiple names -> special Cross-project bucket
    ];
    const groups = groupRoutineJobsByProject(jobs, known);
    const named = groups.find((g) => g.key === 'named:Cross-project');
    const special = groups.find((g) => g.key === 'special:cross');
    expect(named).toBeDefined();
    expect(special).toBeDefined();
    expect(named!.jobs.map((j) => j.name)).toEqual(['in-crossproject-project']);
    expect(special!.jobs.map((j) => j.name)).toEqual(['spans-two']);
    expect(groups.indexOf(named!)).toBeLessThan(groups.indexOf(special!));
  });

  it('orders named projects (alphabetically) before All projects, Cross-project, Operations, Unknown projects', () => {
    const known = new Set(['zeta', 'alpha', 'a', 'b']);
    const jobs = [
      mk('op'),                       // Operations special
      mk('unknown', ['ghost']),       // Unknown projects special
      mk('all', ['*']),               // All projects special
      mk('cross', ['a', 'b']),        // Cross-project special
      mk('named-z', ['zeta']),        // named
      mk('named-a', ['alpha']),       // named
    ];
    const titles = groupRoutineJobsByProject(jobs, known).map((g) => g.title);
    expect(titles).toEqual(['alpha', 'zeta', 'All projects', 'Cross-project', 'Operations', 'Unknown projects']);
  });

  it('groups a file-style duplicate-name routine (projects: [myapp, myapp]) as the single named project', () => {
    const known = new Set(['myapp']);
    const groups = groupRoutineJobsByProject([mk('dup', ['myapp', 'myapp'])], known);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('named:myapp');
    expect(groups[0].title).toBe('myapp');
  });
});

// Bare `agents routines` (RUSH-2503): on a TTY it opens the interactive browser, but with --json
// or a non-interactive shell it must reproduce `routines list` byte-for-byte. spawnSync gives the
// child no TTY, so these exercise the static path.
describeRoutines('bare routines command routing', () => {
  it('bare `routines --json` matches `routines list --json` byte-for-byte', () => {
    const home = makeHome({ jobs: [baseJob, { ...baseJob, name: 'other-job', projects: ['*'] }] });
    try {
      const bare = run(home, ['--json']);
      const list = run(home, ['list', '--json']);
      expect(bare.status, bare.stderr).toBe(0);
      expect(list.status, list.stderr).toBe(0);
      expect(bare.stdout).toBe(list.stdout);
      // And it is real JSON, not the table.
      expect(() => JSON.parse(bare.stdout.trim())).not.toThrow();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('bare `routines` in a non-interactive shell prints the static list, not the browser', () => {
    const home = makeHome({ jobs: [baseJob] });
    try {
      const bare = run(home, []);
      const list = run(home, ['list']);
      expect(bare.status, bare.stderr).toBe(0);
      // Same rendered table as `routines list`.
      expect(bare.stdout).toBe(list.stdout);
      expect(bare.stdout).toContain('Scheduled Jobs');
      expect(bare.stdout).toContain('test-job');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('bare `routines --flat` stays on the static flat table', () => {
    const home = makeHome({ jobs: [baseJob] });
    try {
      const bare = run(home, ['--flat']);
      const list = run(home, ['list', '--flat']);
      expect(bare.status, bare.stderr).toBe(0);
      expect(bare.stdout).toBe(list.stdout);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// RUSH-2517: an agent with no TTY must be able to repair a paused routine and activate it. The
// readiness gate printed `agents routines edit <name> --project-anchor <name>` while `edit`
// accepted no such flag and only opened $EDITOR: an unrunnable hint.
describeRoutines('routines edit — headless context repair', () => {
  const noContext = {
    name: 'needs-cwd',
    schedule: '0 3 * * *',
    agent: 'claude',
    prompt: 'noop',
  };

  it('--cwd applies and saves without opening an editor', () => {
    const home = makeHome({ jobs: [noContext] });
    try {
      // EDITOR would hang the run if the flag fell through to the $EDITOR path.
      const edited = run(home, ['edit', 'needs-cwd', '--cwd', '~'], { EDITOR: 'false' });
      expect(edited.status, edited.stderr).toBe(0);
      expect(edited.stdout).toContain("Routine 'needs-cwd' updated");

      const saved = yaml.parse(
        fs.readFileSync(path.join(home, '.agents', 'routines', 'needs-cwd.yml'), 'utf-8'),
      );
      expect(saved.cwd).toBe('~');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('--project-anchor applies and saves without opening an editor', () => {
    const home = makeHome({ jobs: [noContext] });
    try {
      const edited = run(home, ['edit', 'needs-cwd', '--project-anchor', 'myapp'], { EDITOR: 'false' });
      expect(edited.status, edited.stderr).toBe(0);
      const saved = yaml.parse(
        fs.readFileSync(path.join(home, '.agents', 'routines', 'needs-cwd.yml'), 'utf-8'),
      );
      expect(saved.project).toBe('myapp');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses a routine that does not exist instead of creating a stub', () => {
    const home = makeHome();
    try {
      const edited = run(home, ['edit', 'no-such-routine', '--cwd', '~'], { EDITOR: 'false' });
      expect(edited.status).not.toBe(0);
      expect(edited.stderr).toContain('not found');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// RUSH-2545 regression: the daemon from startIsolatedDaemon must carry an AGENTS_HISTORY_DIR
// confined to the test's tmpHome. Otherwise it inherited the real `~/.agents/.history`, and its
// SIGTERM sweep killed live tmux-wrapped Claude and cgraph-mcp processes every five minutes.
describeRoutines('daemon env isolation — AGENTS_HISTORY_DIR must not leak (RUSH-2545)', () => {
  it('daemon process carries AGENTS_HISTORY_DIR inside the test tmpHome, not the real production dir', async () => {
    const home = makeDaemonHome();
    let daemon: ReturnType<typeof startIsolatedDaemon> | undefined;
    let pid: number | null = null;
    try {
      daemon = startIsolatedDaemon(home);
      pid = await daemon.pidPromise;
      expect(pid).not.toBeNull();

      // On Linux, /proc/<pid>/environ is the ground truth for what a detached child
      // actually inherited. macOS lacks /proc — the fix applies, the assertion is skipped.
      if (process.platform === 'linux' && pid !== null) {
        const expectedHistoryDir = path.join(home, '.agents', '.history');
        let actualHistoryDir: string | undefined;
        try {
          const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf-8');
          const entry = environ.split('\0').find((v) => v.startsWith('AGENTS_HISTORY_DIR='));
          if (entry) actualHistoryDir = entry.slice('AGENTS_HISTORY_DIR='.length);
        } catch {
          // /proc/<pid>/environ unreadable — skip env assertion
        }
        if (actualHistoryDir !== undefined) {
          // Before the RUSH-2545 fix, this was the real production AGENTS_HISTORY_DIR
          // inherited from the parent vitest process — not the test's tmpHome.
          expect(actualHistoryDir).toBe(expectedHistoryDir);
          expect(actualHistoryDir).not.toBe(process.env.AGENTS_HISTORY_DIR ?? '');
        }
      }
    } finally {
      if (daemon) await stopIsolatedDaemon(daemon.child);
      if (pid !== null) expect(isProcessAlive(pid)).toBe(false);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('routines add/edit — launch-target parity flags (RUSH-2719)', () => {
  it('persists --agent claude@2.1.207 as separate agent + version fields', () => {
    const home = makeHome({ registry });
    try {
      const res = run(home, [
        'add', 'pin-job',
        '--schedule', '*/5 * * * *',
        '--agent', 'claude@2.1.207',
        '--prompt', 'Reply OK',
      ]);
      expect(res.status, res.stderr).toBe(0);
      const job = readRoutineYaml(home, 'pin-job');
      expect(job?.agent).toBe('claude');
      expect(job?.version).toBe('2.1.207');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects a malformed agent spec (two @ segments) and writes no file', () => {
    const home = makeHome({ registry });
    try {
      const res = run(home, ['add', 'bad-spec', '--schedule', '0 9 * * *', '--agent', 'claude@1@2', '--prompt', 'hi']);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain("at most one '@version'");
      expect(fs.existsSync(path.join(home, '.agents', 'routines', 'bad-spec.yml'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects --strategy combined with an @version pin, with agents-run wording', () => {
    const home = makeHome({ registry });
    try {
      const res = run(home, ['add', 'conflict-job', '--schedule', '0 9 * * *', '--agent', 'claude@2.1.207', '--strategy', 'balanced', '--prompt', 'hi']);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('conflicts with the @2.1.207 pin');
      expect(fs.existsSync(path.join(home, '.agents', 'routines', 'conflict-job.yml'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects --balanced together with --strategy', () => {
    const home = makeHome({ registry });
    try {
      const res = run(home, ['add', 'double-strategy', '--schedule', '0 9 * * *', '--agent', 'claude', '--strategy', 'pinned', '--balanced', '--prompt', 'hi']);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('--balanced conflicts with --strategy');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('--balanced persists strategy: balanced', () => {
    const home = makeHome({ registry });
    try {
      const res = run(home, ['add', 'balanced-job', '--schedule', '0 9 * * *', '--agent', 'claude', '--balanced', '--prompt', 'hi']);
      expect(res.status, res.stderr).toBe(0);
      expect(readRoutineYaml(home, 'balanced-job')?.strategy).toBe('balanced');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('--run-on auto persists host: auto + hostStrategy: fleet', () => {
    const home = makeHome({ registry });
    try {
      const res = run(home, ['add', 'auto-place', '--schedule', '0 9 * * *', '--agent', 'claude', '--run-on', 'auto', '--prompt', 'hi']);
      expect(res.status, res.stderr).toBe(0);
      const job = readRoutineYaml(home, 'auto-place');
      expect(job?.host).toBe('auto');
      expect(job?.hostStrategy).toBe('fleet');
      // No devices field in the definition: activation is per-device manifest
      // membership (§8), so only the creating machine fires it by default —
      // the double-fire guard is structural, not a persisted allowlist.
      expect(job?.devices).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('--run-on auto rejects a conflicting explicit --placement host', () => {
    const home = makeHome({ registry });
    try {
      const res = run(home, ['add', 'auto-vs-host', '--schedule', '0 9 * * *', '--agent', 'claude', '--run-on', 'auto', '--placement', 'host', '--prompt', 'hi']);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('--run-on auto is fleet placement');
      expect(fs.existsSync(path.join(home, '.agents', 'routines', 'auto-vs-host.yml'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('edit --strategy validates the conflict against the persisted version pin', () => {
    const home = makeHome({ registry });
    try {
      const add = run(home, ['add', 'edit-target', '--schedule', '*/5 * * * *', '--agent', 'claude@2.1.207', '--prompt', 'hi']);
      expect(add.status, add.stderr).toBe(0);
      const res = run(home, ['edit', 'edit-target', '--strategy', 'balanced']);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('conflicts with version 2.1.207');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
