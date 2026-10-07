import { describe, expect, it } from 'vitest';
import {
  ALL_FINDING_KINDS,
  FINDING_SEVERITY,
  buildLocalFindings,
  collapseAcrossVersions,
  fleetDivergenceToFindings,
  hookRuntimeToFindings,
  signInToFindings,
  remediationFor,
  renderFindings,
  renderAccountsLine,
  type DoctorFinding,
  type LocalFindingInputs,
} from './doctor-findings.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ALL_AGENT_IDS, supportsAccountInspection } from '../agents.js';
import type { VersionResourceReport } from '../doctor-diff.js';
import type { FleetHookRuntimeState, FleetVersionSignIn, FleetDivergence } from './fleet-divergence.js';
import { stringWidth } from '../session/width.js';

const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

function report(
  agent: VersionResourceReport['agent'],
  version: string,
  kinds: Partial<VersionResourceReport['kinds']> = {},
  hookWiring?: VersionResourceReport['hookWiring'],
): VersionResourceReport {
  const empty = { commands: [], skills: [], hooks: [], rules: [], mcp: [], permissions: [], subagents: [], plugins: [], workflows: [], memory: [] };
  return {
    agent, version, home: `/h/${agent}/${version}`, cwd: '/cwd',
    layers: { project: null, user: '/u', system: '/s', extras: [] },
    kinds: { ...empty, ...kinds },
    summary: { ok: 0, diff: 0, missing: 0, extra: 0 },
    hookWiring,
  };
}

function localInput(over: Partial<LocalFindingInputs> = {}): LocalFindingInputs {
  return {
    device: 'boxA',
    syncRows: [],
    orphanRows: [],
    repoBehind: [],
    reports: [],
    signIn: {},
    ...over,
  };
}

describe('severity rubric', () => {
  it('a keychain-backed auth bundle is a WARNING and names the recreate command', () => {
    const findings = buildLocalFindings(localInput({ authBundleWrongBackend: true }));
    const f = findings.find((x) => x.kind === 'auth-bundle-wrong-backend');
    expect(f?.severity).toBe('warning');
    expect(f?.device).toBe('boxA');
    expect(f?.message).toContain("reserved secrets bundle 'auth'");
    expect(f?.message).toContain('not file-backed');
    expect(f?.remediation).toBe('agents secrets delete auth --yes && agents secrets create auth --backend file');
    expect(buildLocalFindings(localInput({})).some((x) => x.kind === 'auth-bundle-wrong-backend')).toBe(false);
  });

  it('a binary shadow is a WARNING and names the shadowing install', () => {
    const findings = buildLocalFindings(localInput({
      binaryShadows: [
        { path: '/usr/local/bin/agents', version: '1.20.90' },
        { path: '/home/user/.nvm/versions/node/v24.0.0/bin/agents' },
      ],
    }));
    const f = findings.find((x) => x.kind === 'binary-shadow');
    expect(f?.severity).toBe('warning');
    expect(f?.device).toBe('boxA');
    expect(f?.message).toContain('/usr/local/bin/agents (1.20.90)');
    expect(f?.message).toContain('2 agents binaries may shadow');
    expect(f?.remediation).toBe('remove or repoint the shadowing agents install(s)');
  });

  it('a leaked daemon is a WARNING that prints HOME and start time, with kill <pid> remediation', () => {
    const findings = buildLocalFindings(localInput({
      leakedDaemons: [
        { pid: 2416767, home: '/tmp/pin-e2e-2416513', startedAt: 'Tue Sep  1 02:14:00 2026', entry: '/home/user/.local/bin/agents' },
      ],
    }));
    const f = findings.find((x) => x.kind === 'leaked-daemon');
    expect(f?.severity).toBe('warning');
    expect(f?.device).toBe('boxA');
    expect(f?.message).toContain('2416767');
    expect(f?.message).toContain('HOME=/tmp/pin-e2e-2416513');
    expect(f?.message).toContain('Tue Sep  1 02:14:00 2026');
    expect(f?.message).toContain('/home/user/.local/bin/agents');
    expect(f?.remediation).toBe('kill 2416767');
    expect(buildLocalFindings(localInput({})).some((x) => x.kind === 'leaked-daemon')).toBe(false);
  });

  it('a broken Windows OpenSSH enrollment is CRITICAL and names the effective file', () => {
    const findings = buildLocalFindings(localInput({
      windowsSshEnrollment: { status: {
        administrator: true,
        expectedPath: 'C:\\ProgramData\\ssh\\administrators_authorized_keys',
        configuredPaths: ['__PROGRAMDATA__\\ssh\\administrators_authorized_keys'],
        fileExists: false,
        hasPublicKey: false,
        owner: null,
        systemFullControl: false,
        administratorsFullControl: false,
        unexpectedAclPrincipals: [],
      } },
    }));
    expect(findings).toMatchObject([{
      severity: 'critical',
      kind: 'ssh-key-enrollment',
      message: 'SSH public-key file missing: C:\\ProgramData\\ssh\\administrators_authorized_keys',
    }]);
  });

  it('a missing hook from a synced version is CRITICAL', () => {
    const findings = buildLocalFindings(localInput({
      reports: [report('claude', '2.1.0', { hooks: [{ kind: 'hooks', name: 'git-guard', status: 'missing' }] })],
    }));
    const crit = findings.find((f) => f.kind === 'missing-hook');
    expect(crit?.severity).toBe('critical');
    expect(crit?.message).toContain("hook 'git-guard' missing");
  });

  it('a missing plugin from a synced version is CRITICAL', () => {
    const findings = buildLocalFindings(localInput({
      reports: [report('claude', '2.1.0', { plugins: [{ kind: 'plugins', name: 'rush', status: 'missing' }] })],
    }));
    const crit = findings.find((f) => f.kind === 'missing-plugin');
    expect(crit?.severity).toBe('critical');
    expect(crit?.message).toContain("plugin 'rush' missing");
  });

  it('a missing COMMAND is a WARNING (not critical)', () => {
    const findings = buildLocalFindings(localInput({
      reports: [report('claude', '2.1.0', { commands: [{ kind: 'commands', name: 'audit', status: 'missing' }] })],
    }));
    const f = findings.find((x) => x.kind === 'missing-resource');
    expect(f?.severity).toBe('warning');
    expect(findings.some((x) => x.severity === 'critical')).toBe(false);
  });

  it('an unwired hook is CRITICAL', () => {
    const findings = buildLocalFindings(localInput({
      reports: [report('claude', '2.1.0', {}, { supported: true, unwired: [{ name: 'rm-guard', event: 'PreToolUse' } as any], settingsMissing: false, settingsUnparseable: false, expected: 1 } as any)],
    }));
    const f = findings.find((x) => x.kind === 'unwired-hook');
    expect(f?.severity).toBe('critical');
    expect(f?.message).toContain("hook 'rm-guard'");
  });

  it('a wired hook with a broken generated shim is CRITICAL, even when wiring itself is unsupported', () => {
    const findings = buildLocalFindings(localInput({
      reports: [report('claude', '2.1.0', {}, {
        supported: false, unwired: [], wired: [],
        runtimeBroken: [{ name: 'git-guard', path: '/h/shims/hooks/git-guard.sh', reason: 'missing' }],
      } as any)],
    }));
    const f = findings.find((x) => x.kind === 'hook-runtime-broken');
    expect(f?.severity).toBe('critical');
    expect(f?.message).toBe("hook 'git-guard' wired but its generated shim is missing");
    expect(f?.remediation).toBe('agents sync claude@2.1.0 --yes');
  });

  it('rebuilds remote hook-runtime findings from closed state without a remote path or reason', () => {
    const state: Record<string, Record<string, FleetHookRuntimeState>> = {
      claude: { '2.1.0': 'broken', '2.2.0': 'healthy' },
    };
    const findings = hookRuntimeToFindings('remote-box', state);
    expect(findings).toEqual([expect.objectContaining({
      severity: 'critical',
      kind: 'hook-runtime-broken',
      device: 'remote-box',
      agent: 'claude',
      version: '2.1.0',
      message: 'generated hook wrapper is unusable',
      remediation: 'agents sync claude@2.1.0 --yes',
    })]);
  });

  it('marks a legacy remote that omits hook-runtime state as visibility unavailable', () => {
    const [finding] = hookRuntimeToFindings('legacy-box', undefined);
    expect(finding).toMatchObject({
      severity: 'warning',
      kind: 'hook-runtime-visibility-unavailable',
      device: 'legacy-box',
      remediation: 'upgrade agents-cli on this device',
    });
  });

  it('a never-synced version collapses its missing resources to ONE warning (not critical)', () => {
    const hooks = Array.from({ length: 20 }, (_, i) => ({ kind: 'hooks' as const, name: `h${i}`, status: 'missing' as const }));
    const findings = buildLocalFindings(localInput({
      reports: [report('opencode', '1.16.0', { hooks })],
      syncRows: [{ agent: 'opencode', version: '1.16.0', status: 'never-synced', isDefault: true }],
    }));
    const crits = findings.filter((f) => f.severity === 'critical');
    expect(crits).toHaveLength(0);
    const ns = findings.filter((f) => f.kind === 'never-synced');
    expect(ns).toHaveLength(1);
    expect(ns[0].severity).toBe('warning');
    expect(ns[0].message).toContain('never synced');
    expect(ns[0].message).toContain('20 hook');
    expect(ns[0].remediation).toBe('agents sync opencode@1.16.0 --yes');
  });

  it('a stale version is a WARNING', () => {
    const findings = buildLocalFindings(localInput({
      syncRows: [{ agent: 'claude', version: '2.1.0', status: 'stale', isDefault: true }],
    }));
    expect(findings.find((f) => f.kind === 'stale')?.severity).toBe('warning');
  });

  it('repo-behind and orphan are WARNINGS', () => {
    const findings = buildLocalFindings(localInput({
      repoBehind: [{ alias: 'user', dir: '/u', ahead: 0, behind: 6, branch: 'origin/main', fetchedAt: 0 }],
      orphanRows: [{ agent: 'claude', version: '2.1.0', commands: 2, skills: 0, hooks: 0 }],
    }));
    expect(findings.find((f) => f.kind === 'repo-behind')?.severity).toBe('warning');
    expect(findings.find((f) => f.kind === 'orphan')?.severity).toBe('warning');
  });
});

describe('de-noise — one root cause is one line', () => {
  it('many missing hooks on one version collapse to a count + two examples', () => {
    const hooks = Array.from({ length: 32 }, (_, i) => ({ kind: 'hooks' as const, name: `h${i}`, status: 'missing' as const }));
    const findings = buildLocalFindings(localInput({ reports: [report('grok', '0.2.82', { hooks })] }));
    const crits = findings.filter((f) => f.kind === 'missing-hook');
    expect(crits).toHaveLength(1);
    expect(crits[0].message).toBe("32 hooks missing (incl. 'h0', 'h1')");
  });

  it('a single missing hook is still named in full', () => {
    const findings = buildLocalFindings(localInput({
      reports: [report('grok', '0.2.82', { hooks: [{ kind: 'hooks', name: 'git-guard', status: 'missing' }] })],
    }));
    expect(findings.find((f) => f.kind === 'missing-hook')?.message).toBe("hook 'git-guard' missing");
  });

  it('the same problem on 5 versions of one agent reads as `claude (5 versions)` with an agent-wide fix', () => {
    const versions = ['2.1.170', '2.1.181', '2.1.186', '2.1.207', '2.1.219'];
    const findings = buildLocalFindings(localInput({
      reports: versions.map((v) => report('claude', v, {
        plugins: [{ kind: 'plugins', name: 'code', status: 'missing' }],
      })),
    }));
    const crits = findings.filter((f) => f.kind === 'missing-plugin');
    expect(crits).toHaveLength(1);
    expect(crits[0].versions).toEqual(versions);
    expect(crits[0].version).toBeUndefined();
    expect(crits[0].remediation).toBe('agents sync claude@all --yes');
  });

  it('a collapsible row keyed on a DIFFERENT account stays separate; the same account merges', () => {
    const row = (version: string, account: string): DoctorFinding => ({
      severity: 'warning', kind: 'content-drift', device: 'boxA', agent: 'claude',
      version, account, message: "plugin 'code' — mirror missing", remediation: '',
    });
    expect(collapseAcrossVersions([row('2.1.170', 'work@x.com'), row('2.1.181', 'personal@y.com')], new Set()))
      .toHaveLength(2);
    const merged = collapseAcrossVersions([row('2.1.170', 'me@x.com'), row('2.1.181', 'me@x.com')], new Set());
    expect(merged).toHaveLength(1);
    expect(merged[0].versions).toEqual(['2.1.170', '2.1.181']);
  });

  it('an ISOLATED copy never folds into a collapsed row — the sweep skips it', () => {
    const findings = buildLocalFindings(localInput({
      reports: ['2.1.170', '2.1.181'].map((v) => report('claude', v, {
        plugins: [{ kind: 'plugins', name: 'code', status: 'missing' }],
      })),
      isolatedVersions: ['claude@2.1.181'],
    }));
    const crits = findings.filter((f) => f.kind === 'missing-plugin');
    expect(crits).toHaveLength(2);
    expect(crits.map((f) => f.remediation).sort()).toEqual([
      'agents sync claude@2.1.170 --yes',
      'agents sync claude@2.1.181 --yes',
    ]);
  });

  it('every orphan row on a device folds into ONE cleanup-only warning', () => {
    const findings = buildLocalFindings(localInput({
      orphanRows: [
        { agent: 'claude', version: '2.1.170', commands: 0, skills: 28, hooks: 16 },
        { agent: 'claude', version: '2.1.181', commands: 0, skills: 28, hooks: 16 },
        { agent: 'grok', version: '0.2.82', commands: 3, skills: 36, hooks: 0 },
      ],
    }));
    const orphans = findings.filter((f) => f.kind === 'orphan');
    expect(orphans).toHaveLength(1);
    expect(orphans[0].message).toBe('127 orphaned resources on 3 versions (cleanup only)');
    expect(orphans[0].remediation).toBe('agents prune cleanup --all');
  });

  it('a version that already named its drifted resources gets no vaguer `stale` row on top', () => {
    const findings = buildLocalFindings(localInput({
      reports: [report('codex', '0.146.0', { commands: [{ kind: 'commands', name: 'audit', status: 'diff' }] })],
      syncRows: [{ agent: 'codex', version: '0.146.0', status: 'stale', isDefault: true }],
    }));
    expect(findings.some((f) => f.kind === 'content-drift')).toBe(true);
    expect(findings.some((f) => f.kind === 'stale')).toBe(false);
  });

  it('a stale version with no itemized drift still reports `stale`', () => {
    const findings = buildLocalFindings(localInput({
      reports: [report('codex', '0.146.0')],
      syncRows: [{ agent: 'codex', version: '0.146.0', status: 'stale', isDefault: true }],
    }));
    expect(findings.find((f) => f.kind === 'stale')?.message).toBe('sources changed since last sync');
  });
});

describe('duplicate version-home hooks', () => {
  const copy = (version: string, active = false) => ({
    agent: 'claude' as const, version, name: 'git-guard',
    path: `/h/claude/${version}/hooks/git-guard.sh`, hash: version, active,
  });

  it('differing content across versions is a WARNING (installed but stale) and names the authoritative version', () => {
    const findings = buildLocalFindings(localInput({
      duplicateHooks: [{
        agent: 'claude', name: 'git-guard', kind: 'drift',
        authoritative: copy('2.1.219'), copies: [copy('2.1.170'), copy('2.1.219')],
      }],
    }));
    const f = findings.find((x) => x.kind === 'duplicate-hook-drift');
    expect(f?.severity).toBe('warning');
    expect(f?.message).toBe("hook 'git-guard' differs across 2.1.170, 2.1.219 — 2.1.219 is authoritative");
    expect(f?.remediation).toBe('agents sync claude@all --yes');
    expect(f?.versions).toEqual(['2.1.170', '2.1.219']);
    expect(f?.version).toBeUndefined();
  });

  it('byte-identical copies are a WARNING, not a critical', () => {
    const findings = buildLocalFindings(localInput({
      duplicateHooks: [{
        agent: 'claude', name: 'git-guard', kind: 'duplicate',
        authoritative: copy('2.1.219'), copies: [copy('2.1.170'), copy('2.1.219')],
      }],
    }));
    const f = findings.find((x) => x.kind === 'duplicate-hook');
    expect(f?.severity).toBe('warning');
    expect(f?.message).toContain('(identical)');
  });

  it('many duplicated hooks on one agent collapse to ONE row — the fix is one command', () => {
    const dups = Array.from({ length: 24 }, (_, i) => ({
      agent: 'claude' as const, name: `hook-${i}`, kind: 'duplicate' as const,
      authoritative: copy('2.1.219', true),
      copies: ['2.1.170', '2.1.181', '2.1.186', '2.1.207', '2.1.219'].map((v) => copy(v)),
    }));
    const findings = buildLocalFindings(localInput({ duplicateHooks: dups }));
    const rows = findings.filter((f) => f.kind === 'duplicate-hook');
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe(
      "24 hooks duplicated (identical) across 5 versions (incl. 'hook-0', 'hook-1') — 2.1.219 is authoritative",
    );
    expect(rows[0].remediation).toBe('agents sync claude@all --yes');
  });

  it('drifted and identical copies stay separate rows — different severities', () => {
    const findings = buildLocalFindings(localInput({
      duplicateHooks: [
        { agent: 'claude', name: 'a', kind: 'drift', authoritative: copy('2.1.219', true), copies: [copy('2.1.170'), copy('2.1.219')] },
        { agent: 'claude', name: 'b', kind: 'duplicate', authoritative: copy('2.1.219', true), copies: [copy('2.1.170'), copy('2.1.219')] },
      ],
    }));
    expect(findings.filter((f) => f.kind === 'duplicate-hook-drift')).toHaveLength(1);
    expect(findings.filter((f) => f.kind === 'duplicate-hook')).toHaveLength(1);
  });

  it('no duplicates → no finding', () => {
    expect(buildLocalFindings(localInput({ duplicateHooks: [] }))).toHaveLength(0);
  });
});

describe('host CLIs (restored — `renderOverviewText` was its only text renderer)', () => {
  it('declared-but-missing host CLIs become ONE warning naming the install command', () => {
    const findings = buildLocalFindings(localInput({
      hostClis: { statuses: [{ name: 'mq', installed: false }, { name: 'rush', installed: true }, { name: 'fd', installed: false }], errors: [] },
    }));
    const f = findings.find((x) => x.kind === 'host-cli-missing');
    expect(f?.severity).toBe('warning');
    expect(f?.message).toBe('2 declared host CLIs not installed (mq, fd)');
    expect(f?.remediation).toBe('agents cli install');
  });

  it('a single missing host CLI is named in full with its exact install command', () => {
    const findings = buildLocalFindings(localInput({ hostClis: { statuses: [{ name: 'mq', installed: false }], errors: [] } }));
    const f = findings.find((x) => x.kind === 'host-cli-missing');
    expect(f?.message).toBe("host CLI 'mq' declared but not installed");
    expect(f?.remediation).toBe('agents cli install mq');
  });

  it('all host CLIs installed and no bad manifests → no finding', () => {
    expect(buildLocalFindings(localInput({
      hostClis: { statuses: [{ name: 'mq', installed: true }], errors: [] },
    }))).toHaveLength(0);
  });

  it('a manifest the loader rejected is its own warning — it can never install', () => {
    const findings = buildLocalFindings(localInput({
      hostClis: {
        statuses: [],
        errors: [{ file: 'cli/broken.yaml', reason: 'missing `name`' }],
      },
    }));
    const f = findings.find((x) => x.kind === 'host-cli-invalid');
    expect(f?.severity).toBe('warning');
    expect(f?.message).toBe('host-CLI manifest cli/broken.yaml could not be read: missing `name`');
  });
});

describe('rc-hygiene + exec-policy findings (restored from the pre-RUSH-2069 advisories)', () => {
  it('credential-shaped rc exports become ONE warning naming the count and two examples', () => {
    const findings = buildLocalFindings(localInput({
      rcSecrets: [
        { file: '.zshrc', line: 12, name: 'OPENAI_API_KEY', isMasterPassphrase: false },
        { file: '.zshrc', line: 13, name: 'STRIPE_SECRET', isMasterPassphrase: false },
        { file: '.bashrc', line: 4, name: 'GH_TOKEN', isMasterPassphrase: false },
      ],
    }));
    const rc = findings.filter((f) => f.kind === 'rc-secret-export');
    expect(rc).toHaveLength(1);
    expect(rc[0].severity).toBe('warning');
    expect(rc[0].message).toContain('3 credential-shaped exports in shell rc files');
    expect(rc[0].message).toContain('.zshrc:12 OPENAI_API_KEY');
    expect(rc[0].remediation).toBe('agents secrets add once per export (3), then delete each rc line');
  });

  it('the file-store master key gets its own row — a different fix from the rest', () => {
    const findings = buildLocalFindings(localInput({
      rcSecrets: [
        { file: '.zshrc', line: 2, name: 'AGENTS_SECRETS_PASSPHRASE', isMasterPassphrase: true },
        { file: '.zshrc', line: 12, name: 'OPENAI_API_KEY', isMasterPassphrase: false },
      ],
    }));
    const rc = findings.filter((f) => f.kind === 'rc-secret-export');
    expect(rc).toHaveLength(2);
    expect(rc[0].remediation).toContain('~/.agents/.secrets-key/passphrase');
    expect(rc[1].remediation).toBe('agents secrets add, then delete the rc line');
  });

  it('no rc exports → no finding', () => {
    expect(buildLocalFindings(localInput({ rcSecrets: [] })).some((f) => f.kind === 'rc-secret-export')).toBe(false);
  });

  it('the master key live in the process env is its own warning', () => {
    const findings = buildLocalFindings(localInput({ masterPassphraseInEnv: true }));
    const env = findings.filter((f) => f.kind === 'env-secret-export');
    expect(env).toHaveLength(1);
    expect(env[0].severity).toBe('warning');
    expect(env[0].remediation).toContain('unset at the source');
    expect(env[0].remediation).toContain('agents daemon');
    expect(env[0].message).toContain('AGENTS_SECRETS_PASSPHRASE is set in this process environment');
  });

  it('the env finding fires with NO rc export present — the gap it exists for', () => {
    const findings = buildLocalFindings(localInput({ rcSecrets: [], masterPassphraseInEnv: true }));
    expect(findings.some((f) => f.kind === 'rc-secret-export')).toBe(false);
    expect(findings.some((f) => f.kind === 'env-secret-export')).toBe(true);
  });

  it('not set → no env finding', () => {
    expect(buildLocalFindings(localInput({ masterPassphraseInEnv: false }))
      .some((f) => f.kind === 'env-secret-export')).toBe(false);
    expect(buildLocalFindings(localInput({}))
      .some((f) => f.kind === 'env-secret-export')).toBe(false);
  });

  it.each(['Restricted', 'AllSigned'] as const)(
    'a Windows %s execution policy warns that agents.ps1 is blocked',
    (policy) => {
      const findings = buildLocalFindings(localInput({ execPolicy: { platform: 'win32', policy } }));
      const f = findings.find((x) => x.kind === 'exec-policy');
      expect(f?.severity).toBe('warning');
      expect(f?.message).toContain(`execution policy is ${policy}`);
      expect(f?.remediation).toBe('Set-ExecutionPolicy -Scope CurrentUser RemoteSigned');
    },
  );

  it('a permissive policy, an unknown policy, and non-Windows yield nothing', () => {
    const has = (over: Partial<LocalFindingInputs>) =>
      buildLocalFindings(localInput(over)).some((f) => f.kind === 'exec-policy');
    expect(has({ execPolicy: { platform: 'win32', policy: 'RemoteSigned' } })).toBe(false);
    expect(has({ execPolicy: { platform: 'win32', policy: null } })).toBe(false);
    expect(has({ execPolicy: { platform: 'linux', policy: 'Restricted' } })).toBe(false);
    expect(has({ execPolicy: { platform: 'darwin', policy: 'AllSigned' } })).toBe(false);
    expect(has({})).toBe(false);
  });
});

describe('signInToFindings — provable vs unprovable logout', () => {
  it('a PROVABLE logout is CRITICAL', () => {
    const findings = signInToFindings('boxA', {
      codex: [{ version: '1.0.0', signedIn: false, account: null, provable: true }],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].kind).toBe('logged-out');
  });

  it('an UNPROVABLE logout is a hedged WARNING', () => {
    const findings = signInToFindings('boxA', {
      kimi: [{ version: '0.1.0', signedIn: false, account: null, provable: false }],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].kind).toBe('logout-unprovable');
    expect(findings[0].message).toContain('could not verify');
  });

  it('a signed-in version yields NO finding', () => {
    const findings = signInToFindings('boxA', {
      claude: [{ version: '2.1.0', signedIn: true, account: 'me@x.com', provable: false }],
    });
    expect(findings).toHaveLength(0);
  });

  const inspectable = ALL_AGENT_IDS.filter(supportsAccountInspection);
  const opaque = ALL_AGENT_IDS.filter((a) => !supportsAccountInspection(a));

  it('every agent is in exactly one of the two sets, and neither is empty', () => {
    expect(inspectable.length).toBeGreaterThan(0);
    expect(opaque.length).toBeGreaterThan(0);
    expect(inspectable.length + opaque.length).toBe(ALL_AGENT_IDS.length);
  });

  it('an agent with NO inspectable identity yields nothing — not even the hedge', () => {
    for (const agent of opaque) {
      expect(signInToFindings('boxA', {
        [agent]: [{ version: '1.0.0', signedIn: false, account: null, provable: true }],
      })).toHaveLength(0);
    }
  });

  it('an inspectable agent reports a provable logout as critical', () => {
    for (const agent of inspectable) {
      const findings = signInToFindings('boxA', {
        [agent]: [{ version: '1.0.0', signedIn: false, account: null, provable: true }],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ severity: 'critical', kind: 'logged-out', agent });
    }
  });
});

describe('the severity rubric matches the code (docs cannot drift from behavior)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  function buckets(text: string, criticalMark: string, warningMark: string) {
    const c = text.indexOf(criticalMark);
    const w = text.indexOf(warningMark);
    expect(c).toBeGreaterThan(-1);
    expect(w).toBeGreaterThan(c);
    return { critical: text.slice(c, w), warning: text.slice(w) };
  }

  const names = (half: string, kind: string): boolean =>
    new RegExp(`(^|[^a-z-])${kind}($|[^a-z-])`).test(half);

  function misplaced(critical: string, warning: string): string[] {
    const out: string[] = [];
    for (const kind of ALL_FINDING_KINDS) {
      const actual = FINDING_SEVERITY[kind];
      const documented = names(critical, kind) ? 'critical' : names(warning, kind) ? 'warning' : null;
      if (documented !== actual) out.push(`${kind}: ${documented ?? 'absent'} -> ${actual}`);
    }
    return out;
  }

  it('the token matcher does not credit a kind that is only a substring of a longer one', () => {
    expect(names('host-cli-missing', 'cli-missing')).toBe(false);
    expect(names('stale-cli', 'stale')).toBe(false);
    expect(names('duplicate-hook-drift', 'duplicate-hook')).toBe(false);
    expect(names('`cli-missing` and more', 'cli-missing')).toBe(true);
    expect(names('· stale ·', 'stale')).toBe(true);
    expect(names('duplicate-hook, host-cli-missing', 'duplicate-hook')).toBe(true);
  });

  it('every builder emits the severity FINDING_SEVERITY declares', () => {
    const emitted = [
      ...buildLocalFindings(localInput({
        reports: [report('claude', '2.1.0', {
          hooks: [{ kind: 'hooks', name: 'h', status: 'missing' }],
          plugins: [{ kind: 'plugins', name: 'p', status: 'missing' }],
          commands: [{ kind: 'commands', name: 'c', status: 'missing' }],
          skills: [{ kind: 'skills', name: 's', status: 'diff' }],
        })],
        syncRows: [{ agent: 'codex', version: '1.0', status: 'stale', isDefault: true }],
        repoBehind: [{ alias: 'user', dir: '/u', ahead: 0, behind: 3, branch: 'origin/main', fetchedAt: 0 }],
        orphanRows: [{ agent: 'claude', version: '2.1.0', commands: 1, skills: 0, hooks: 0 }],
        hostClis: { statuses: [{ name: 'mq', installed: false }], errors: [{ file: 'f', reason: 'r' }] },
        rcSecrets: [{ file: '.zshrc', line: 1, name: 'X_TOKEN', isMasterPassphrase: false }],
        execPolicy: { platform: 'win32', policy: 'Restricted' },
        duplicateHooks: [{
          agent: 'claude', name: 'h', kind: 'drift',
          authoritative: { agent: 'claude', version: '2', name: 'h', path: '/p', hash: 'x', active: true },
          copies: [{ agent: 'claude', version: '1', name: 'h', path: '/p', hash: 'y', active: false },
                   { agent: 'claude', version: '2', name: 'h', path: '/p', hash: 'x', active: true }],
        }],
        cliMissing: ['grok'],
        signIn: { codex: [{ version: '1', signedIn: false, account: null, provable: true }] },
      })),
      ...fleetDivergenceToFindings([
        { kind: 'agent-version-missing-remote', device: 'b', category: 'claude', name: '1', message: 'm' },
        { kind: 'repo-drift', device: 'b', category: 'agents', name: '.agents', message: 'm' },
        { kind: 'resource-missing-remote', device: 'b', category: 'skills', name: 's', message: 'm' },
      ], 'a'),
    ];
    expect(emitted.length).toBeGreaterThan(8);
    const wrong = emitted
      .filter((f) => f.severity !== FINDING_SEVERITY[f.kind])
      .map((f) => `${f.kind}: emitted ${f.severity}, declared ${FINDING_SEVERITY[f.kind]}`);
    expect(wrong).toEqual([]);
  });

  it('the module docblock rubric puts every kind in the right bucket', () => {
    const src = read('./doctor-findings.ts');
    const rubric = src.slice(src.indexOf(' * Severity rubric'), src.indexOf('\n */'));
    const { critical, warning } = buckets(rubric, 'CRITICAL', 'WARNING');
    expect(misplaced(critical, warning)).toEqual([]);
  });

  it('the docs/observability.md rubric puts every kind in the right bucket', () => {
    const doc = read('../../../docs/observability.md');
    const start = doc.indexOf('**Severity rubric**');
    expect(start).toBeGreaterThan(-1);
    const rubric = doc.slice(start, start + 1400);
    const { critical, warning } = buckets(rubric, '**CRITICAL**', '**WARNING**');
    expect(misplaced(critical, warning)).toEqual([]);
  });

  it('no doc calls a finding by the wrong severity in prose', () => {
    const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs');
    const wrong: string[] = [];
    for (const file of fs.readdirSync(docsDir).filter((f) => f.endsWith('.md'))) {
      const text = fs.readFileSync(path.join(docsDir, file), 'utf-8');
      const sentences = text
        .replace(/\b(e\.g|i\.e|cf|etc|vs)\./gi, '$1\u0000')
        .split(/(?<=[.!?])\s+|\n{2,}/)
        .map((x) => x.replace(/\u0000/g, '.'));
      for (const sentence of sentences) {
        const hasCritical = /\bcriticals?\b/i.test(sentence);
        const hasWarning = /\bwarnings?\b/i.test(sentence);
        if (!hasCritical && !hasWarning) continue;
        for (const kind of ALL_FINDING_KINDS) {
          if (!sentence.includes(`\`${kind}\``)) continue;
          const actual = FINDING_SEVERITY[kind];
          const saysRight = actual === 'critical' ? hasCritical : hasWarning;
          const saysOther = actual === 'critical' ? hasWarning : hasCritical;
          if (saysOther && !saysRight) {
            wrong.push(`${file}: ${kind} called ${actual === 'critical' ? 'warning' : 'critical'}, is ${actual}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('the AGENTS.md rubric puts every kind in the right bucket', () => {
    const doc = read('../../../AGENTS.md');
    const start = doc.indexOf('**critical** is `logged-out`');
    expect(start).toBeGreaterThan(-1);
    const rubric = doc.slice(start, start + 1600);
    const { critical, warning } = buckets(rubric, '**critical**', '**warning**');
    expect(misplaced(critical, warning)).toEqual([]);
  });
});

describe('determinism', () => {
  it('logout rows follow the registry agent order, not the probe-completion order', () => {
    const rows = (v: string) => [{ version: v, signedIn: false, account: null, provable: true }];
    const a = signInToFindings('boxA', { droid: rows('1'), codex: rows('2'), claude: rows('3') });
    const b = signInToFindings('boxA', { claude: rows('3'), droid: rows('1'), codex: rows('2') });
    expect(a.map((f) => f.agent)).toEqual(b.map((f) => f.agent));
    expect(a.map((f) => f.agent)).toEqual(['claude', 'codex', 'droid']);
  });
});

describe('remediationFor', () => {
  const base = { severity: 'critical' as const, device: 'd', message: 'm', remediation: '' };

  it('a subcommand login runs INSIDE the version home via `--`, not as a second global command', () => {
    const r = remediationFor({ ...base, kind: 'logged-out', agent: 'codex', version: '1.2.3' });
    expect(r).toBe('agents run codex@1.2.3 -- login');
    expect(remediationFor({ ...base, kind: 'logged-out', agent: 'grok', version: '0.2.82' }))
      .toBe('agents run grok@0.2.82 -- login --device-auth');
  });

  it('claude launches ONCE and logs in from its own TUI', () => {
    const r = remediationFor({ ...base, kind: 'logged-out', agent: 'claude', version: '2.1.0' });
    expect(r).toBe('agents run claude@2.1.0, then /login');
    expect(r).not.toMatch(/then claude,/);
  });

  it('an agent whose flow starts on launch just gets the run command', () => {
    expect(remediationFor({ ...base, kind: 'logged-out', agent: 'kimi', version: '0.19.2' }))
      .toBe('agents run kimi@0.19.2');
  });

  it.each(['antigravity', 'droid'] as const)(
    '%s has NO per-version isolation → shared login (no fake per-version fix)',
    (agent) => {
      const r = remediationFor({ ...base, kind: 'logged-out', agent, version: '9.9.9' });
      expect(r).not.toContain('agents run');
      expect(r).toContain('shared across all');
    },
  );

  it('cursor now isolates its token per version home → version-targeted run (RUSH-2400)', () => {
    const r = remediationFor({ ...base, kind: 'logged-out', agent: 'cursor', version: '9.9.9' });
    expect(r).toBe('agents run cursor@9.9.9');
    expect(r).not.toContain('shared across all');
  });

  it('opencode uses `auth login`, forwarded into the version home', () => {
    const r = remediationFor({ ...base, kind: 'logged-out', agent: 'opencode', version: '1.0.0' });
    expect(r).toBe('agents run opencode@1.0.0 -- auth login');
  });

  it('a missing hook → agents sync <agent>@<version> --yes', () => {
    expect(remediationFor({ ...base, kind: 'missing-hook', agent: 'claude', version: '2.1.0' }))
      .toBe('agents sync claude@2.1.0 --yes');
  });

  it('a collapsed agent-wide finding (no version) → agents sync <agent>@all --yes', () => {
    expect(remediationFor({ ...base, kind: 'missing-plugin', agent: 'claude', version: undefined as unknown as string }))
      .toBe('agents sync claude@all --yes');
  });

  it('never-synced → agents sync; orphan → prune cleanup; repo-behind → repo pull', () => {
    expect(remediationFor({ ...base, kind: 'never-synced', agent: 'claude', version: '2.1.0' }))
      .toBe('agents sync claude@2.1.0 --yes');
    expect(remediationFor({ ...base, kind: 'orphan', agent: 'claude', version: '2.1.0' }))
      .toBe('agents prune cleanup --all');
    expect(remediationFor({ ...base, kind: 'repo-behind', version: 'user' }))
      .toBe('agents repo pull user');
  });

  it('stale-cli → upgrade', () => {
    expect(remediationFor({ ...base, kind: 'stale-cli' })).toBe('upgrade');
  });

  it('owner-not-signed-in → agents auth login', () => {
    expect(remediationFor({ ...base, kind: 'owner-not-signed-in' })).toBe('agents auth login');
  });
});

describe('owner-not-signed-in finding (PHNX-4267)', () => {
  it('a box with no way to reach the owner is a CRITICAL rendered under an `owner` subject', () => {
    const findings = buildLocalFindings(localInput({ ownerSignedIn: false }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'critical', kind: 'owner-not-signed-in', device: 'boxA', remediation: 'agents auth login',
    });
    const out = renderFindings(findings, { boxA: {} }, { fleet: false, baseline: 'boxA' }).map(stripAnsi);
    const critLine = out.find((l) => l.includes('cannot reach the owner'));
    expect(critLine).toMatch(/\bowner\b/);
  });

  it('a signed-in box emits NO finding', () => {
    expect(buildLocalFindings(localInput({ ownerSignedIn: true }))).toEqual([]);
  });
});

describe('fleetDivergenceToFindings', () => {
  it('maps a version gap to a version-skew warning on the lagging box', () => {
    const d: FleetDivergence = {
      kind: 'agent-version-missing-remote', device: 'boxB', category: 'claude', name: '2.1.220',
      message: 'boxB is missing claude@2.1.220 (installed on boxA)',
    };
    const findings = fleetDivergenceToFindings([d], 'boxA');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'warning', kind: 'version-skew', device: 'boxB' });
  });

  it('attributes a *-missing-local finding to the baseline (the lagging box)', () => {
    const d: FleetDivergence = {
      kind: 'agent-version-missing-local', device: 'boxB', category: 'grok', name: '1.4',
      message: 'boxA is missing grok@1.4 (installed on boxB)',
    };
    const findings = fleetDivergenceToFindings([d], 'boxA');
    expect(findings[0].device).toBe('boxA');
  });

  it('a .agents repo drift pulls the USER repo; a .system drift pulls the SYSTEM repo', () => {
    const drift = (category: string, name: string): FleetDivergence => ({
      kind: 'repo-drift', device: 'boxB', category, name,
      message: `boxB ${name} repo diverged: HEAD abc != local def`,
    });
    expect(fleetDivergenceToFindings([drift('agents', '.agents')], 'boxA')[0]).toMatchObject({
      kind: 'repo-drift', device: 'boxB', remediation: 'agents repo pull user',
    });
    expect(fleetDivergenceToFindings([drift('system', '.system')], 'boxA')[0]).toMatchObject({
      kind: 'repo-drift', device: 'boxB', remediation: 'agents repo pull system',
    });
  });

  it('a fleet resource gap pulls the config repos — NOT `agents doctor --fix`', () => {
    const d: FleetDivergence = {
      kind: 'resource-missing-remote', device: 'boxB', category: 'skills', name: 'cgraph',
      message: "boxB is missing skill 'cgraph'",
    };
    const f = fleetDivergenceToFindings([d], 'boxA')[0];
    expect(f).toMatchObject({ kind: 'fleet-resource-gap', device: 'boxB' });
    expect(f.remediation).toBe('agents repo pull user (or upgrade agents-cli if it ships in .system)');
    expect(f.remediation).not.toContain('doctor');
    expect(f.remediation).not.toBe('agents repo pull');
  });
});

describe('renderAccountsLine', () => {
  it('renders every version + its account, provable ✓/✗', () => {
    const line = stripAnsi(renderAccountsLine({
      claude: [
        { version: '2.1.170', signedIn: true, account: 'me@x.com (Max)', provable: false },
        { version: '2.1.999', signedIn: true, account: 'team@y (Team)', provable: false },
      ],
      codex: [{ version: '0.1.0', signedIn: false, account: null, provable: true }],
    }));
    expect(line).toContain('claude 2.1.170 ✓me@x.com (Max) 2.1.999 ✓team@y (Team)');
    expect(line).toContain('codex ✗');
    expect(line).toContain(' · ');
  });

  it('an UNPROVABLE logout shows gray ? — never a red ✗ the warning contradicts', () => {
    const line = stripAnsi(renderAccountsLine({
      cursor: [{ version: '1.0', signedIn: false, account: null, provable: false }],
      codex: [{ version: '0.1', signedIn: false, account: null, provable: true }],
    }));
    expect(line).toContain('cursor ?');
    expect(line).toContain('codex ✗');
    expect(line).not.toContain('cursor ✗');
  });

  it('collapses a single-version agent to `<agent> <badge>`', () => {
    const line = stripAnsi(renderAccountsLine({ grok: [{ version: '0.2', signedIn: true, account: null, provable: false }] }));
    expect(line).toBe('grok ✓');
  });
});

describe('renderFindings — exact layout', () => {
  const accounts: Record<string, Record<string, FleetVersionSignIn[]>> = {
    zion: {
      claude: [{ version: '2.1.170', signedIn: true, account: 'me@x.com (Max)', provable: false }],
      codex: [{ version: '0.1', signedIn: false, account: null, provable: true }],
    },
  };

  it('single-machine (fleet=false): CRITICAL section + one ▸ block, no fleet header', () => {
    const findings: DoctorFinding[] = [
      { severity: 'critical', kind: 'logged-out', device: 'zion', agent: 'codex', version: '0.1', account: null, message: 'logged out — no account signed in', remediation: 'codex login' },
      { severity: 'warning', kind: 'repo-behind', device: 'zion', version: 'user', message: '6 behind origin/main', remediation: 'agents repo pull user' },
    ];
    const out = stripAnsi(renderFindings(findings, accounts, { fleet: false, baseline: 'zion', header: 'agents doctor · zion' }).join('\n'));
    expect(out).toContain('✗ CRITICAL — needs you now  (1)');
    expect(out).toContain('▸ zion · this machine  ✗ 1 critical (above)');
    expect(out).not.toContain('─── by computer ───');
    expect(out).toContain('codex @0.1');
    expect(out).toContain('→ codex login');
    expect(out).toContain('⚠');
    expect(out).toContain('claude ✓me@x.com (Max)');
    expect(out).toContain('codex ✗');
  });

  it('fleet (fleet=true): CRITICAL section shows the device column + by-computer header', () => {
    const findings: DoctorFinding[] = [
      { severity: 'critical', kind: 'logged-out', device: 'zion', agent: 'codex', version: '0.1', account: null, message: 'logged out — no account signed in', remediation: 'codex login' },
      { severity: 'warning', kind: 'version-skew', device: 'yos-s1', agent: 'grok', version: '1.4', message: 'not installed (present elsewhere in the fleet)', remediation: 'agents add grok@1.4' },
    ];
    const fleetAccounts = { ...accounts, 'yos-s1': { claude: [{ version: '2.1.170', signedIn: true, account: null, provable: false }] } };
    const out = stripAnsi(renderFindings(findings, fleetAccounts, { fleet: true, baseline: 'zion', header: 'agents doctor · 2 devices · baseline zion' }).join('\n'));
    expect(out).toContain('─── by computer ───');
    expect(out).toMatch(/zion\s+codex @0\.1/);
    expect(out.indexOf('▸ zion')).toBeLessThan(out.indexOf('▸ yos-s1'));
    expect(out).toMatch(/grok @1\.4\s+not installed/);
  });

  it('a collapsed row renders `<agent> (N versions)`, and the two ~/.agents repos name their alias', () => {
    const findings: DoctorFinding[] = [
      { severity: 'critical', kind: 'missing-plugin', device: 'zion', agent: 'claude', versions: ['2.1.170', '2.1.181', '2.1.186', '2.1.207', '2.1.219'], message: "plugin 'code' missing", remediation: 'agents sync claude@all --yes' },
      { severity: 'warning', kind: 'repo-behind', device: 'zion', version: 'system', message: '14 behind origin/main', remediation: 'agents repo pull system' },
      { severity: 'warning', kind: 'repo-behind', device: 'zion', version: 'user', message: '4 behind origin/main', remediation: 'agents repo pull user' },
      { severity: 'warning', kind: 'orphan', device: 'zion', message: '397 orphaned resources on 12 versions (cleanup only)', remediation: 'agents prune cleanup' },
    ];
    const out = stripAnsi(renderFindings(findings, accounts, { fleet: false, baseline: 'zion', header: 'agents doctor · zion' }).join('\n'));
    expect(out).toContain('claude (5 versions)');
    expect(out).toContain('~/.agents (system)');
    expect(out).toContain('~/.agents (user)');
    expect(out).toMatch(/orphans\s+397 orphaned resources/);
  });

  it('columns align on DISPLAY width — a wide-glyph account must not skew the row', () => {
    const findings: DoctorFinding[] = [
      { severity: 'critical', kind: 'logged-out', device: 'zion', agent: 'codex', version: '0.1', account: '张三@example.com', message: 'logged out — no account signed in', remediation: 'agents run codex@0.1 -- login' },
      { severity: 'critical', kind: 'logged-out', device: 'zion', agent: 'claude', version: '2.1.0', account: 'me@x.com', message: 'logged out — no account signed in', remediation: 'agents run claude@2.1.0, then /login' },
    ];
    const out = stripAnsi(renderFindings(findings, accounts, { fleet: false, baseline: 'zion', header: 'h' }).join('\n'));
    const rows = out.split('\n').filter((l) => l.includes('logged out'));
    expect(rows).toHaveLength(2);
    const arrowCols = rows.map((l) => stringWidth(l.slice(0, l.indexOf('→'))));
    expect(arrowCols[0]).toBe(arrowCols[1]);
  });

  it('the CRITICAL section leads with the WORST device, not input order', () => {
    const crit = (device: string, agent: 'codex' | 'claude' | 'grok', msg: string): DoctorFinding =>
      ({ severity: 'critical', kind: 'missing-hook', device, agent, version: '1.0', message: msg, remediation: 'x' });
    const findings: DoctorFinding[] = [
      crit('boxA', 'codex', 'a-only'),
      crit('boxB', 'claude', 'b-one'),
      crit('boxB', 'grok', 'b-two'),
      crit('boxB', 'codex', 'b-three'),
    ];
    const out = stripAnsi(renderFindings(findings, {}, { fleet: true, baseline: 'boxA', header: 'h' }).join('\n'));
    expect(out.indexOf('b-one')).toBeLessThan(out.indexOf('a-only'));
    expect(out.indexOf('b-one')).toBeLessThan(out.indexOf('b-two'));
    expect(out.indexOf('b-two')).toBeLessThan(out.indexOf('b-three'));
  });

  it('all-clear: no criticals, no warnings → ✓ lines only', () => {
    const cleanAccounts = { zion: { claude: [{ version: '2.1.170', signedIn: true, account: 'me@x.com', provable: false }] } };
    const out = stripAnsi(renderFindings([], cleanAccounts, { fleet: false, baseline: 'zion', header: 'agents doctor · zion' }).join('\n'));
    expect(out).toContain('✗ CRITICAL — needs you now  (0)');
    expect(out).toContain('nothing critical across the fleet');
    expect(out).toContain('✓ no warnings');
    expect(out).toContain('claude ✓me@x.com');
  });
});
