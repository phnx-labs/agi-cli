/** Shared harness for the `agents daemon` CLI subprocess suites (RUSH-2354): each test spawns the
 * real CLI against an isolated mkdtemp HOME, no daemon, no mocks. Split from a 159s single file
 * because vitest runs one file's tests sequentially. */
import { spawnSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
export const TSX_IMPORT = pathToFileURL(require.resolve('tsx')).href;
export const CLI_ENTRYPOINT = path.join(REPO_ROOT, 'src', 'index.ts');

/** win32: subprocess CLI, process-group signals and path spawn assumptions (RUSH-2215). Exported as
 * a predicate, not a bound `describe.skip`, because vitest's suite type is not nameable across
 * modules (TS4023). */
export const DAEMON_TESTS_SUPPORTED = process.platform !== 'win32';

/** Provision an isolated HOME with just enough scaffolding for the CLI to boot. */
export function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-daemon-test-'));
  fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents: {}\n');
  return home;
}

/** Run `agents daemon <args>` against an isolated HOME — no daemon process ever started. */
export function run(home: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('node', ['--import', TSX_IMPORT, CLI_ENTRYPOINT, 'daemon', ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENTS_SKIP_MIGRATION: '1',
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
      AGENTS_DAEMON_DIR: path.join(home, '.agents', '.cache', 'helpers', 'daemon'),
    },
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

/** Spawn a real long-lived process whose command line ends in `__daemon-run` (so `isLiveDaemon`
 * accepts it) and register it in `home`'s instance registry as `registerDaemonInstance` would.
 * Real process, not a mock. */
export async function spawnFakeRegisteredDaemon(home: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', '__daemon-run'], {
    stdio: 'ignore',
  });
  // Give the exec a moment to land before `ps` (read by the status command's
  // isLiveDaemon check) is asked to see its real argv — mirrors
  // lib/daemon.test.ts's identical fake-daemon technique.
  await new Promise((r) => setTimeout(r, 150));
  const instancesDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon', 'instances');
  fs.mkdirSync(instancesDir, { recursive: true });
  fs.writeFileSync(path.join(instancesDir, String(child.pid)), '__daemon-run', 'utf-8');
  return child;
}

/** Register a pid in `home`'s instance registry — the scope stale/duplicate reporting uses. */
export function registerInstance(home: string, pid: number): void {
  const dir = path.join(home, '.agents', '.cache', 'helpers', 'daemon', 'instances');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, String(pid)), '__daemon-run', 'utf-8');
}

export function killFakeDaemon(child: ChildProcess): void {
  try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
}
