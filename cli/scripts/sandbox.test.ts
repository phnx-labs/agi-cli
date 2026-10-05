import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// bash script under test; the shim-PATH harness below is POSIX-only.
const describeSandbox = process.platform === 'win32' ? describe.skip : describe;

const SANDBOX_SH_PATH = path.resolve(__dirname, 'sandbox.sh');
const SANDBOX_SH = fs.readFileSync(SANDBOX_SH_PATH, 'utf-8');

// Run sandbox.sh with a shim dir FIRST on PATH carrying a fake `agents` (logs
// every invocation to CALL_LOG, exits per FAKE_AGENTS_MODE) and a fake
// `crabbox` (so the dependency probe passes without Hetzner access).
function runSandbox(env: Record<string, string | undefined>): {
  status: number | null;
  out: string;
  calls: string[];
} {
  const shims = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-shims-'));
  const callLog = path.join(shims, 'calls.log');
  fs.writeFileSync(
    path.join(shims, 'agents'),
    `#!/bin/sh
echo "agents $*" >> "${callLog}"
case "\${FAKE_AGENTS_MODE:-ok}" in
  no-bundles) exit 1 ;;
  *) exit 0 ;;
esac
`,
  );
  fs.writeFileSync(path.join(shims, 'crabbox'), `#!/bin/sh\nexit 1\n`);
  fs.chmodSync(path.join(shims, 'agents'), 0o755);
  fs.chmodSync(path.join(shims, 'crabbox'), 0o755);
  try {
    const r = spawnSync('bash', [SANDBOX_SH_PATH, '--', 'true'], {
      encoding: 'utf-8',
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${shims}:${process.env.PATH ?? ''}`,
        HCLOUD_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        SANDBOX_SECRETS_EXEC: undefined,
        ...env,
      },
    });
    const calls = fs.existsSync(callLog)
      ? fs.readFileSync(callLog, 'utf-8').trim().split('\n').filter(Boolean)
      : [];
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, calls };
  } finally {
    fs.rmSync(shims, { recursive: true, force: true });
  }
}

describeSandbox('sandbox.sh credential loading (RUSH-2774)', () => {
  it('passes post-file paths as positional data instead of interpolating them into bash source', () => {
    expect(SANDBOX_SH).toContain("bash -c 'cat -- \"$HOME/$1\"' _ \"$remote_relative_path\"");
    expect(SANDBOX_SH).not.toContain('bash -c "cat $remote_path"');
  });
  it('never materializes secrets — no eval of a plaintext export anywhere in the script', () => {
    expect(SANDBOX_SH).not.toContain('secrets export');
    // Values must arrive via injection (the secrets-exec re-exec chain).
    expect(SANDBOX_SH).toContain('secrets exec');
  });

  it('re-enters itself under a chained `agents secrets exec` when tokens are absent', () => {
    const { calls } = runSandbox({ FAKE_AGENTS_MODE: 'ok' });
    // Probe of each candidate bundle with a real resolve...
    expect(calls.some((c) => c.startsWith('agents secrets exec hetzner.com -- true'))).toBe(true);
    // ...then the re-exec chain whose final link re-invokes sandbox.sh itself.
    const chain = calls.find((c) => c.includes('secrets exec hetzner.com --') && c.includes('sandbox.sh'));
    expect(chain).toBeDefined();
  });

  it('CI path: all tokens pre-set in env skips the secrets chain entirely', () => {
    const { calls } = runSandbox({
      HCLOUD_TOKEN: 'ci-token',
      GITHUB_TOKEN: 'ci-gh',
      CLAUDE_CODE_OAUTH_TOKEN: 'ci-claude',
    });
    expect(calls.filter((c) => c.includes('secrets'))).toEqual([]);
  });

  it('bundles load independently: HCLOUD_TOKEN pre-set still resolves the github.com creds', () => {
    // The 2769 review's regression case: gating the whole chain on
    // HCLOUD_TOKEN silently dropped GitHub App token minting for callers with
    // only the Hetzner token in env.
    const { calls } = runSandbox({ HCLOUD_TOKEN: 'ci-token', FAKE_AGENTS_MODE: 'ok' });
    expect(calls.some((c) => c.startsWith('agents secrets exec github.com -- true'))).toBe(true);
    expect(calls.some((c) => c.startsWith('agents secrets exec hetzner.com'))).toBe(false);
  });

  it('skips unreadable bundles instead of dying (the old per-bundle || true tolerance)', () => {
    const { status, out, calls } = runSandbox({ FAKE_AGENTS_MODE: 'no-bundles' });
    // Every probe failed -> no chain, no re-exec; the script proceeds and dies
    // on the empty HCLOUD_TOKEN with its own actionable message.
    expect(calls.some((c) => c.includes('sandbox.sh'))).toBe(false);
    expect(status).not.toBe(0);
    expect(out).toContain('HCLOUD_TOKEN is empty');
  });
});

// RUSH-3178: the `test` verb bakes in the canonical suite command so no caller composes it. These
// tests run the real sandbox.sh end to end, stubbing only the external `crabbox` binary, and
// capture the command it would ship to the box.
describeSandbox('sandbox.sh test verb (RUSH-3178)', () => {
  function composeVia(args: string[]): { cmd: string; status: number | null; out: string } {
    const shims = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-verb-'));
    const runLog = path.join(shims, 'run.log');
    fs.writeFileSync(
      path.join(shims, 'crabbox'),
      `#!/bin/sh
case "$1" in
  list)   echo '[{"status":"running","labels":{"profile":"'"\${PROFILE:-default}"'","slug":"fake-box"}}]' ;;
  status) echo "id=fake-box ready=true" ;;
  run)    printf '%s\\n' "$*" > "${runLog}" ;;
  *)      exit 0 ;;
esac
`,
    );
    fs.chmodSync(path.join(shims, 'crabbox'), 0o755);
    try {
      const r = spawnSync('bash', [SANDBOX_SH_PATH, ...args], {
        encoding: 'utf-8',
        timeout: 60_000,
        env: {
          ...process.env,
          PATH: `${shims}:${process.env.PATH ?? ''}`,
          // All tokens pre-set = the CI path, which skips the secrets chain.
          HCLOUD_TOKEN: 'x',
          GITHUB_TOKEN: 'x',
          CLAUDE_CODE_OAUTH_TOKEN: 'x',
          SANDBOX_SECRETS_EXEC: '1',
        },
      });
      const cmd = fs.existsSync(runLog) ? fs.readFileSync(runLog, 'utf-8') : '';
      return { cmd, status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    } finally {
      fs.rmSync(shims, { recursive: true, force: true });
    }
  }

  it('bakes in the monorepo-correct suite command, not a repo-root one', () => {
    const { cmd, out } = composeVia(['test']);
    // The bare default used to run `bun install && bun run test` at the REPO
    // ROOT, which has no test script — the suite lives in cli.
    expect(cmd, out).toContain('cd cli');
    expect(cmd).toContain('bun run test');
  });

  it('forwards trailing args to vitest after a `--` separator', () => {
    const { cmd, out } = composeVia(['test', '--retry=2', '--maxWorkers=2']);
    expect(cmd, out).toMatch(/bun run test -- --retry=2 --maxWorkers=2/);
  });

  it('preserves an argument containing a space (the command is re-parsed remotely)', () => {
    const { cmd, out } = composeVia(['test', '--testNamePattern=a b']);
    // %q-quoted, so the remote shell sees ONE word rather than two.
    expect(cmd, out).toMatch(/--testNamePattern=a\\ b/);
  });
});
