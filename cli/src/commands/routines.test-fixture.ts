import { describe, afterAll } from 'vitest';
import { spawnSync, spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

// Each slice owns a unique HOME/PID set; child overrides prevent touching sibling or real sessions.
// Windows --import receives a file URL because bare drive paths parse as URL schemes.

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
export const TSX_IMPORT = pathToFileURL(require.resolve('tsx')).href;
export const CLI_ENTRYPOINT = path.join(REPO_ROOT, 'src', 'index.ts');

export const describeRoutines: typeof describe.skip = process.platform === 'win32' ? describe.skip : describe;

export function makeHome(opts: {
  jobs?: Record<string, unknown>[];
  projectJobs?: Record<string, unknown>[];
  registry?: Record<string, unknown>;
  deviceRoutines?: Record<string, string[]>;
  tmpPrefix?: string;
} = {}): string {
  const home = fs.mkdtempSync(opts.tmpPrefix ?? path.join(os.tmpdir(), 'agents-routines-test-'));
  const agentsDir = path.join(home, '.agents');
  const routinesDir = path.join(agentsDir, 'routines');
  const projectDir = path.join(home, 'project');
  const projectRoutinesDir = path.join(projectDir, '.agents', 'routines');
  fs.mkdirSync(routinesDir, { recursive: true });
  fs.mkdirSync(projectRoutinesDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'agents.yaml'), 'agents: {}\n');
  fs.mkdirSync(path.join(agentsDir, '.system', '.git'), { recursive: true });

  for (const job of opts.jobs ?? []) {
    fs.writeFileSync(
      path.join(routinesDir, `${job.name}.yml`),
      yaml.stringify(job),
    );
  }

  for (const job of opts.projectJobs ?? []) {
    fs.writeFileSync(
      path.join(projectRoutinesDir, `${job.name}.yml`),
      yaml.stringify(job),
    );
  }

  if (opts.registry) {
    const devicesDir = path.join(agentsDir, '.history', 'devices');
    fs.mkdirSync(devicesDir, { recursive: true });
    fs.writeFileSync(path.join(devicesDir, 'registry.json'), JSON.stringify(opts.registry));
  }

  for (const [device, routines] of Object.entries(opts.deviceRoutines ?? {})) {
    writeDeviceRoutines(home, device, routines);
  }

  return home;
}

export function run(
  home: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  cwd: string = REPO_ROOT,
): ReturnType<typeof spawnSync> {
  return spawnSync('node', ['--import', TSX_IMPORT, CLI_ENTRYPOINT, 'routines', ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENTS_DEVICES_DIR: path.join(home, '.agents', '.history', 'devices'),
      AGENTS_SKIP_MIGRATION: '1',
      ...extraEnv,
    },
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

export function readRoutineYaml(home: string, name: string): Record<string, unknown> | null {
  const p = path.join(home, '.agents', 'routines', `${name}.yml`);
  if (!fs.existsSync(p)) return null;
  return yaml.parse(fs.readFileSync(p, 'utf-8'));
}

export function writeRunMeta(home: string, jobName: string, runId: string, meta: Record<string, unknown>): void {
  const runDir = path.join(home, '.agents', '.history', 'runs', jobName, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta));
}

function daemonPidPath(home: string): string {
  return path.join(home, '.agents', '.cache', 'helpers', 'daemon', 'daemon.pid');
}

function readDaemonPid(home: string): number | null {
  const pidPath = daemonPidPath(home);
  if (!fs.existsSync(pidPath)) return null;
  const raw = fs.readFileSync(pidPath, 'utf-8').trim();
  const pid = parseInt(raw, 10);
  return isNaN(pid) ? null : pid;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function createDaemonHarness(fileSlug: string): {
  startIsolatedDaemon: (home: string) => { child: ReturnType<typeof spawn>; pidPromise: Promise<number | null> };
  stopIsolatedDaemon: (child: ReturnType<typeof spawn>) => Promise<void>;
  registerLeakDetector: () => void;
  makeDaemonHome: (opts?: Omit<Parameters<typeof makeHome>[0], 'tmpPrefix'>) => string;
} {
  const homePrefix = path.join(os.tmpdir(), `agents-routines-${fileSlug}-`);
  const trackedDaemonPids = new Set<number>();

  function startIsolatedDaemon(home: string): { child: ReturnType<typeof spawn>; pidPromise: Promise<number | null> } {
    const child = spawn('node', ['--import', 'tsx', 'src/index.ts', '__daemon-run'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AGENTS_HISTORY_DIR: path.join(home, '.agents', '.history'),
        AGENTS_SKIP_MIGRATION: '1',
        AGENTS_DAEMON_TEST_HOME: home,
      },
      detached: true,
      stdio: 'ignore',
    });
    if (child.pid) trackedDaemonPids.add(child.pid);

    const pidPromise = new Promise<number | null>((resolve) => {
      const deadline = Date.now() + 15_000;
      const interval = setInterval(() => {
        const pid = readDaemonPid(home);
        if (pid) {
          clearInterval(interval);
          resolve(pid);
          return;
        }
        if (Date.now() >= deadline) {
          clearInterval(interval);
          resolve(null);
        }
      }, 50);
    });

    return { child, pidPromise };
  }

  async function stopIsolatedDaemon(child: ReturnType<typeof spawn>): Promise<void> {
    const pid = child.pid;
    try {
      if (!pid) return;

      const closePromise = new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.on('close', () => resolve());
      });

      if (child.exitCode !== null || child.signalCode !== null) return;

      const signalProcessGroup = process.platform !== 'win32';
      const signal = (sig: NodeJS.Signals) => {
        try {
          if (signalProcessGroup) {
            process.kill(-pid, sig);
          } else {
            child.kill(sig);
          }
        } catch {
        }
      };

      signal('SIGTERM');
      const timer = setTimeout(() => signal('SIGKILL'), 3_000);
      await closePromise;
      clearTimeout(timer);
    } finally {
      if (pid) trackedDaemonPids.delete(pid);
    }
  }

  function registerLeakDetector(): void {
    afterAll(() => {
      const leaks: string[] = [];
      const killDaemon = (pid: number): void => {
        try { process.kill(-pid, 'SIGKILL'); } catch {  }
        try { process.kill(pid, 'SIGKILL'); } catch {  }
      };

      for (const pid of trackedDaemonPids) {
        if (isProcessAlive(pid)) {
          leaks.push(`pid ${pid} (spawned by this test run, never reaped by its own test)`);
          killDaemon(pid);
        }
      }
      trackedDaemonPids.clear();

      if (process.env.CI && process.platform !== 'win32') {
        const prefix = homePrefix;
        let psOut = '';
        try {
          psOut = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        } catch {  }
        for (const line of psOut.split('\n')) {
          const m = line.trim().match(/^(\d+)\s+(.*)$/);
          if (!m) continue;
          const tokens = m[2].trim().split(/\s+/);
          if (tokens[tokens.length - 1] !== '__daemon-run') continue;
          const pid = parseInt(m[1], 10);
          if (isNaN(pid)) continue;
          let home: string | null = null;
          try {
            const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf-8');
            const homeVar = environ.split('\0').find((v) => v.startsWith('HOME='));
            home = homeVar ? homeVar.slice(5) : null;
          } catch { continue; }
          if (!home || !home.startsWith(prefix)) continue;
          leaks.push(`pid ${pid} HOME=${home} (leaked from a previous interrupted run of this file)`);
          killDaemon(pid);
        }
      }

      if (leaks.length > 0) {
        throw new Error(
          `RUSH-2367 leak detector: ${leaks.length} __daemon-run process(es) survived this test file, ` +
          `now force-killed: ${leaks.join('; ')}`,
        );
      }
    });
  }

  function makeDaemonHome(opts: Omit<Parameters<typeof makeHome>[0], 'tmpPrefix'> = {}): string {
    return makeHome({ ...opts, tmpPrefix: homePrefix });
  }

  return { startIsolatedDaemon, stopIsolatedDaemon, registerLeakDetector, makeDaemonHome };
}

export const baseJob = {
  name: 'test-job',
  schedule: '0 3 * * *',
  agent: 'claude',
  prompt: 'noop',
  cwd: '~',
  enabled: true,
};

export const registry = {
  'yosemite-s0': { name: 'yosemite-s0', platform: 'linux' },
  'mac-mini': { name: 'mac-mini', platform: 'macos' },
  'zion': { name: 'zion', platform: 'macos' },
};

export function readDeviceRoutines(home: string, device: string): string[] {
  const file = path.join(home, '.agents', 'devices', device, 'agents.yaml');
  if (!fs.existsSync(file)) return [];
  return yaml.parse(fs.readFileSync(file, 'utf-8')).routines ?? [];
}

export function writeDeviceRoutines(home: string, device: string, routines: string[]): void {
  const dir = path.join(home, '.agents', 'devices', device);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents.yaml'), yaml.stringify({ routines }));
}


export function writeProject(home: string, name: string): void {
  const dir = path.join(home, '.agents', 'projects');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yaml`), yaml.stringify({ name }));
}

export function projectsEnv(home: string): Record<string, string> {
  return { AGENTS_PROJECTS_DIR: path.join(home, '.agents', 'projects') };
}
