import { describe, expect, it, afterEach, vi, beforeEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const mockResolveRemoteDevice = vi.fn();
vi.mock('../lib/ssh-tunnel.js', () => ({ resolveRemoteDevice: (...args: unknown[]) => mockResolveRemoteDevice(...args) }));

describe('rewriteDeviceToHost', () => {
  beforeEach(() => mockResolveRemoteDevice.mockReset());

  it('rewrites --device <name> to --host ssh://user@host', async () => {
    const { rewriteDeviceToHost } = await import('./secrets-passthrough.js');
    mockResolveRemoteDevice.mockResolvedValue({ target: 'deploy@staging' });
    expect(await rewriteDeviceToHost(['export', 'prod', '--device', 'staging'])).toEqual([
      'export', 'prod', '--host', 'ssh://deploy@staging',
    ]);
    expect(mockResolveRemoteDevice).toHaveBeenCalledWith('staging', {});
  });

  it('rewrites the -D short form and --device=name', async () => {
    const { rewriteDeviceToHost } = await import('./secrets-passthrough.js');
    mockResolveRemoteDevice.mockResolvedValue({ target: 'deploy@staging' });
    expect(await rewriteDeviceToHost(['export', 'prod', '-D', 'staging'])).toEqual([
      'export', 'prod', '--host', 'ssh://deploy@staging',
    ]);
    expect(await rewriteDeviceToHost(['export', 'prod', '--device=staging'])).toEqual([
      'export', 'prod', '--host', 'ssh://deploy@staging',
    ]);
  });

  it('leaves argv untouched with no --device', async () => {
    const { rewriteDeviceToHost } = await import('./secrets-passthrough.js');
    expect(await rewriteDeviceToHost(['export', 'prod', '--host', 'ssh://deploy@box'])).toEqual([
      'export', 'prod', '--host', 'ssh://deploy@box',
    ]);
    expect(mockResolveRemoteDevice).not.toHaveBeenCalled();
  });

  it('never rewrites when the caller already typed --host — --host wins over --device', async () => {
    const { rewriteDeviceToHost } = await import('./secrets-passthrough.js');
    expect(await rewriteDeviceToHost(['export', 'prod', '--device', 'staging', '--host', 'ssh://explicit@box'])).toEqual([
      'export', 'prod', '--device', 'staging', '--host', 'ssh://explicit@box',
    ]);
    expect(mockResolveRemoteDevice).not.toHaveBeenCalled();
  });
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

let testHome = '';

afterEach(() => {
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
  testHome = '';
});

function guardedHome(): void {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-passthrough-'));
  const systemDir = path.join(testHome, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
}

function resolveBun(): string {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'bun');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'bun';
}

function run(args: string[], extraEnv: Record<string, string> = {}): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(resolveBun(), [INDEX, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      AGENTS_NO_UPDATE_CHECK: '1',
      AGENTS_NO_USAGE_TRACK: '1',
      PATH: '',
      SECRETS_BIN: '',
      ...extraEnv,
    },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

describe('agents secrets passthrough', () => {
  it('fails loud with install guidance when the standalone is not on PATH', () => {
    guardedHome();
    const r = run(['secrets', 'list']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('not installed');
    expect(r.stderr).toContain('npm i -g @phnx-labs/secrets-cli');
  });
});

const REAL_BIN = process.env.AGENTS_TEST_SECRETS_BIN;

describe.skipIf(!REAL_BIN)('agents secrets passthrough (real standalone)', () => {
  it('forwards a subcommand + flags verbatim and reports the standalone bundle list', () => {
    guardedHome();
    const env = {
      PATH: process.env.PATH ?? '',
      SECRETS_BIN: REAL_BIN!,
      SECRETS_HOME: path.join(testHome, '.agents'),
      AGENTS_SECRETS_PASSPHRASE: 'passthrough-test',
      SECRETS_NO_AGENT: '1',
    };

    const createRes = run(['secrets', 'create', 'passthrough-test-bundle', '--backend', 'file'], env);
    expect(createRes.status, createRes.stderr).toBe(0);

    const listRes = run(['secrets', 'list', '--json'], env);
    expect(listRes.status, listRes.stderr).toBe(0);
    const parsed = JSON.parse(listRes.stdout) as Array<{ name: string }>;
    expect(parsed.some((b) => b.name === 'passthrough-test-bundle')).toBe(true);
  });
});
