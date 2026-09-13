/**
 * promote-home-base-probe.sh + release.sh's assert_promote_home_base (RUSH-3026).
 *
 * The home-base phase is promote-only, so the preflight must (a) verify exactly
 * what promoting needs — tools, gh auth, a headlessly readable npmjs.com token —
 * and (b) run BEFORE the release's first mutation, so an unready home base
 * aborts before merge+tag instead of after (the RUSH-2535 tagged-but-unpublished
 * shape; on origin/main the old signing preflight was defined but never
 * invoked). Exercised against the REAL scripts — no mocking; stub executables on
 * PATH stand in for the box's environment, the probe itself always runs.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const PROBE = path.resolve(__dirname, 'promote-home-base-probe.sh');
const RELEASE = path.resolve(__dirname, 'release.sh');

/** A temp bin dir of stub executables; every listed name exits 0. */
function stubBin(names: string[], overrides: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-probe-bin-'));
  for (const name of names) {
    const body = overrides[name] ?? '#!/usr/bin/env bash\nexit 0\n';
    fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
  }
  // The probe judges the box by what is on PATH, so the child PATH is the stub
  // dir ONLY — a real /usr/bin on it leaked the host's own jq into the
  // "missing tool" case. bash/env come in as symlinks so the stubs' shebangs
  // and the probe itself still resolve.
  // Interpreter locations differ by OS — bash is /usr/bin/bash on Linux but
  // /bin/bash on macOS (no /usr/bin/bash there). Resolve each name from its
  // candidates or runProbe spawns a nonexistent <stub>/bash on darwin and
  // every test reads status:null (the exact all-Mac failure this fixes).
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
    // The whole point is to fail BEFORE the merge + tag. Strip comments and
    // string-literal contents so an error message is not mistaken for a command.
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

/**
 * Execute the REAL `assert_promote_home_base` function body under the same
 * `set -euo pipefail` release.sh runs with. The static ordering test below
 * proves the call is placed right; this proves the function itself fails LOUD.
 *
 * The bug this guards (found in review of the signing preflight's first cut):
 * `out="$(cmd)"; rc=$?` under errexit terminates the script AT the assignment
 * when the probe fails, before `rc=$?` runs -- so the diagnostic dump and the
 * `die` message were dead code and the release aborted with no stated reason.
 * The `&& rc=0 || rc=$?` form is what keeps the die branch reachable.
 */
function runAssert(probeExit: 'fail' | 'pass'): { status: number | null; out: string } {
  // Extract the function definition (from its header to the first line that is a
  // bare `}` at column 0) rather than sourcing release.sh, which executes.
  const lines = fs.readFileSync(RELEASE, 'utf-8').replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => l.startsWith('assert_promote_home_base() {'));
  expect(start, 'assert_promote_home_base() { not found').toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  expect(end, 'closing } for assert_promote_home_base not found').toBeGreaterThan(start);
  const fnBody = lines.slice(start, end + 1).join('\n');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-promote-preflight-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  // Stand in for the probe with a real script on the exact path the function
  // invokes (`scripts/promote-home-base-probe.sh`, run in ON_HOME_BASE mode).
  const stub =
    probeExit === 'fail'
      ? "#!/usr/bin/env bash\nprintf 'promote-probe: gh is not authenticated\\n' >&2\nexit 1\n"
      : '#!/usr/bin/env bash\necho promote-ready\nexit 0\n';
  fs.writeFileSync(path.join(dir, 'scripts/promote-home-base-probe.sh'), stub, { mode: 0o755 });

  // Harness: the real release.sh errexit settings + minimal stubs for the shell
  // helpers the function calls, then the real function body, then invoke it.
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
    // The die branch MUST run -- the historical bug was errexit skipping it.
    expect(out).toContain('DIE:');
    expect(out).toContain('cannot promote + publish');
    expect(out).toContain('promote-probe: gh is not authenticated'); // the probe's diagnostic is surfaced
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
    // The RUSH-2535 shape: an unready home base must abort before merge+tag,
    // not after. On origin/main the old signing preflight was defined but never
    // invoked; the promote preflight is wired in and must precede the release
    // PR / merge / tag machinery.
    const lines = fs.readFileSync(RELEASE, 'utf-8').replace(/\r/g, '').split('\n');
    const call = lines.findIndex((l) => l.trim() === 'assert_promote_home_base');
    expect(call, 'assert_promote_home_base must be invoked').toBeGreaterThanOrEqual(0);
    // The version-bump merge is now the async, post-publish `if … && gh pr merge …`
    // form (RUSH-2395 decouple), so match `gh pr merge "$PR_NUMBER" --rebase`
    // anywhere on the line rather than anchored to start-of-line.
    const merge = lines.findIndex((l) => /gh pr merge "\$PR_NUMBER" --rebase/.test(l));
    const tag = lines.findIndex((l) => /^git push origin "v\$TARGET"$/.test(l));
    expect(merge).toBeGreaterThan(call);
    expect(tag).toBeGreaterThan(call);
  });

  it('the dry-run path exits before the preflight (a dry-run must not ssh-probe anything)', () => {
    const lines = fs.readFileSync(RELEASE, 'utf-8').replace(/\r/g, '').split('\n');
    const dryRunExit = lines.findIndex((l) => l.includes('Dry run looks good.'));
    // The bare CALL line, not the `assert_promote_home_base() {` definition.
    const preflightCall = lines.findIndex((l) => l.trim() === 'assert_promote_home_base');
    expect(dryRunExit).toBeGreaterThanOrEqual(0);
    expect(preflightCall).toBeGreaterThanOrEqual(0);
    expect(dryRunExit).toBeLessThan(preflightCall);
  });
});
