/**
 * Which Claude account produced a transcript.
 *
 * A Claude `.jsonl` records `sessionId`, `cwd`, `version`, `gitBranch` and per-message
 * `usage`, but carries **no account identity** — no `accountUuid`, no
 * `organizationUuid`, no email. What agents-cli does have is per-account homes: every
 * installed version gets its own home with its own `.claude.json` (`CLAUDE_CONFIG_DIR`
 * is swapped per version, see lib/exec.ts), and — since PHNX-3940 — a named account
 * additionally gets its own single-tenant slot home under
 * `<historyDir>/accounts/claude/<accountId>/` (lib/accounts/slots.ts), sharing the one
 * managed install rather than owning a version of its own. Either way, a home
 * identifies an account.
 *
 * This matters because the default run strategy is `balanced` (lib/rotate.ts), which
 * sprays sessions across every signed-in account. Before this module the scanner
 * resolved ONE email process-globally and stamped it on every Claude session, so a
 * machine with several accounts reported all of its history under whichever one
 * happened to resolve first.
 *
 * Grouping is keyed on the **org** (`usageKey`), never the email: two orgs under one
 * email (a Team seat and a personal Max plan) are separate quota buckets and must stay
 * distinct — the same invariant `candidateIdentity` enforces in lib/rotate.ts. This key
 * is a QUOTA GROUP, not a login: two distinct account slots can share one org (an
 * enterprise plan with several seats) and therefore one `key`, so `accountKey` must
 * never be read as "the" account a session ran under — only `entries`/`byAccountId`
 * (below) name a specific home/slot, and several of them may legitimately map to the
 * same grouping key.
 *
 * ## Evidence tiers
 *
 * Attribution is a pure function of (path, recorded version, launch-recorded account
 * id). It performs no per-file I/O and does not need the transcript to still exist,
 * which is what lets the v33 migration backfill already-indexed rows without
 * re-parsing anything.
 *
 * 1. **The path names a home we can identify.** Strongest: the file physically lives in
 *    that home — a version home, an account-slot home, or a retired `trash/` snapshot,
 *    every one of which keeps its own `.claude.json`.
 * 1b. **The path names a home that exists but is signed out.** Dark, named after that
 *    home. The location proves which config dir Claude used, so this deliberately beats
 *    a recorded version — attributing it to some other version's account would be a
 *    guess dressed as evidence.
 * 1c. **A launch-recorded account id resolves to a known slot.** The account a launch
 *    actually picked (`resolveActor`'s choice, carried in the actor sidecar once it
 *    records one), for a transcript sitting outside every identifiable home. Beats
 *    tier 2 for the same reason 1b beats it: a fact captured when the session started
 *    outranks inferring identity from whichever login a *shared* legacy home names
 *    TODAY. A single-tenant account-slot home never needs this tier — it is already
 *    tier 1 — this exists for the pre-PHNX-3940 shared-version-home world, where a
 *    login can rotate through one home over time and "who's signed in now" says
 *    nothing about who was signed in when an older row in that home was written.
 * 2. **The path is outside every known home, and the row records a version.** Resolve
 *    that version's own home. Covers the mutable `~/.claude` symlink and the routine
 *    archives under `<historyDir>/runs` that `readRoutineArchiveMeta` feeds in. The
 *    symlink's target moves with `agents use`, so "whatever it points at now" is weak
 *    evidence for old rows: on the machine this was developed against only 684 of 1,334
 *    such rows came from the version the symlink currently names, and 322 came from
 *    versions belonging to a *different* org. A CURRENT login in that home proves who
 *    can sign in there today, never who actually produced an older transcript sitting
 *    in it — tier 1c above is the truthful escape hatch where a launch record exists.
 * 3. **Under the symlink with no recorded version at all.** Its current target is the
 *    only evidence there is, and the bucket says so via `evidence`. A version that IS
 *    recorded but resolves to no home stops at tier 2 and stays dark — it never
 *    reaches here.
 * 4. **None of the above.** An explicitly dark bucket, labelled with why. Never folded
 *    into a real account and never dropped.
 *
 * ## Harness scope: Claude only, deliberately
 *
 * Attribution is implemented for Claude and no other harness. It depends on the
 * per-version home carrying an `oauthAccount` in `.claude.json`, which is what makes a
 * home equal an account. The other harnesses do have per-version credential files
 * (`CREDENTIAL_FILE_SEGMENTS` in lib/agents.ts), so the mechanism generalizes — codex
 * stores an `auth.json` JWT, gemini a `google_accounts.json` — but each needs its own
 * identity extractor and its own notion of a quota bucket, and none of them has the
 * two-orgs-one-email problem that motivated keying on the org here.
 *
 * Until that lands, a non-Claude session has a NULL `account_key` and rolls up under
 * `unattributed:<agent>` — named after its harness rather than implying we tried and
 * failed. `--by account` on `agents insights cost` / `agents insights output` therefore reports Claude
 * accounts plus one bucket per other harness.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { readClaudeHomeConfig } from '../agents.js';
import { getAgentsDir, getHistoryDir } from '../state.js';

const HOME = os.homedir();
const VERSIONS_ROOTS = [getHistoryDir(), getAgentsDir()];

/** The account a transcript is attributed to. */
export interface ClaudeAccountBucket {
  /**
   * Stable grouping key. For an attributed bucket this is the org-scoped `usageKey`
   * (e.g. `claude:org=<uuid>`). For an unattributed one it is `unattributed:<reason>`
   * so distinct dark sources never merge into each other or into a real account.
   */
  key: string;
  /** True when the key came from a real `oauthAccount`. */
  attributed: boolean;
  email: string | null;
  orgName: string | null;
  /** "Team", "Max", "Pro", … derived from `organizationType`. */
  plan: string | null;
  /** Display string: org and email, or the reason a bucket is dark. */
  label: string;
  /** Which evidence tier produced this attribution. */
  evidence: 'version-home' | 'recorded-version' | 'symlink-target' | 'none';
}

interface HomeEntry {
  /** Literal path prefix a transcript must start with to belong to this home. */
  prefix: string;
  bucket: ClaudeAccountBucket;
}

/** Resolver over the Claude homes present on this machine. */
export interface ClaudeAccountIndex {
  /** Version-, account-slot-, and trash-home prefixes, longest first. Excludes the `~/.claude` symlink. */
  entries: HomeEntry[];
  /**
   * Config-dir prefixes of homes that exist but carry no `oauthAccount`. Kept
   * separately from `entries` so a transcript living in a signed-out home is reported
   * against THAT home rather than falling through to its recorded version: the file's
   * location is what proves which config dir Claude was pointed at.
   */
  darkHomes: Array<{ prefix: string; version: string | null }>;
  /**
   * Claude CLI version → the account that version ran as. `'ambiguous'` when retired
   * snapshots of one version disagree and no live home settles it, which is reported
   * as dark rather than guessed.
   */
  byVersion: Map<string, ClaudeAccountBucket | 'ambiguous'>;
  /**
   * Account-slot id (`<historyDir>/accounts/claude/<accountId>/`, PHNX-3940) →
   * the identity read from that slot's own `.claude.json`. A slot's identity is
   * proven the same way a version home's is — tier 1 evidence, see
   * {@link resolveClaudeAccount} — so this map exists only to let a launch-
   * recorded accountId (once the actor sidecar carries one) resolve straight to
   * a bucket without re-deriving it from a path.
   */
  byAccountId: Map<string, ClaudeAccountBucket>;
  /** Whatever `~/.claude` points at right now; tier-3 evidence only. */
  symlinkBucket: ClaudeAccountBucket | null;
  /** Literal prefix of the live symlinked config dir. */
  symlinkPrefix: string;
}

/** `claude_team` → "Team", `claude_max` → "Max". Mirrors lib/agents.ts's label logic. */
function planFromOrgType(orgType: string | null): string | null {
  if (!orgType) return null;
  const m = /^claude_(.+)$/.exec(orgType);
  if (!m) return orgType;
  return m[1].charAt(0).toUpperCase() + m[1].slice(1);
}

function bucketForHome(
  home: string,
  evidence: ClaudeAccountBucket['evidence'],
): ClaudeAccountBucket | null {
  const cfg = readClaudeHomeConfig(home);
  if (!cfg) return null;
  const { email, organizationName: orgName, usageKey, accountKey, organizationType } = cfg.identity;
  // No org uuid means no quota bucket to key on. Fall back to the narrower account key,
  // then the email — an identity we cannot key is not one we should guess at.
  const key = usageKey ?? accountKey ?? (email ? `claude:email=${email}` : null);
  if (!key) return null;
  return {
    key,
    attributed: true,
    email,
    orgName,
    plan: planFromOrgType(organizationType),
    label: orgName && email ? `${orgName} <${email}>` : (orgName ?? email ?? key),
    evidence,
  };
}

/** A dark bucket, labelled by why it is dark so two dark sources never merge. */
function unattributed(reason: string): ClaudeAccountBucket {
  return {
    key: `unattributed:${reason}`,
    attributed: false,
    email: null,
    orgName: null,
    plan: null,
    label: `unattributed (${reason})`,
    evidence: 'none',
  };
}

function listDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Enumerate every Claude home that could own an indexed transcript. Includes retired
 * `trash/` snapshots: they keep their `.claude.json`, so a transcript indexed before
 * its version was rotated out stays attributable.
 */
export function buildClaudeAccountIndex(): ClaudeAccountIndex {
  const entries: HomeEntry[] = [];
  const darkHomes: Array<{ prefix: string; version: string | null }> = [];
  const liveByVersion = new Map<string, ClaudeAccountBucket>();
  const trashByVersion = new Map<string, ClaudeAccountBucket[]>();
  const byAccountId = new Map<string, ClaudeAccountBucket>();

  const addHome = (home: string, version: string | null, retired: boolean): void => {
    const bucket = bucketForHome(home, 'version-home');
    if (!bucket) {
      // The home exists on disk but has no usable identity. Record its prefix so
      // resolution can name it instead of guessing from a recorded version.
      if (fs.existsSync(path.join(home, '.claude'))) {
        darkHomes.push({ prefix: path.join(home, '.claude'), version });
      }
      return;
    }
    entries.push({ prefix: path.join(home, '.claude'), bucket });
    if (!version) return;
    if (retired) {
      const list = trashByVersion.get(version) ?? [];
      list.push(bucket);
      trashByVersion.set(version, list);
    } else {
      liveByVersion.set(version, bucket);
    }
  };

  for (const root of VERSIONS_ROOTS) {
    const versionsBase = path.join(root, 'versions', 'claude');
    for (const version of listDirs(versionsBase)) {
      addHome(path.join(versionsBase, version, 'home'), version, false);
    }
  }

  // Retired homes: <historyDir>/trash/versions/claude/<version>/<timestamp>/home
  const trashBase = path.join(getHistoryDir(), 'trash', 'versions', 'claude');
  for (const version of listDirs(trashBase)) {
    for (const stamp of listDirs(path.join(trashBase, version))) {
      addHome(path.join(trashBase, version, stamp, 'home'), version, true);
    }
  }

  // Account slots (PHNX-3940): a named account gets its own HOME-shaped dir at
  // <historyDir>/accounts/claude/<accountId>/, sharing the one managed install
  // rather than owning a version home of its own (lib/accounts/slots.ts
  // `slotDir`). Each slot's `.claude.json` proves ITS identity exactly as
  // directly as a version home's — tier 1 evidence in `resolveClaudeAccount` —
  // so without this, every transcript a slot-launched session wrote was
  // discoverable (the account is registered and runnable) yet permanently
  // unattributed here, and `isManagedSessionFile`/`getAgentSessionDirs` would
  // never even have scanned it in the first place. An unconfigured slot (never
  // signed in) yields no bucket and is simply skipped, not recorded dark — a
  // slot with nothing written to it yet owns no transcript to misattribute.
  const accountsBase = path.join(getHistoryDir(), 'accounts', 'claude');
  for (const accountId of listDirs(accountsBase)) {
    const home = path.join(accountsBase, accountId);
    const bucket = bucketForHome(home, 'version-home');
    if (!bucket) continue;
    entries.push({ prefix: path.join(home, '.claude'), bucket });
    byAccountId.set(accountId, bucket);
  }

  // A live home is authoritative for its version. Otherwise the retired snapshots
  // decide, but only when they agree — disagreement is reported, not resolved.
  const byVersion = new Map<string, ClaudeAccountBucket | 'ambiguous'>();
  for (const [version, list] of trashByVersion) {
    const keys = new Set(list.map((b) => b.key));
    byVersion.set(
      version,
      keys.size === 1 ? { ...list[0], evidence: 'recorded-version' } : 'ambiguous',
    );
  }
  for (const [version, bucket] of liveByVersion) {
    byVersion.set(version, { ...bucket, evidence: 'recorded-version' });
  }

  // Longest prefix first so a nested home beats a shorter ancestor.
  entries.sort((a, b) => b.prefix.length - a.prefix.length);

  darkHomes.sort((a, b) => b.prefix.length - a.prefix.length);

  return {
    entries,
    darkHomes,
    byVersion,
    byAccountId,
    symlinkBucket: bucketForHome(HOME, 'symlink-target'),
    symlinkPrefix: path.join(HOME, '.claude'),
  };
}

/** Version segment of a versions/ or trash/ path, for labelling dark buckets. */
function versionFromPath(filePath: string): string | null {
  const m = /[/\\]versions[/\\]claude[/\\]([^/\\]+)[/\\]/.exec(filePath);
  return m ? m[1] : null;
}

/**
 * The account bucket a transcript belongs to. `recordedVersion` is the Claude CLI
 * version stored on the session row (`sessions.version`), which is what disambiguates
 * rows sitting under the mutable `~/.claude` symlink. `launchAccountId` is the
 * account-slot id captured at launch time (the actor sidecar's `accountId`, once
 * populated — see the module docblock's evidence tiers), when the caller has it.
 *
 * Never returns null: a transcript that matches no known home resolves to an
 * explicitly dark bucket rather than being dropped or folded into a real account.
 * Backup mirrors (`<historyDir>/backups/claude/<stamp>/projects/…`) carry no
 * `.claude.json` of their own, so they resolve by recorded version like any other
 * out-of-home path, and go dark only when that version names no home.
 */
export function resolveClaudeAccount(
  index: ClaudeAccountIndex,
  filePath: string,
  recordedVersion?: string | null,
  launchAccountId?: string | null,
): ClaudeAccountBucket {
  // Tier 1 — the file physically lives in a home we can identify.
  for (const entry of index.entries) {
    if (filePath.startsWith(entry.prefix + path.sep)) return entry.bucket;
  }

  // Tier 1b — it lives in a home that exists but is signed out. The location proves
  // which config dir Claude used, so this beats any recorded version: reporting it
  // against a *different* version's account would be a guess dressed as evidence.
  for (const dark of index.darkHomes) {
    if (filePath.startsWith(dark.prefix + path.sep)) {
      return unattributed(dark.version ? `signed-out home ${dark.version}` : 'signed-out home');
    }
  }

  // Tier 1c — a launch-recorded account id that resolves to a known slot's
  // identity. This is a fact captured AT THE MOMENT the session started (which
  // account the launcher actually picked), so for a transcript that sits
  // outside any identifiable home — the shared legacy version-home path, or the
  // mutable ~/.claude symlink — it beats tier 2's inference below. Tier 2 asks
  // "who does this version's home say it belongs to *today*", and a login can
  // rotate through a shared legacy home over time (account-slot homes above are
  // each single-tenant and never need this); the current answer proves nothing
  // about an older row in that same home. A launch id with no matching slot
  // (an unresolved sidecar, or a slot since removed) falls through unchanged.
  if (launchAccountId) {
    const bucket = index.byAccountId.get(launchAccountId);
    if (bucket) return bucket;
  }

  // Tier 2 — outside every known home. The recorded version names the home that ran,
  // which covers both the mutable ~/.claude symlink and the routine/run archives under
  // <historyDir>/runs that readRoutineArchiveMeta feeds through this same path.
  if (recordedVersion) {
    const byVersion = index.byVersion.get(recordedVersion);
    if (byVersion === 'ambiguous') {
      return unattributed(`ambiguous history for version ${recordedVersion}`);
    }
    if (byVersion) return byVersion;
    // Recorded but unresolvable — the version was uninstalled and its trash snapshot
    // pruned. Stay dark. Falling through to the symlink's current target would move
    // these rows onto whichever account happens to be default now, which is the
    // inference tier 2 exists to avoid.
    return unattributed(`no home for version ${recordedVersion}`);
  }

  // Tier 3 — under the live symlink with no recorded version at all. Its current
  // target is the only evidence that exists. A recorded-but-unresolvable version
  // returned dark from tier 2 above and never arrives here.
  if (filePath.startsWith(index.symlinkPrefix + path.sep) && index.symlinkBucket) {
    return index.symlinkBucket;
  }

  const version = versionFromPath(filePath);
  if (version) return unattributed(`signed-out home ${version}`);
  if (filePath.includes(`${path.sep}backups${path.sep}claude${path.sep}`)) {
    return unattributed('backup mirror');
  }
  return unattributed('unknown home');
}
