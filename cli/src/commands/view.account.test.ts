import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import {
  accountColumnLabel,
  allowInteractiveUsageLogin,
  compareAccountOrderedVersions,
  joinViewColumns,
  nativeAccountViewLabel,
  planDuplicatePrune,
  pruneGroupKey,
  viewUsageSummaryOptions,
  type AccountOrderedVersion,
  type PruneCandidate,
} from './view.js';
import {
  renderAccountRows,
  type NativeAccountCatalogRow,
  type ProviderAccountCatalogRow,
} from '../lib/account-catalog.js';
import {
  formatUsageSummary,
  readClaudeUsageCache,
  setClaudeUsageCachePathForTest,
  writeClaudeUsageCache,
  usageExpiredKimiCredentialError,
  USAGE_BENIGN_STATE,
  type UsageInfo,
} from '../lib/accounting/usage.js';
import { padToWidth, stringWidth } from '../lib/session/width.js';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('account-first view — one header per harness block', () => {
  it('prints ACCOUNT IDENTITY STATE WHERE USAGE FIX once for native + provider groups', () => {
    const native: NativeAccountCatalogRow = {
      kind: 'native',
      agent: 'codex',
      identityKey: 'codex:user=1',
      name: 'work',
      id: 'id-work',
      email: 'w@example.com',
      display: 'w@example.com',
      identityLabel: 'w@example.com',
      home: 'main',
      installations: [{ label: 'main', releaseVersion: '0.4.0', signedIn: true }],
      isDefault: true,
      state: 'connected',
      provisioning: 'portable',
      verdict: 'live',
      checkedAt: '2026-09-06T00:00:00.000Z',
      devices: [{ device: 'zion', authMode: 'native', verdict: 'live' }],
      usage: {
        status: 'available',
        verdict: 'available',
        usedPercent: 10,
        stale: false,
        capturedAt: '2026-09-06T00:00:00.000Z',
        resetsAt: null,
        unavailableReason: null,
      },
      fix: null,
    };
    const providers: ProviderAccountCatalogRow[] = [{
      kind: 'provider',
      name: 'legacy-openrouter-work',
      id: 'id-or',
      provider: 'openrouter',
      auth: 'api-key',
      harnesses: ['claude', 'codex', 'opencode'],
      defaultFor: [],
      identityLabel: 'openrouter',
      verdict: 'ready',
      fix: null,
    }];
    const out = stripAnsi(renderAccountRows([native], {
      heading: false,
      footer: false,
      harnessHeadings: false,
      providers,
      harness: 'codex',
      localDevice: 'zion',
    }));
    const headers = out.split('\n').filter((line) => /ACCOUNT\s+IDENTITY\s+STATE\s+WHERE\s+USAGE\s+FIX/.test(line));
    expect(headers).toHaveLength(1);
    expect(out).toContain('work');
    expect(out).toContain('legacy-openrouter-work');
    expect(out).not.toContain('claude');
    expect(out).not.toContain('opencode');
  });
});

describe('account-first view labels', () => {
  it('leads with the durable account name, without an installation version', () => {
    expect(nativeAccountViewLabel({ name: 'work', display: 'work@example.com' })).toBe('work · work@example.com');
  });

  it('shows unnamed identities and avoids repeating a name used as the display', () => {
    expect(nativeAccountViewLabel({ name: null, display: 'person@example.com' })).toBe('person@example.com');
    expect(nativeAccountViewLabel({ name: 'work', display: 'work' })).toBe('work');
  });
});

describe('joinViewColumns — fixed multi-agent layout', () => {
  it('keeps the unlabeled last-active timestamp aligned when status is empty', () => {
    const wVer = 18;
    const wModel = 8;
    const wEmail = 10;
    const wUsage = 22;
    const wStatus = 12;
    const wActive = 18;

    const row = (
      ver: string,
      model: string,
      email: string,
      usage: string,
      status: string,
      active: string,
    ) =>
      joinViewColumns([
        padToWidth(ver, wVer),
        padToWidth(model, wModel),
        padToWidth(email, wEmail),
        padToWidth(usage, wUsage),
        padToWidth(status, wStatus),
        padToWidth(active, wActive),
      ]);

    const rateLimited = row(
      '2.1.220 (default)',
      'default',
      'a@x.com',
      'Max  S: 100%',
      'rate-limited',
      '8h ago',
    );
    const healthy = row(
      '2.1.219',
      'default',
      'b@y.com',
      'Max  S: 5%',
      '',
      '2m ago',
    );
    expect(rateLimited.indexOf('8h ago')).toBe(healthy.indexOf('2m ago'));
    expect(rateLimited).not.toContain('auth');
    expect(healthy).not.toContain('auth');
    // Both rows stay within a sane terminal width after the overview meter cap.
    expect(stringWidth(rateLimited)).toBeLessThanOrEqual(120);
    expect(stringWidth(healthy)).toBe(stringWidth(rateLimited));
  });

  it('drops only trailing empty columns', () => {
    expect(joinViewColumns(['ver', 'model', '', ''])).toBe('ver  model');
    expect(joinViewColumns(['ver', '', 'acct'])).toBe('ver    acct');
  });
});

describe('viewUsageSummaryOptions — truthful unavailable states', () => {
  it.each(['codex', 'grok', 'muse'] as const)(
    'renders no recent usage truthfully for a signed-in %s account',
    (agentId) => {
      const usageInfo: UsageInfo = {
        snapshot: null,
        error: null,
        [USAGE_BENIGN_STATE]: 'no-recent-usage',
      };
      const opts = viewUsageSummaryOptions(agentId, true, usageInfo, 2);

      expect(opts.unavailable).toBe(false);
      expect(formatUsageSummary(null, usageInfo.snapshot, 3, opts)).toBe(
        agentId === 'grok' ? 'run grok once to refresh usage' : 'no usage recorded yet',
      );
    },
  );

  it('names the exact Grok version that must emit a fresh billing event', () => {
    const usageInfo: UsageInfo = {
      snapshot: null,
      error: null,
      [USAGE_BENIGN_STATE]: 'no-recent-usage',
    };
    const opts = viewUsageSummaryOptions('grok', true, usageInfo, 2, '0.2.118');
    expect(formatUsageSummary(null, null, 3, opts)).toBe(
      'run grok@0.2.118 once to refresh usage',
    );
  });

  it('renders the specific usage error for a signed-in usage-capable harness', () => {
    const error = 'Claude credential expired; re-authentication required for usage.';
    const opts = viewUsageSummaryOptions('claude', true, { snapshot: null, error }, 2);

    expect(formatUsageSummary(null, null, 3, opts)).toBe('re-auth for usage');
  });

  it('renders "run Kimi once" for an expired Kimi credential (RUSH-3198)', () => {
    const error = usageExpiredKimiCredentialError();
    const opts = viewUsageSummaryOptions('kimi', true, { snapshot: null, error }, 2);

    expect(formatUsageSummary(null, null, 3, opts)).toBe('run Kimi once');
    expect(error).toContain('run Kimi once');
    expect(error).not.toContain('re-auth');
  });

  it('renders an unavailable state for a globally installed signed-in harness', () => {
    const error = 'Codex usage is rate-limiting the usage endpoint; not retrying for 13 minutes.';
    const opts = viewUsageSummaryOptions('codex', true, { snapshot: null, error }, 2);

    expect(opts.unavailable).toBe(true);
    expect(formatUsageSummary(null, null, 3, opts)).toBe('rate-limited (retry ~13 minutes)');
  });

  it('keeps the usage column blank for a harness with no usage concept', () => {
    const error = 'usage read failed: unavailable';
    const opts = viewUsageSummaryOptions('opencode', true, { snapshot: null, error }, 2);

    expect(opts.unavailable).toBe(false);
    expect(formatUsageSummary(null, null, 3, opts)).toBe('');
  });

  it('renders the cached plan for a meterless harness instead of "usage unavailable"', () => {
    // Drives the REAL read path the plain, non-refreshing `agents view` uses:
    // the row `--refresh` wrote goes through readClaudeUsageCache and into the
    // renderer. Before the deserializer kept plan-only rows this read returned
    // null and the row rendered "usage unavailable" — the reported bug.
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-view-planonly-'));
    const prevPath = setClaudeUsageCachePathForTest(path.join(cacheDir, 'claude-usage.json'));
    try {
      const usageKey = 'grok:user=view-plan-only-test:org=view-plan-only-org';
      writeClaudeUsageCache(usageKey, {
        source: 'live',
        sourceLabel: 'live',
        capturedAt: new Date(),
        plan: 'SuperGrok Heavy',
        windows: [],
      });

      const usageInfo: UsageInfo = { snapshot: readClaudeUsageCache(usageKey), error: null };
      const opts = viewUsageSummaryOptions('grok', true, usageInfo, 2);

      expect(opts.unavailable).toBe(false);
      expect(formatUsageSummary(usageInfo.snapshot?.plan ?? null, usageInfo.snapshot, 3, opts))
        .toBe('SuperGrok Heavy');
    } finally {
      setClaudeUsageCachePathForTest(prevPath);
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

describe('accountColumnLabel — organization suffix', () => {
  it('appends the org NAME (identity) for a Team seat — the tier shows in the plan column', () => {
    expect(accountColumnLabel({
      email: 'taylor@example.com',
      accountId: null,
      signedIn: true,
      organizationType: 'claude_team',
      organizationName: 'Turing Labs',
    })).toBe('taylor@example.com (Turing Labs)');
  });

  it('renders the bare email for a personal Max plan — no badge, tier is in the plan column', () => {
    expect(accountColumnLabel({
      email: 'taylor@example.com',
      accountId: null,
      signedIn: true,
      organizationType: 'claude_max',
      organizationName: "taylor@example.com's Organization",
    })).toBe('taylor@example.com');
  });

  it('renders the bare email when no organization type is present', () => {
    expect(accountColumnLabel({
      email: 'taylor@example.com',
      accountId: null,
      signedIn: true,
      organizationType: null,
      organizationName: null,
    })).toBe('taylor@example.com');
  });

  it('leaves the id: and signed-in branches untouched', () => {
    expect(accountColumnLabel({
      email: null,
      accountId: 'u-123',
      signedIn: true,
      organizationType: null,
      organizationName: null,
    })).toBe('id:u-123');
    expect(accountColumnLabel({
      email: null,
      accountId: null,
      signedIn: true,
      organizationType: null,
      organizationName: null,
    })).toBe('signed in');
  });

  it('renders empty when signed out', () => {
    expect(accountColumnLabel(null)).toBe('');
    expect(accountColumnLabel({
      email: null,
      accountId: null,
      signedIn: false,
      organizationType: null,
      organizationName: null,
    })).toBe('');
  });
});

describe('compareAccountOrderedVersions — human view ordering', () => {
  const sort = (rows: AccountOrderedVersion[], globalDefault: string | null): string[] =>
    [...rows]
      .sort((a, b) => compareAccountOrderedVersions(a, b, globalDefault))
      .map(({ version }) => version);

  it('keeps the global default first, then sorts emails case-insensitively', () => {
    const rows: AccountOrderedVersion[] = [
      { version: '2.1.300', email: 'beta@example.com' },
      { version: '2.1.100', email: 'zeta@example.com' },
      { version: '2.1.200', email: 'Alpha@example.com' },
    ];

    expect(sort(rows, '2.1.100')).toEqual(['2.1.100', '2.1.200', '2.1.300']);
  });

  it('places non-email rows last and keeps them version-descending', () => {
    const rows: AccountOrderedVersion[] = [
      { version: '3.0.0', email: null },
      { version: '1.0.0', email: 'alpha@example.com' },
      { version: '4.0.0', email: null },
    ];

    expect(sort(rows, null)).toEqual(['1.0.0', '4.0.0', '3.0.0']);
  });

  it('uses version-descending order when normalized emails match', () => {
    const rows: AccountOrderedVersion[] = [
      { version: '1.0.0', email: 'same@example.com' },
      { version: '2.0.0', email: 'SAME@example.com' },
    ];

    expect(sort(rows, null)).toEqual(['2.0.0', '1.0.0']);
  });
});

describe('pruneGroupKey — duplicate detection identity', () => {
  it('keeps same-email installs in different orgs in separate prune groups', () => {
    const max = pruneGroupKey({
      accountKey: 'claude:account:acc-1:org:org-personal',
      email: 'taylor@example.com',
    });
    const team = pruneGroupKey({
      accountKey: 'claude:account:acc-1:org:org-team',
      email: 'taylor@example.com',
    });
    expect(max).not.toBeNull();
    expect(max).not.toBe(team);
  });

  it('groups installs with the same accountKey together', () => {
    const a = pruneGroupKey({ accountKey: 'claude:account:acc-1:org:org-1', email: 'a@x.com' });
    const b = pruneGroupKey({ accountKey: 'claude:account:acc-1:org:org-1', email: 'A@X.COM' });
    expect(a).toBe(b);
  });

  it('falls back to the lowercased email when no accountKey exists', () => {
    expect(pruneGroupKey({ accountKey: null, email: 'Taylor@Example.com' }))
      .toBe('taylor@example.com');
  });

  it('returns null when there is no identity at all', () => {
    expect(pruneGroupKey({ accountKey: null, email: null })).toBeNull();
  });
});

describe('planDuplicatePrune — collapse to one home per account', () => {
  const home = (o: Partial<PruneCandidate> & { version: string }): PruneCandidate => ({
    release: o.version,
    email: null,
    accountKey: null,
    signedIn: true,
    hasBinary: true,
    ...o,
  });

  it('keeps the identity-captured home and retires the higher-numbered NO-ID re-login duplicate', () => {
    // The exact fleet bug: the real login lives in the OLDER home (accountKey +
    // usage captured) while a freshly re-logged-in NEWER home has only an email.
    // Blind highest-semver would trash the working login; we must keep it.
    const out = planDuplicatePrune([
      home({ version: '2.1.222', release: '2.1.263', email: 'a@x.com', accountKey: 'claude:account=acc-1:org=org-1' }),
      home({ version: '2.1.257', release: '2.1.263', email: 'a@x.com', accountKey: null }),
    ]);
    expect(out).toEqual([{ version: '2.1.257', email: 'a@x.com', keeper: '2.1.222' }]);
  });

  it('never merges two DIFFERENT org accounts that share an email', () => {
    const out = planDuplicatePrune([
      home({ version: '2.1.200', email: 'a@x.com', accountKey: 'claude:account=acc-1:org=personal' }),
      home({ version: '2.1.201', email: 'a@x.com', accountKey: 'claude:account=acc-2:org=team' }),
    ]);
    expect(out).toEqual([]);
  });

  it('collapses same-accountKey duplicates, keeping the newest running release', () => {
    const out = planDuplicatePrune([
      home({ version: '2.1.100', release: '2.1.263', email: 'a@x.com', accountKey: 'k1' }),
      home({ version: '2.1.150', release: '2.1.240', email: 'a@x.com', accountKey: 'k1' }),
    ]);
    expect(out).toEqual([{ version: '2.1.150', email: 'a@x.com', keeper: '2.1.100' }]);
  });

  it('leaves a lone home for an account untouched', () => {
    expect(planDuplicatePrune([
      home({ version: '2.1.222', email: 'a@x.com', accountKey: 'k1' }),
    ])).toEqual([]);
  });

  it('ignores homes with no binary (they never compete for the live install)', () => {
    const out = planDuplicatePrune([
      home({ version: '2.1.222', email: 'a@x.com', accountKey: 'k1' }),
      home({ version: '2.1.257', email: 'a@x.com', accountKey: null, hasBinary: false }),
    ]);
    expect(out).toEqual([]);
  });

  it('collapses two equally-bare email-only homes toward the newer release', () => {
    const out = planDuplicatePrune([
      home({ version: '2.1.100', release: '2.1.200', email: 'a@x.com', accountKey: null }),
      home({ version: '2.1.110', release: '2.1.263', email: 'a@x.com', accountKey: null }),
    ]);
    expect(out).toEqual([{ version: '2.1.100', email: 'a@x.com', keeper: '2.1.110' }]);
  });

  it('never folds an identity-less home when two orgs share the email (prunes nothing)', () => {
    // Personal + Team on one email, plus a fresh re-login of the Team org that has
    // not captured its identity yet. Folding it into whichever org sorted first
    // would trash the working Team re-login. It must stay ungrouped instead.
    const out = planDuplicatePrune([
      home({ version: '2.1.100', email: 'a@x.com', accountKey: 'org-1', signedIn: true }),
      home({ version: '2.1.150', email: 'a@x.com', accountKey: 'org-2', signedIn: false }),
      home({ version: '2.1.200', email: 'a@x.com', accountKey: null, signedIn: true }),
    ]);
    expect(out).toEqual([]);
  });

  it('breaks a same-group keeper tie on signed-in before release/label', () => {
    // Two equally-bare homes on one email, same running release: the signed-in one
    // must win keeper even though it has the LOWER dir label.
    const out = planDuplicatePrune([
      home({ version: '2.1.110', release: '2.1.263', email: 'a@x.com', accountKey: null, signedIn: false }),
      home({ version: '2.1.100', release: '2.1.263', email: 'a@x.com', accountKey: null, signedIn: true }),
    ]);
    expect(out).toEqual([{ version: '2.1.110', email: 'a@x.com', keeper: '2.1.100' }]);
  });
});

describe('allowInteractiveUsageLogin — the USAGE-READ-2 role + foreground gate', () => {
  it('allows the interactive login only for a personal device at a human TTY', () => {
    expect(allowInteractiveUsageLogin('personal', true)).toBe(true);
  });

  it('rejects a personal device when output is not a TTY (piped/scripted reader)', () => {
    // A --json or piped run must never silently acquire the interactive credential,
    // even on the user's own box — role alone is not sufficient (USAGE-READ-2).
    expect(allowInteractiveUsageLogin('personal', false)).toBe(false);
  });

  it('allows the interactive login for a desktop device at a human TTY (headed box with the login)', () => {
    expect(allowInteractiveUsageLogin('desktop', true)).toBe(true);
    expect(allowInteractiveUsageLogin('desktop', false)).toBe(false);
  });

  it('rejects a worker device even at a TTY (RUSH-1822 guarantee: setup-token only)', () => {
    expect(allowInteractiveUsageLogin('worker', true)).toBe(false);
    expect(allowInteractiveUsageLogin('worker', false)).toBe(false);
  });

  it('rejects an unmarked device (undefined role is treated as non-personal)', () => {
    expect(allowInteractiveUsageLogin(undefined, true)).toBe(false);
    expect(allowInteractiveUsageLogin(undefined, false)).toBe(false);
  });
});

describe('executePrunePlan — repoint default to keeper before retiring the duplicate', () => {
  const tempHomes: string[] = [];
  afterEach(() => {
    for (const dir of tempHomes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function nodeExecPath(): string {
    if (!('bun' in process.versions)) return process.execPath;
    const binary = process.platform === 'win32' ? 'node.exe' : 'node';
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      const candidate = path.join(dir, binary);
      if (fs.existsSync(candidate)) return candidate;
    }
    return binary;
  }

  it('keeps the account keeper as default when the retired duplicate was the default (not another account\'s home)', () => {
    // Real disk + real HOME-derived state in a subprocess (view.ts derives its
    // paths from HOME at import). Three claude homes: account A's keeper (2.1.100)
    // + A's duplicate (2.1.200, the global default), and account B's home (2.1.300,
    // the highest label). Retiring the default duplicate must repoint the default
    // onto A's keeper — NOT let removeVersion fall back to the newest survivor
    // (B's 2.1.300), and NOT leave the duplicate pinned.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-prune-'));
    tempHomes.push(home);
    const viewUrl = pathToFileURL(path.resolve('src/commands/view.ts')).href;
    const versionsUrl = pathToFileURL(path.resolve('src/lib/installations/versions.ts')).href;
    const stateUrl = pathToFileURL(path.resolve('src/lib/state.ts')).href;
    const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
    const child = spawnSync(nodeExecPath(), [tsxBin, '--input-type=module', '-e', `
      import { executePrunePlan } from ${JSON.stringify(viewUrl)};
      import { setGlobalDefault, getGlobalDefault } from ${JSON.stringify(versionsUrl)};
      import { getVersionsDir } from ${JSON.stringify(stateUrl)};
      import * as fs from 'fs';
      import * as path from 'path';
      const base = path.join(getVersionsDir(), 'claude');
      for (const v of ['2.1.100', '2.1.200', '2.1.300']) {
        fs.mkdirSync(path.join(base, v, 'home'), { recursive: true });
        fs.writeFileSync(path.join(base, v, 'installation.json'), JSON.stringify({ schema: 1, id: 'ins_' + v, agent: 'claude', label: v, releaseVersion: v, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', history: [] }));
      }
      setGlobalDefault('claude', '2.1.200');
      await executePrunePlan({ agentId: 'claude', toPrune: [
        { agentId: 'claude', version: '2.1.200', email: 'a@x.com', keeper: '2.1.100', isDefault: true, reason: 'duplicate' },
      ] });
      console.log(JSON.stringify({
        def: getGlobalDefault('claude'),
        dupExists: fs.existsSync(path.join(base, '2.1.200')),
        keeperExists: fs.existsSync(path.join(base, '2.1.100')),
        bExists: fs.existsSync(path.join(base, '2.1.300')),
      }));
    `], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf-8' });

    expect(child.status, child.stderr).toBe(0);
    const out = JSON.parse(child.stdout.trim().split('\n').pop() as string);
    expect(out.def).toBe('2.1.100');    // repointed to A's keeper, not B's 2.1.300
    expect(out.dupExists).toBe(false);  // duplicate soft-deleted
    expect(out.keeperExists).toBe(true);
    expect(out.bExists).toBe(true);     // the other account's home untouched
  });
});

describe('account rows render per-window usage bars (PHNX-3940 regression)', () => {
  const snapshotWithBoth = (): import('../lib/accounting/usage.js').UsageSnapshot => ({
    source: 'live',
    sourceLabel: 'live account data',
    capturedAt: new Date(Date.now() - 60 * 60 * 1000),
    windows: [
      { key: 'session', label: 'Current session', shortLabel: 'S', usedPercent: 58, resetsAt: new Date(Date.now() + 2 * 60 * 60 * 1000), windowMinutes: 300 },
      { key: 'week', label: 'Current week', shortLabel: 'W', usedPercent: 41, resetsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), windowMinutes: 10080 },
    ],
  });

  const rowBase = (agent: 'claude' | 'codex' = 'claude'): NativeAccountCatalogRow => ({
    kind: 'native',
    agent,
    identityKey: 'claude:user=1',
    name: 'work',
    id: 'id-work',
    email: 'w@example.com',
    display: 'w@example.com',
    identityLabel: 'w@example.com',
    home: 'main',
    installations: [{ label: 'main', releaseVersion: '2.0.0', signedIn: true }],
    isDefault: false,
    state: 'connected',
    provisioning: 'portable',
    verdict: 'live',
    checkedAt: null,
    devices: [{ device: 'zion', authMode: 'native', verdict: 'live' }],
    usage: { status: 'available', verdict: 'available', usedPercent: 58, stale: false, capturedAt: new Date().toISOString(), resetsAt: null, unavailableReason: null },
    usageSnapshot: snapshotWithBoth(),
    usageError: null,
    fix: null,
  });

  it('renders BOTH S: and W: labeled bars for a Claude snapshot with 5h + 7d windows', () => {
    const row = rowBase('claude');
    const out = stripAnsi(renderAccountRows([row], { heading: false, footer: false, harnessHeadings: false, localDevice: 'zion', harness: 'claude' }));
    expect(out).toContain('S:');
    expect(out).toContain('58%');
    expect(out).toContain('W:');
    expect(out).toContain('41%');
    // Must not collapse to the old single-percent bar form without labels.
    expect(out).not.toMatch(/█{1,5}░{1,5}\s+83%\*/);
  });

  it('overview cap limits a multi-window harness to 2 bars while single-harness view shows all', () => {
    const threeWindowSnapshot = (): import('../lib/accounting/usage.js').UsageSnapshot => ({
      source: 'live',
      sourceLabel: 'live',
      capturedAt: new Date(),
      windows: [
        { key: 'session', label: 'Current session', shortLabel: 'S', usedPercent: 10, resetsAt: null, windowMinutes: 300 },
        { key: 'week', label: 'Current week', shortLabel: 'W', usedPercent: 20, resetsAt: null, windowMinutes: 10080 },
        { key: 'month', label: 'Current month', shortLabel: 'M', usedPercent: 30, resetsAt: null, windowMinutes: 43200 },
      ],
    });
    const row: NativeAccountCatalogRow = {
      ...rowBase('droid'),
      identityKey: 'droid:user=1',
      usageSnapshot: threeWindowSnapshot(),
    };
    const overview = stripAnsi(renderAccountRows([row], { heading: false, footer: false, harnessHeadings: false, localDevice: 'zion' }));
    const single = stripAnsi(renderAccountRows([row], { heading: false, footer: false, harnessHeadings: false, localDevice: 'zion', harness: 'droid' }));
    // Overview (no harness filter, no explicit cap) should cap at 2: shows S + W, hides M behind +1
    expect(overview).toContain('S:');
    expect(overview).toContain('W:');
    // Overview should not show all three windows; the third is hidden (either omitted or via +1 hint)
    const overviewHasM = overview.includes('M:');
    const overviewHasPlusOne = overview.includes('+1');
    expect(overviewHasM || overviewHasPlusOne).toBe(true);
    // But if it shows M, it must show +1? Actually with cap 2, it shows S and W then +1 (hidden count), not M.
    // So assert M is NOT shown in overview when capped, but +1 is.
    expect(overviewHasM).toBe(false);
    expect(overviewHasPlusOne).toBe(true);
    // Single-harness view (harness filter, no cap) shows all three
    expect(single).toContain('S:');
    expect(single).toContain('W:');
    expect(single).toContain('M:');
    expect(single).not.toContain('+1');
  });

  it('provider rows with no windows keep rendering as today (empty USAGE)', () => {
    const row = rowBase('claude');
    const providers: ProviderAccountCatalogRow[] = [{
      kind: 'provider',
      name: 'my-openrouter',
      id: 'id-or',
      provider: 'openrouter',
      auth: 'api-key',
      harnesses: ['claude'],
      defaultFor: [],
      identityLabel: 'openrouter',
      verdict: 'ready',
      fix: null,
    }];
    const out = stripAnsi(renderAccountRows([row], { heading: false, footer: false, harnessHeadings: false, providers, harness: 'claude', localDevice: 'zion' }));
    expect(out).toContain('my-openrouter');
    // Provider usage cell is empty — no S:/W: there
    const providerLine = out.split('\n').find((l) => l.includes('my-openrouter')) ?? '';
    expect(providerLine).not.toContain('S:');
    expect(providerLine).not.toContain('W:');
  });
});
