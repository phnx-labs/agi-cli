import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

function seedHome(): string {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-spellcheck-home-'));
  const userDir = path.join(testHome, '.agents');
  const systemDir = path.join(userDir, '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
  return testHome;
}

function run(testHome: string, ...args: string[]): { status: number | null; stdout: string; stderr: string; ms: number } {
  const t0 = Date.now();
  const r = spawnSync('bun', [INDEX, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: testHome,
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_SKIP_MIGRATION: '1',
      AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
      AGENTS_DEVICES_DIR: path.join(testHome, '.agents', '.history', 'devices'),
    },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    ms: Date.now() - t0,
  };
}

describe('unknown-command spellcheck (RUSH-2329)', () => {
  it('suggests sessions for session without auto-running it as unknown', () => {
    const home = seedHome();
    try {
      const r = run(home, 'session', '--help');
      expect(r.stderr).not.toContain("unknown command 'session'");
      expect(`${r.stdout}${r.stderr}`.toLowerCase()).toMatch(/session/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('prints Did you mean for a near miss that is not distance 1', () => {
    const home = seedHome();
    try {
      const r = run(home, 'sessin');
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("unknown command 'sessin'");
      expect(r.stderr).toMatch(/Did you mean sessions\?/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('exits unknown for a garbage name with no close match under distance 3', () => {
    const home = seedHome();
    try {
      const r = run(home, 'zzzznotacommandxyz');
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("unknown command 'zzzznotacommandxyz'");
      expect(r.stderr).not.toMatch(/Did you mean/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('auto-corrects vew --help to view without reporting unknown', () => {
    const home = seedHome();
    try {
      const r = run(home, 'vew', '--help');
      expect(r.stderr).not.toContain("unknown command 'vew'");
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps the retired singular webhook command unknown', () => {
    const home = seedHome();
    try {
      const r = run(home, 'webhook', 'serve', '--help');
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("unknown command 'webhook'");
      expect(r.stderr).toContain('Did you mean webhooks?');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
