import { afterEach, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

// End-to-end tests for the unified `agents devices config` surface and the retired-subcommand
// tombstones. They spawn the real CLI against a throwaway HOME (no mocking) and assert files
// written: per-device docs and central agents.yaml fleet.defaults.config.
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

let testHome = '';

afterEach(() => {
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
  testHome = '';
});

export function guardedHome(): void {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devices-config-home-'));
  const systemDir = path.join(testHome, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
}

export function run(args: string[], extraEnv: Record<string, string> = {}): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('bun', [INDEX, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: testHome,
      // os.homedir() reads USERPROFILE on Windows, so HOME alone leaves the
      // spawned CLI resolving the real profile ('agents-cli is not set up').
      USERPROFILE: testHome,
      AGENTS_NO_UPDATE_CHECK: '1',
      AGENTS_NO_USAGE_TRACK: '1',
      // Default identity is mac-mini so machine-local keys (scheduler, tmux,
      // browser consent) can be set in these tests. Override per-call to act
      // as a different box.
      AGENTS_SYNC_MACHINE_ID: 'mac-mini',
      ...extraEnv,
    },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

export function centralDoc(): string {
  const p = path.join(testHome, '.agents', 'agents.yaml');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

export function deviceDoc(name: string): string {
  const p = path.join(testHome, '.agents', 'devices', name, 'agents.yaml');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

export function addDevice(name: string, target = 'muqsit@192.0.2.1'): void {
  const r = run(['devices', 'add', name, target]);
  expect(r.status, r.stderr).toBe(0);
}

