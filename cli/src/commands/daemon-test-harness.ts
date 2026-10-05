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

export const DAEMON_TESTS_SUPPORTED = process.platform !== 'win32';

export function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-daemon-test-'));
  fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents: {}\n');
  return home;
}

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

export async function spawnFakeRegisteredDaemon(home: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', '__daemon-run'], {
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 150));
  const instancesDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon', 'instances');
  fs.mkdirSync(instancesDir, { recursive: true });
  fs.writeFileSync(path.join(instancesDir, String(child.pid)), '__daemon-run', 'utf-8');
  return child;
}

export function registerInstance(home: string, pid: number): void {
  const dir = path.join(home, '.agents', '.cache', 'helpers', 'daemon', 'instances');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, String(pid)), '__daemon-run', 'utf-8');
}

export function killFakeDaemon(child: ChildProcess): void {
  try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch {  }
}
