import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';


const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

function seedHome(): string {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cmdstar-home-'));
  const userDir = path.join(testHome, '.agents');
  const systemDir = path.join(userDir, '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
  return testHome;
}

function run(testHome: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bun', [INDEX, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: testHome,
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_DEVICES_DIR: path.join(testHome, '.agents', '.history', 'devices'),
    },
    encoding: 'utf-8',
    timeout: 20_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('command:* auto-correct re-checks --device routing (RUSH-2022 review r2)', () => {
  it('a typo of a device-routable command with --device does not silently run locally', () => {
    const testHome = seedHome();
    try {
      const r = run(testHome, 'docto', '--device', 'nonexistent-host-xyz-regression-test');

      expect(r.stdout).not.toContain('CRITICAL');
      expect(r.stdout).not.toContain('Installed Agent CLIs');
      expect(r.stderr.toLowerCase()).not.toContain('does not support --device');
      const routed =
        r.stderr.toLowerCase().includes('nonexistent-host-xyz-regression-test') ||
        r.stderr.toLowerCase().includes('ssh') ||
        r.stderr.toLowerCase().includes('unreachable');
      expect(routed).toBe(true);
    } finally {
      fs.rmSync(testHome, { recursive: true, force: true });
    }
  });

  it('a typo with no routing flag still auto-corrects and runs locally as before', () => {
    const testHome = seedHome();
    try {
      const r = run(testHome, 'vew', '--help');
      expect(r.stderr).not.toContain("unknown command 'vew'");
    } finally {
      fs.rmSync(testHome, { recursive: true, force: true });
    }
  });
});
