/**
 * Account attribution over a real on-disk version layout.
 *
 * Every fixture is a real directory tree with real `.claude.json` files — no mocking,
 * per the repo rule. The first test is the regression guard for the bug this module
 * exists to fix: one process-global email stamped onto every Claude session.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Full suite is path-portable (path.join + real fs). No file-wide win32 skip
// (RUSH-2215 review). os.homedir() on Windows reads USERPROFILE, not HOME.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-accounts-test-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.AGENTS_DIR = path.join(TEST_HOME, '.agents');

// Imported after HOME/USERPROFILE is redirected: the module captures os.homedir() at load.
const { buildClaudeAccountIndex, resolveClaudeAccount } =
  await import('./claude-accounts.js');

/** Two orgs deliberately share an email — the trap this module must not fall into. */
const MODSQUAD = { org: 'org-modsquad', email: 'dev@modsquad.example', name: 'ModSquad', type: 'claude_team' };
const TURING_TEAM = { org: 'org-turing-team', email: 'dev@turing.example', name: 'Turing Labs', type: 'claude_team' };
const TURING_MAX = { org: 'org-turing-personal', email: 'dev@turing.example', name: "dev's Organization", type: 'claude_max' };
const RIVER = { org: 'org-river', email: 'river@example.com', name: 'River Co', type: 'claude_max' };

interface Acct { org: string; email: string; name: string; type: string }

function historyDir(): string {
  return path.join(TEST_HOME, '.agents', '.history');
}

function writeHome(home: string, acct: Acct | null): void {
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  const config = acct
    ? {
      oauthAccount: {
        accountUuid: `acct-${acct.email}`,
        emailAddress: acct.email,
        organizationUuid: acct.org,
        organizationName: acct.name,
        organizationType: acct.type,
      },
    }
    // Signed out: a config with no oauthAccount at all.
    : { numStartups: 3 };
  fs.writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify(config));
}

function versionHome(version: string): string {
  return path.join(historyDir(), 'versions', 'claude', version, 'home');
}

/** An account-slot home (PHNX-3940): `<historyDir>/accounts/claude/<accountId>/`. */
function slotHome(accountId: string): string {
  return path.join(historyDir(), 'accounts', 'claude', accountId);
}

function trashHome(version: string, stamp: string): string {
  return path.join(historyDir(), 'trash', 'versions', 'claude', version, stamp, 'home');
}

/** A transcript path inside a home's config dir. */
function transcript(home: string, name: string): string {
  return path.join(home, '.claude', 'projects', '-some-project', `${name}.jsonl`);
}

beforeAll(() => {
  writeHome(versionHome('2.1.219'), MODSQUAD);
  writeHome(versionHome('2.1.220'), TURING_TEAM);
  writeHome(versionHome('2.1.218'), TURING_MAX);
  writeHome(versionHome('2.1.170'), null);            // signed out
  writeHome(trashHome('2.1.183', '2026-07-01T00-00-00Z'), TURING_TEAM);  // retired, still identifiable
  writeHome(trashHome('2.1.200', '2026-07-21T00-00-00Z'), MODSQUAD);
  // One version with two retired snapshots that disagree — must not be guessed.
  writeHome(trashHome('2.1.215', '2026-07-01T00-00-00Z'), MODSQUAD);
  writeHome(trashHome('2.1.215', '2026-07-27T00-00-00Z'), TURING_TEAM);

  // The live symlink, pointing at the ModSquad home like the real layout does.
  // Windows CI has no Developer Mode for file symlinks; a directory junction works.
  const linkType = process.platform === 'win32' ? 'junction' : undefined;
  fs.symlinkSync(path.join(versionHome('2.1.219'), '.claude'), path.join(TEST_HOME, '.claude'), linkType);

  // An account slot (PHNX-3940): its own single-tenant home, sharing no version.
  writeHome(slotHome('acct-river-0001'), RIVER);
});

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('buildClaudeAccountIndex', () => {
  it('keys on the org, so two orgs sharing one email stay distinct', () => {
    const index = buildClaudeAccountIndex();
    const team = resolveClaudeAccount(index, transcript(versionHome('2.1.220'), 'a'));
    const max = resolveClaudeAccount(index, transcript(versionHome('2.1.218'), 'b'));

    expect(team.email).toBe(max.email);          // same email…
    expect(team.key).not.toBe(max.key);          // …different quota bucket
    expect(team.key).toContain('org-turing-team');
    expect(max.key).toContain('org-turing-personal');
    expect(team.plan).toBe('Team');
    expect(max.plan).toBe('Max');
  });

  it('discovers retired trash homes, which keep their config', () => {
    const index = buildClaudeAccountIndex();
    const bucket = resolveClaudeAccount(
      index,
      transcript(trashHome('2.1.183', '2026-07-01T00-00-00Z'), 'c'),
    );
    expect(bucket.attributed).toBe(true);
    expect(bucket.orgName).toBe('Turing Labs');
    expect(bucket.evidence).toBe('version-home');
  });
});

describe('resolveClaudeAccount', () => {
  it('attributes each version home to its own account, not one global email', () => {
    // The regression guard. Before this module the scanner resolved a single email
    // and stamped it on every Claude session, so all three of these came back equal.
    const index = buildClaudeAccountIndex();
    const buckets = ['2.1.219', '2.1.220', '2.1.218'].map((v) =>
      resolveClaudeAccount(index, transcript(versionHome(v), 'x')),
    );
    expect(new Set(buckets.map((b) => b.key)).size).toBe(3);
    expect(buckets.map((b) => b.orgName)).toEqual(['ModSquad', 'Turing Labs', "dev's Organization"]);
  });

  it('uses the recorded version for rows under the mutable ~/.claude symlink', () => {
    const index = buildClaudeAccountIndex();
    const underSymlink = path.join(TEST_HOME, '.claude', 'projects', '-p', 'y.jsonl');

    // The symlink points at 2.1.219 (ModSquad), but this row was written by 2.1.220.
    const byVersion = resolveClaudeAccount(index, underSymlink, '2.1.220');
    expect(byVersion.orgName).toBe('Turing Labs');
    expect(byVersion.evidence).toBe('recorded-version');

    // A retired-only version still resolves, from its trash snapshot.
    expect(resolveClaudeAccount(index, underSymlink, '2.1.200').orgName).toBe('ModSquad');

    // With no recorded version the current target is the only evidence available,
    // and the weaker tier is reported as such.
    const fallback = resolveClaudeAccount(index, underSymlink, null);
    expect(fallback.orgName).toBe('ModSquad');
    expect(fallback.evidence).toBe('symlink-target');
  });

  it('reports a signed-out home as dark rather than guessing', () => {
    const index = buildClaudeAccountIndex();
    const bucket = resolveClaudeAccount(index, transcript(versionHome('2.1.170'), 'z'));
    expect(bucket.attributed).toBe(false);
    expect(bucket.key).toBe('unattributed:signed-out home 2.1.170');
  });

  it('refuses to pick between disagreeing snapshots of one version', () => {
    const index = buildClaudeAccountIndex();
    const underSymlink = path.join(TEST_HOME, '.claude', 'projects', '-p', 'w.jsonl');
    const bucket = resolveClaudeAccount(index, underSymlink, '2.1.215');
    expect(bucket.attributed).toBe(false);
    expect(bucket.key).toContain('ambiguous');
  });

  it('keeps distinct dark reasons in distinct buckets', () => {
    const index = buildClaudeAccountIndex();
    const backup = resolveClaudeAccount(
      index,
      path.join(historyDir(), 'backups', 'claude', '2026-07-01', 'projects', '-p', 'v.jsonl'),
    );
    const unknown = resolveClaudeAccount(index, '');
    const signedOut = resolveClaudeAccount(index, transcript(versionHome('2.1.170'), 'z'));

    expect(backup.key).toBe('unattributed:backup mirror');   // no recorded version
    expect(unknown.key).toBe('unattributed:unknown home');
    expect(new Set([backup.key, unknown.key, signedOut.key]).size).toBe(3);
  });

  it('attributes a routine archive outside every home by its recorded version', () => {
    // readRoutineArchiveMeta feeds paths under <historyDir>/runs through the same
    // resolver. They match no home prefix, so only the recorded version can place them.
    const index = buildClaudeAccountIndex();
    const archive = path.join(historyDir(), 'runs', 'job-1', 'transcript.jsonl');
    const bucket = resolveClaudeAccount(index, archive, '2.1.220');
    expect(bucket.attributed).toBe(true);
    expect(bucket.orgName).toBe('Turing Labs');
    expect(bucket.evidence).toBe('recorded-version');
  });

  it('prefers a signed-out home over the recorded version, since location is proof', () => {
    // The file lives in 2.1.170's signed-out home but records version 2.1.220, which IS
    // signed in. The location proves which config dir Claude used, so this stays dark
    // rather than borrowing another version's account.
    const index = buildClaudeAccountIndex();
    const bucket = resolveClaudeAccount(index, transcript(versionHome('2.1.170'), 'q'), '2.1.220');
    expect(bucket.attributed).toBe(false);
    expect(bucket.key).toBe('unattributed:signed-out home 2.1.170');
  });

  it('stays dark when a recorded version names no home, instead of using the symlink', () => {
    // Regression guard: an uninstalled version whose trash snapshot was pruned must NOT
    // fall through to whatever ~/.claude points at now. That would silently move those
    // rows onto the current default account — the inference tier 2 exists to prevent.
    const index = buildClaudeAccountIndex();
    const underSymlink = path.join(TEST_HOME, '.claude', 'projects', '-p', 'gone.jsonl');
    const bucket = resolveClaudeAccount(index, underSymlink, '9.9.999');
    expect(bucket.attributed).toBe(false);
    expect(bucket.key).toBe('unattributed:no home for version 9.9.999');
  });

  it('resolves a backup mirror by its recorded version, dark only without one', () => {
    // A mirror has no .claude.json of its own, but the recorded version still names
    // the home that wrote it.
    const index = buildClaudeAccountIndex();
    const mirror = path.join(historyDir(), 'backups', 'claude', '2026-07-01', 'projects', '-p', 'm.jsonl');
    expect(resolveClaudeAccount(index, mirror, '2.1.220').orgName).toBe('Turing Labs');
    expect(resolveClaudeAccount(index, mirror).key).toBe('unattributed:backup mirror');
  });

  it('never returns null, so no transcript is silently dropped', () => {
    const index = buildClaudeAccountIndex();
    for (const p of ['', '/nowhere/at/all.jsonl', 'relative.jsonl']) {
      const bucket = resolveClaudeAccount(index, p);
      expect(bucket.key).toBeTruthy();
      expect(bucket.attributed).toBe(false);
    }
  });
});

describe('account slots (PHNX-3940)', () => {
  it('proves a slot-launched transcript by canonical account-root ownership (tier 1)', () => {
    // Before this fix, buildClaudeAccountIndex only ever walked versions/claude/ and
    // its trash — an account-slot home was never indexed, so this transcript existed
    // (fully registered, runnable account) yet resolved as if the history had vanished.
    const index = buildClaudeAccountIndex();
    const bucket = resolveClaudeAccount(index, transcript(slotHome('acct-river-0001'), 'r'));
    expect(bucket.attributed).toBe(true);
    expect(bucket.orgName).toBe('River Co');
    expect(bucket.evidence).toBe('version-home'); // same direct-ownership tier as a version home
  });

  it('exposes the slot by its account id for launch-recorded resolution', () => {
    const index = buildClaudeAccountIndex();
    const bucket = index.byAccountId.get('acct-river-0001');
    expect(bucket?.orgName).toBe('River Co');
  });

  it('never folds an unconfigured (never signed-in) slot into a real account', () => {
    const index = buildClaudeAccountIndex();
    expect(index.byAccountId.has('acct-never-configured')).toBe(false);
    // And it must not appear as a dark home either — an empty slot owns no
    // transcript yet, so there is nothing on disk to misattribute.
    const emptySlot = slotHome('acct-never-configured');
    expect(index.darkHomes.some((d) => d.prefix.startsWith(emptySlot))).toBe(false);
  });

  it('accepts a launch-recorded account id (tier 1c) for a row outside every home, '
    + 'truthfully preferring it over the CURRENT login of a shared legacy home', () => {
    // Simulates the exact "current login in legacy home does not prove history" bug:
    // 2.1.219's live home reports ModSquad TODAY, but this particular row was actually
    // launched under the River account slot (recorded at launch time, e.g. an older
    // in-place rotation through that shared home before slots existed). A recorded
    // launch id must not be silently outranked by "whichever login is there now".
    const index = buildClaudeAccountIndex();
    const outsideEveryHome = path.join(historyDir(), 'runs', 'job-legacy', 'transcript.jsonl');

    const withoutLaunchId = resolveClaudeAccount(index, outsideEveryHome, '2.1.219');
    expect(withoutLaunchId.orgName).toBe('ModSquad');
    expect(withoutLaunchId.evidence).toBe('recorded-version');

    const withLaunchId = resolveClaudeAccount(index, outsideEveryHome, '2.1.219', 'acct-river-0001');
    expect(withLaunchId.orgName).toBe('River Co');
    expect(withLaunchId.evidence).toBe('version-home');
  });

  it('keeps a removed recorded account unknown instead of assigning current version credentials', () => {
    const index = buildClaudeAccountIndex();
    const outsideEveryHome = path.join(historyDir(), 'runs', 'job-legacy', 'transcript-2.jsonl');
    const bucket = resolveClaudeAccount(index, outsideEveryHome, '2.1.220', 'acct-does-not-exist');
    expect(bucket.attributed).toBe(false);
    expect(bucket.evidence).toBe('none');
  });

  it('preserves launch identity after a legacy home changes credentials', () => {
    const index = buildClaudeAccountIndex();
    const inTuringHome = transcript(versionHome('2.1.220'), 'in-place');
    const bucket = resolveClaudeAccount(index, inTuringHome, '2.1.220', 'acct-river-0001');
    expect(bucket.orgName).toBe('River Co');
    expect(bucket.evidence).toBe('version-home');
  });
});
