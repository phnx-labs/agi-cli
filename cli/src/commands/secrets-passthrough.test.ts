import { describe, expect, it, afterEach, vi, beforeEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const mockResolveRemoteDevice = vi.fn();
vi.mock('../lib/ssh-tunnel.js', () => ({ resolveRemoteDevice: (...args: unknown[]) => mockResolveRemoteDevice(...args) }));

// PHNX-4090: `secrets` has no fleet registry of its own, so `--device` must be
// rewritten to `--host ssh://user@host` (the grammar it speaks) before exec.
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

/**
 * `agents secrets` is now a thin exec passthrough to the standalone `secrets`
 * CLI (PHNX-3989, DIST-1) — no fallback engine, so a missing binary fails loud
 * with install guidance rather than falling back to the retired in-repo one.
 */
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

/**
 * Absolute path to the bun runner so the child can start with a scrubbed PATH —
 * blanking SECRETS_BIN alone is not hermetic: on any box with a real `secrets`
 * on PATH the "not on PATH" case would resolve it and pass through instead of
 * failing loud. An empty PATH (the setup.test.ts pattern) makes the miss
 * deterministic regardless of the host. A case that needs the real standalone
 * (REAL_BIN below) restores PATH via extraEnv.
 */
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
      // Real standalone: restore PATH so its own subprocesses resolve.
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
