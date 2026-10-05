import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const PROBE = path.resolve(__dirname, 'promote-home-base-probe.sh');
const RELEASE = path.resolve(__dirname, 'release.sh');

function stubBin(names: string[], overrides: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-probe-bin-'));
  for (const name of names) {
    const body = overrides[name] ?? '#!/usr/bin/env bash\nexit 0\n';
    fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
  }
  for (const [name, candidates] of [
    ['bash', ['/usr/bin/bash', '/bin/bash']],
    ['env', ['/usr/bin/env', '/bin/env']],
    ['sh', ['/bin/sh', '/usr/bin/sh']],
  ] as const) {
    if (names.includes(name)) continue;
    const target = candidates.find((c) => fs.existsSync(c));
    if (target) fs.symlinkSync(target, path.join(dir, name));
  }
  return dir;
}

function runProbe(bin: string): { status: number | null; out: string } {
  const r = spawnSync(path.join(bin, 'bash'), [PROBE], {
    encoding: 'utf-8',
    env: { PATH: bin, HOME: os.tmpdir() },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const ALL_TOOLS = ['npm', 'node', 'git', 'jq', 'gh', 'agents'];

describe('promote-home-base-probe.sh', () => {
  it('reports promote-ready when tools, gh auth, and the npm token all resolve', () => {
    const { status, out } = runProbe(stubBin(ALL_TOOLS));
    expect(status).toBe(0);
    expect(out).toContain('promote-ready');
  });

  it('fails fast, naming the gap, when gh is not authenticated', () => {
    const bin = stubBin(ALL_TOOLS, { gh: '#!/usr/bin/env bash\nexit 1\n' });
    const { status, out } = runProbe(bin);
    expect(status).not.toBe(0);
    expect(out).toContain('gh is not authenticated');
  });

  it('fails fast when the npmjs.com token is not readable headlessly', () => {
    const bin = stubBin(ALL_TOOLS, { agents: '#!/usr/bin/env bash\nexit 1\n' });
    const { status, out } = runProbe(bin);
    expect(status).not.toBe(0);
    expect(out).toContain('NPM_TOKEN is not readable headlessly');
  });

  it('fails fast when a required tool is missing entirely', () => {
    const { status, out } = runProbe(stubBin(ALL_TOOLS.filter((t) => t !== 'jq')));
    expect(status).not.toBe(0);
    expect(out).toContain('jq not on PATH');
  });

  it('performs no git/gh/npm mutations (it must not be able to advance a release)', () => {
    const code = fs
      .readFileSync(PROBE, 'utf-8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .map((l) => l.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''"))
      .join('\n');
    for (const banned of [
      /\bgit\s+(tag|push|commit|merge|worktree|checkout|switch|reset)\b/,
      /\bgh\s+pr\s+(create|merge)\b/,
      /\bnpm\s+publish\b/,
    ]) {
      expect(code).not.toMatch(banned);
    }
  });

  it('never prints the npm token (readability is proven with test -n under secrets exec)', () => {
    const src = fs.readFileSync(PROBE, 'utf-8');
    expect(src).toContain('test -n "$NPM_TOKEN"');
    expect(src).not.toMatch(/printenv NPM_TOKEN(?!.*test)/);
    expect(src).not.toMatch(/echo.*\$NPM_TOKEN/);
  });
});

function runAssert(probeExit: 'fail' | 'pass'): { status: number | null; out: string } {
  const lines = fs.readFileSync(RELEASE, 'utf-8').replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => l.startsWith('assert_promote_home_base() {'));
  expect(start, 'assert_promote_home_base() { not found').toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  expect(end, 'closing } for assert_promote_home_base not found').toBeGreaterThan(start);
  const fnBody = lines.slice(start, end + 1).join('\n');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-promote-preflight-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  const stub =
    probeExit === 'fail'
      ? "#!/usr/bin/env bash\nprintf 'promote-probe: gh is not authenticated\\n' >&2\nexit 1\n"
      : '#!/usr/bin/env bash\necho promote-ready\nexit 0\n';
  fs.writeFileSync(path.join(dir, 'scripts/promote-home-base-probe.sh'), stub, { mode: 0o755 });

  const harness = [
    'set -euo pipefail',
    'ON_HOME_BASE=true',
    'RELEASE_HOME_BASE=testbox',
    'bold(){ :; }',
    "phase_ok(){ printf 'PHASE_OK: %s\\n' \"$1\"; }",
    "die(){ printf 'DIE: %s\\n' \"$1\" >&2; exit 1; }",
    fnBody,
    'assert_promote_home_base',
  ].join('\n');
  const harnessPath = path.join(dir, 'harness.sh');
  fs.writeFileSync(harnessPath, harness);
  const r = spawnSync('bash', [harnessPath], { cwd: dir, encoding: 'utf-8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('release.sh: assert_promote_home_base fails loud under set -e', () => {
  it('aborts with the actionable die message when the probe fails', () => {
    const { status, out } = runAssert('fail');
    expect(status).not.toBe(0);
    expect(out).toContain('DIE:');
    expect(out).toContain('cannot promote + publish');
    expect(out).toContain('promote-probe: gh is not authenticated');
  });

  it('reports phase_ok and exits 0 when the probe passes', () => {
    const { status, out } = runAssert('pass');
    expect(status).toBe(0);
    expect(out).toContain('PHASE_OK:');
    expect(out).not.toContain('DIE:');
  });
});

describe('release.sh: the promote preflight gates the mutating phases (RUSH-3026)', () => {
  it('calls assert_promote_home_base BEFORE the first mutating phase', () => {
    const lines = fs.readFileSync(RELEASE, 'utf-8').replace(/\r/g, '').split('\n');
    const call = lines.findIndex((l) => l.trim() === 'assert_promote_home_base');
    expect(call, 'assert_promote_home_base must be invoked').toBeGreaterThanOrEqual(0);
    const merge = lines.findIndex((l) => /gh pr merge "\$PR_NUMBER" --rebase/.test(l));
    const tag = lines.findIndex((l) => /^git push origin "v\$TARGET"$/.test(l));
    expect(merge).toBeGreaterThan(call);
    expect(tag).toBeGreaterThan(call);
  });

  it('the dry-run path exits before the preflight (a dry-run must not ssh-probe anything)', () => {
    const lines = fs.readFileSync(RELEASE, 'utf-8').replace(/\r/g, '').split('\n');
    const dryRunExit = lines.findIndex((l) => l.includes('Dry run looks good.'));
    const preflightCall = lines.findIndex((l) => l.trim() === 'assert_promote_home_base');
    expect(dryRunExit).toBeGreaterThanOrEqual(0);
    expect(preflightCall).toBeGreaterThanOrEqual(0);
    expect(dryRunExit).toBeLessThan(preflightCall);
  });
});
