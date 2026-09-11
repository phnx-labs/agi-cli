import { afterEach, describe, expect, it, vi } from 'vitest';
import { menubarHelperCacheDir } from './download-menubar.js';
import { helperFloor } from '../helper-versions.js';
import { serviceManagerRegistrationAllowed } from '../service-manifest.js';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  classifyMenubarProcesses,
  codesignVerifies,
  gatekeeperAssesses,
  generateServicePlist,
  hasDeveloperIdSignature,
  installMenubarLaunchAgentOnUpgrade,
  isMenubarStale,
  cachedFloorBundlePath,
  menubarHelperPrefetchNeeded,
  stampVersionLabel,
  LOCAL_BUILD_LABEL,
  releaseVersionOfCachedBundle,
  stampFor,
  isMenubarProcessStaleAgainstBundle,
  menubarHealReplacedBundle,
  menubarPlistNeedsRepoint,
  mayInstallMenubarHelper,
  MENUBAR_HELPER_EXECUTABLE_NAME,
  processesToEnd,
  resetMenubarAccessibilityTcc,
  restartMenubarHelperAfterSwap,
  restartMenubarLaunchAgent,
  serviceLabel,
  shouldMigrateMenubarTcc,
} from './install-menubar.js';

// Regression guard for the STOLEN-HOTKEY blind spot. Status used
// `pgrep -f MenubarHelper` (the executable's pre-RUSH-3101 name), which matches
// ANY process with that name — so a stray dev build launched over ssh reported
// `running: yes` while it, not the installed bundle, held the global
// Cmd-Shift-V chord (RegisterEventHotKey is first-come). The paste was dead and
// status said everything was fine. The fixtures below are the real
// `ps -axo pid=,command=` lines from that incident, renamed to the current
// executable ("AGI Menu") — the bundle folder itself is still MenubarHelper.app.
describe('classifyMenubarProcesses', () => {
  // Note the space in "Application Support" (and in "AGI Menu" itself) — the
  // reason pid/field parsing takes the rest of the line rather than splitting
  // on whitespace.
  const INSTALLED =
    '/Users/muqsit/Library/Application Support/agents-cli/MenubarHelper.app/Contents/MacOS/AGI Menu';
  // Orphaned SwiftPM debug build from a deleted worktree, started over ssh.
  const ORPHAN =
    '/Users/muqsit/src/github.com/muqsitnawaz/agents-cli/.agents/worktrees/menubar-verify/cli/menubar/.build/arm64-apple-macosx/debug/AGI Menu';

  it('reports the installed bundle as running', () => {
    const r = classifyMenubarProcesses(`74027 ${INSTALLED}`, `74027 ${INSTALLED}`, INSTALLED);
    expect(r.own.map((p) => p.pid)).toEqual([74027]);
    expect(r.foreign).toEqual([]);
  });

  it('flags a stray build as foreign, not as the installed helper running', () => {
    const r = classifyMenubarProcesses(`58619 ${ORPHAN}`, `58619 .build/debug/AGI Menu --self-test`, INSTALLED);
    expect(r.own).toEqual([]);
    expect(r.foreign).toEqual([{ pid: 58619, executable: ORPHAN }]);
  });

  it('separates the two when both are alive — the state that broke the paste', () => {
    const comm = `74027 ${INSTALLED}\n58619 ${ORPHAN}`;
    const r = classifyMenubarProcesses(comm, comm, INSTALLED);
    expect(r.own.map((p) => p.pid)).toEqual([74027]);
    expect(r.foreign.map((p) => p.pid)).toEqual([58619]);
  });

  // The DUPLICATE-ICON blind spot: launchd's KeepAlive copy and a
  // LaunchServices/`open` launch of the SAME .app both run the installed
  // executable, so a boolean `running` reported this as healthy while the user
  // looked at two agents marks in the menu bar. Both pids must be visible.
  it('reports BOTH copies when the installed bundle is running twice', () => {
    const comm = `43244 ${INSTALLED}\n93684 ${INSTALLED}`;
    const r = classifyMenubarProcesses(comm, comm, INSTALLED);
    expect(r.own.map((p) => p.pid)).toEqual([43244, 93684]);
    expect(r.foreign).toEqual([]);
  });

  it('ignores --notify one-shots (installed binary, but never the status item)', () => {
    const r = classifyMenubarProcesses(
      `91002 ${INSTALLED}`,
      `91002 ${INSTALLED} --notify --title Done`,
      INSTALLED,
    );
    expect(r.own).toEqual([]);
    expect(r.foreign).toEqual([]);
  });

  // A --notify one-shot running alongside the real status item must not be
  // mistaken for the duplicate — setup would then kill a healthy single helper.
  it('does not count a --notify one-shot as a second copy', () => {
    const comm = `43244 ${INSTALLED}\n91002 ${INSTALLED}`;
    const command = `43244 ${INSTALLED}\n91002 ${INSTALLED} --notify --title Done`;
    const r = classifyMenubarProcesses(comm, command, INSTALLED);
    expect(r.own.map((p) => p.pid)).toEqual([43244]);
  });

  // The false positive that a command-line substring match produced: this
  // shell is not a helper, it merely mentions one.
  it('does not flag a shell whose command line merely mentions the helper name', () => {
    const r = classifyMenubarProcesses(
      '18933 /bin/zsh',
      '18933 /bin/zsh -c cp /bin/sleep .build/debug/AGI Menu',
      INSTALLED,
    );
    expect(r.own).toEqual([]);
    expect(r.foreign).toEqual([]);
  });

  it('ignores unrelated processes', () => {
    const ps = '3675 /System/Library/.../com.apple.Passwords.MenuBarExtra\n1 /sbin/launchd';
    const r = classifyMenubarProcesses(ps, ps, INSTALLED);
    expect(r.own).toEqual([]);
    expect(r.foreign).toEqual([]);
  });
});

// `agents menubar setup` ends every live helper and lets launchd restart one,
// so the survivor is always the login-managed copy. Selecting a survivor from
// a `ps` listing instead would risk keeping the UNMANAGED copy alive — the
// duplicate would then come straight back at next login.
describe('processesToEnd', () => {
  const A = { pid: 43244, executable: '/Applications/…/AGI Menu' };
  const B = { pid: 93684, executable: '/Applications/…/AGI Menu' };
  const STRAY = { pid: 58619, executable: '/tmp/.build/debug/AGI Menu' };

  it('ends both copies of a duplicated installed helper', () => {
    expect(processesToEnd({ instances: [A, B], foreignInstances: [] })).toEqual([A, B]);
  });

  it('ends the lone running helper too, so launchd owns the restart', () => {
    expect(processesToEnd({ instances: [A], foreignInstances: [] })).toEqual([A]);
  });

  it('ends foreign copies as well — they hold Cmd-Shift-V/O first-come', () => {
    expect(processesToEnd({ instances: [A], foreignInstances: [STRAY] })).toEqual([A, STRAY]);
  });

  it('ends nothing when no helper is running', () => {
    expect(processesToEnd({ instances: [], foreignInstances: [] })).toEqual([]);
  });
});

// Regression guard for the upgrade self-heal: before this, the helper was only
// (re)installed when no service existed, so `npm update` left the menu bar
// running the previous release's binary. isMenubarStale is the decision that
// must flag an upgraded/missing install for reinstall.
describe('isMenubarStale', () => {
  const REL = (v: string) => ({ source: 'release' as const, helperVersion: v });
  const LOC = (stamp: string) => ({ source: 'local' as const, sourceStamp: stamp });

  it('is stale when the helper binary is gone (App Support cleared)', () => {
    expect(isMenubarStale({ installed: REL('1.0.0'), available: REL('1.0.0'), execExists: false })).toBe(true);
  });

  it('is stale when a NEWER helper is available', () => {
    expect(isMenubarStale({ installed: REL('1.0.0'), available: REL('1.0.1'), execExists: true })).toBe(true);
  });

  it('is NOT stale when the installed helper is newer than the floor', () => {
    // The resolver may legitimately have installed ahead of the floor; a lower
    // available version must never trigger a downgrade-reinstall.
    expect(isMenubarStale({ installed: REL('1.1.0'), available: REL('1.0.0'), execExists: true })).toBe(false);
  });

  it('is NOT stale when the helper version matches and the binary is present', () => {
    expect(isMenubarStale({ installed: REL('1.0.0'), available: REL('1.0.0'), execExists: true })).toBe(false);
  });

  it('is stale on a pre-stamp install (no marker yet)', () => {
    expect(isMenubarStale({ installed: null, available: REL('1.0.0'), execExists: true })).toBe(true);
  });

  it('is stale exactly once on a legacy bare-string stamp, then re-stamped', () => {
    // Old installs wrote the CLI's version as a bare string. That cannot be
    // compared on the helper axis at all, so it is stale once — the reinstall
    // rewrites it as JSON and the next call compares normally.
    expect(isMenubarStale({ installed: { source: 'legacy', raw: '1.22.49' }, available: REL('1.0.0'), execExists: true })).toBe(true);
  });

  it('is stale when the install KIND changes (local <-> release)', () => {
    // A dev build and a release bundle are not interchangeable, whatever their
    // version strings say.
    expect(isMenubarStale({ installed: LOC('/src/MenubarHelper.app@111'), available: REL('1.0.0'), execExists: true })).toBe(true);
    expect(isMenubarStale({ installed: REL('1.0.0'), available: LOC('/src/MenubarHelper.app@111'), execExists: true })).toBe(true);
  });

  it('tracks a local build by source path + mtime, since it carries no version', () => {
    // menubar/scripts/build.sh hardcodes CFBundleShortVersionString, so a local
    // rebuild is only detectable by its source stamp changing.
    expect(isMenubarStale({ installed: LOC('/src/MenubarHelper.app@111'), available: LOC('/src/MenubarHelper.app@111'), execExists: true })).toBe(false);
    expect(isMenubarStale({ installed: LOC('/src/MenubarHelper.app@111'), available: LOC('/src/MenubarHelper.app@222'), execExists: true })).toBe(true);
  });

  it('stamps from the SAME resolved source the installer uses', () => {
    // The blocker this replaces: startMenubarServiceFromSource stamped
    // `stampFor(opts.sourceAppPath)` — the UNRESOLVED parameter — while
    // ensureMenubarAppInstalled resolved `opts.sourceAppPath ?? sourceAppPath()`
    // itself. On the self-heal path (which passes nothing) that installed a
    // LOCAL build while stamping a RELEASE version; the next invocation saw a
    // kind mismatch and reinstalled, forever. Asserted on the source because the
    // composition, not either function alone, is what was wrong.
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'install-menubar.ts'),
      'utf-8',
    );
    const start = src.indexOf('function startMenubarServiceFromSource');
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, src.indexOf('\nfunction ', start + 10));
    expect(fn.length).toBeGreaterThan(200);
    // One resolution, reused — never the raw option in either position.
    expect(fn).toContain('const src = opts.sourceAppPath ?? sourceAppPath()');
    expect(fn).toContain('sourceAppPath: src');
    expect(fn).toContain('stampFor(src)');
    expect(fn).not.toContain('stampFor(opts.sourceAppPath)');
  });

  it('classifies a release only when the bundle is really in its cache dir', () => {
    // A path regex got this wrong both ways: a checkout under any directory with
    // a version-shaped segment read as a release, and vice versa.
    const cacheFor = (v: string) => `/cache/menubar/mac-helper/v${v}`;
    expect(releaseVersionOfCachedBundle('/cache/menubar/mac-helper/v1.0.1/MenubarHelper.app', cacheFor)).toBe('1.0.1');
    // Version-shaped, but not the cache — a checkout, not a release.
    expect(releaseVersionOfCachedBundle('/Users/me/src/v1.0.1/menubar/MenubarHelper.app', cacheFor)).toBeNull();
    // No version at all.
    expect(releaseVersionOfCachedBundle('/Users/me/src/agents-cli/cli/menubar/MenubarHelper.app', cacheFor)).toBeNull();
  });

  it('stampFor uses the real cache dir, not a path pattern', () => {
    // Mutation-driven: making stampFor always return `local` killed no test,
    // because the classifier was only exercised through an injected cache
    // function. This drives stampFor itself against the REAL cache path.
    const inCache = path.join(menubarHelperCacheDir('1.0.1'), 'MenubarHelper.app');
    expect(stampFor(inCache)).toEqual({ source: 'release', helperVersion: '1.0.1' });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-v1.0.1-'));
    const local = path.join(dir, 'MenubarHelper.app');
    fs.mkdirSync(local);
    try {
      const st = stampFor(local);
      expect(st.source).toBe('local');
      if (st.source === 'local') expect(st.sourceStamp.startsWith(`${local}@`)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('converges: what an install stamps is not stale on the next invocation', () => {
    // THE property a reinstall storm violates, stated directly. #2109 was not
    // "the wrong version was compared" — it was that the value written at
    // install time and the value computed at check time disagreed, so the check
    // never settled. Whatever the source, stamping it and then asking about the
    // same source must say "not stale", or the self-heal reinstalls forever.
    //
    // Scope, stated honestly: this does NOT catch the original blocker. That bug
    // lived in the CALLER's composition — install stamped one input while the
    // check derived from another — and is caught by the source assertion in
    // `stamps from the SAME resolved source the installer uses`. Verified by
    // mutation: making stampFor return a constant leaves THIS test green,
    // because both sides then agree on the same wrong value.
    //
    // What it does pin is that stampFor is deterministic for a given input —
    // the other half of convergence. A stampFor that varied run to run (a
    // timestamp, a random temp path) would storm even with the caller correct.
    // Driving installMenubarLaunchAgentOnUpgrade end to end would need
    // codesign/spctl/launchctl stubbed, which this repo forbids.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-converge-'));
    const local = path.join(dir, 'MenubarHelper.app');
    fs.mkdirSync(local);
    try {
      for (const source of [local, path.join(menubarHelperCacheDir('1.0.1'), 'MenubarHelper.app')]) {
        const written = stampFor(source);        // what install persists
        const computed = stampFor(source);       // what the next check derives
        expect(isMenubarStale({ installed: written, available: computed, execExists: true })).toBe(false);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds the cache match even when an earlier path segment looks like a version', () => {
    // Reviewer-found: the classifier took the LEFTMOST version-shaped match, so
    // a genuinely cached bundle under e.g. an nvm dir (`.../v24.15.0/...`)
    // matched that segment, failed the prefix check, and read as a local build.
    const cacheFor = (v: string) => `/Users/me/.nvm/versions/node/v24.15.0/cache/menubar/mac-helper/v${v}`;
    expect(releaseVersionOfCachedBundle(`${cacheFor('1.0.1')}/MenubarHelper.app`, cacheFor)).toBe('1.0.1');
  });

  it('does not let a local build win or lose a version contest', () => {
    // Reviewer-found: excluding LOCAL_BUILD_LABEL from the compareVersions arm
    // had zero coverage — mutating it away killed nothing. `local` is a KIND
    // marker; ordering it against real semver would let a dev build seize a
    // release helper, or be refused by one, on a meaningless comparison.
    const base = {
      ownerEntryExists: true,
      sourceIsDeveloperId: true,
      plistEntry: '/a',
      activeEntry: '/b',            // not the owner, so only a version arm could grant
      helperExecMissing: false,
      needsDevIdHeal: false,
      msSinceLastHeal: 0,
      cooldownMs: 3_600_000,
    };
    expect(mayInstallMenubarHelper({ ...base, installedVersion: '1.0.0', currentVersion: LOCAL_BUILD_LABEL })).toBe(false);
    expect(mayInstallMenubarHelper({ ...base, installedVersion: LOCAL_BUILD_LABEL, currentVersion: '1.0.0' })).toBe(false);
  });

  it('a local rebuild is a real change, not two equal `local` labels', () => {
    // Reviewer-found, third instance of one bug class: stampVersionLabel
    // collapses EVERY local build to the literal 'local', discarding the mtime.
    // Any comparison done through the label therefore reports "unchanged" across
    // a genuine dev rebuild. The stamps themselves distinguish them.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-rebuild-'));
    const app = path.join(dir, 'MenubarHelper.app');
    fs.mkdirSync(app);
    try {
      const before = stampFor(app);
      fs.utimesSync(app, new Date(), new Date(Date.now() + 60_000)); // rebuild
      const after = stampFor(app);

      // Through the lossy label the two are indistinguishable...
      expect(stampVersionLabel(before)).toBe(stampVersionLabel(after));
      // ...but the stamps are not, which is what the comparison must use.
      expect(JSON.stringify(before)).not.toBe(JSON.stringify(after));
      expect(isMenubarStale({ installed: before, available: after, execExists: true })).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the setup bundle step compares stamps, not the lossy label", () => {
    // Mutation-driven: the behavioural test above stays green even when the step
    // label is computed through `stampVersionLabel`, because it exercises
    // stampFor/isMenubarStale rather than the step itself. That step lives inside
    // runMenubarSetup, which needs a signed bundle to reach — so the comparison
    // is asserted at source, the same way the install/stamp composition is.
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'install-menubar.ts'),
      'utf-8',
    );
    // Anchor on the unique symbol, not `step('bundle'` — there are three of
    // those and indexOf finds an error path, not the comparison under test.
    const i = src.indexOf('const bundleUnchanged');
    expect(i).toBeGreaterThan(-1);
    const around = src.slice(i, src.indexOf("step('bundle'", i) + 200);
    // Must go through the canonical comparator on the full stamps...
    expect(around).toContain('isMenubarStale({');
    expect(around).toContain('available: availableStamp()');
    expect(around).not.toMatch(/bundleUnchanged[\s\S]{0,120}stampVersionLabel\(bundleStamp\) ===/);
    expect(around).not.toContain('=== getCliVersion()');
  });

  it('never compares against the CLI version', () => {
    // The bug this replaces: an unchanged helper looked stale on every CLI
    // release (the #2109 restart storm), and a newer helper at the same CLI
    // version never looked stale at all.
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'install-menubar.ts'),
      'utf-8',
    );
    const start = src.indexOf('export function isMenubarStale');
    const end = src.indexOf('function menubarSetupStale');
    // Guard the guard: if either marker is ever renamed the slice silently
    // becomes empty or inverted, and `not.toContain` passes vacuously — the
    // assertion would survive the very regression it exists to catch.
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fn = src.slice(start, end);
    expect(fn.length).toBeGreaterThan(200);
    expect(fn).not.toContain('getCliVersion');
  });
});

// Regression guard for the DUAL-INSTALL skew: the plist was baked by one install
// (e.g. nvm) but the user's `agents` now resolves to another (e.g. bun), so the
// helper kept shelling a stale copy for menu data + the quick-issue dispatch. A
// version bump can't catch this (the copies can even be the same version), so
// the re-point keys off the plist's baked interpreter/entry vs the active one.
describe('menubarPlistNeedsRepoint', () => {
  const nvm = '/Users/me/.nvm/versions/node/v24/lib/node_modules/@phnx-labs/agents-cli/dist/index.js';
  const bun = '/Users/me/.bun/install/global/node_modules/@phnx-labs/agents-cli/dist/index.js';
  const nvmNode = '/Users/me/.nvm/versions/node/v24/bin/node';
  const bunNode = '/Users/me/.bun/bin/node';

  const check = (overrides: Partial<Parameters<typeof menubarPlistNeedsRepoint>[0]>) =>
    menubarPlistNeedsRepoint({
      plistEntry: bun,
      plistNode: bunNode,
      plistNodeExists: true,
      activeEntry: bun,
      activeNode: bunNode,
      ...overrides,
    });

  it('re-points when the plist entry differs from the active install', () => {
    expect(check({ plistEntry: nvm, plistNode: nvmNode })).toBe(true);
  });

  it('keeps a valid recorded interpreter when the same install runs under another Node', () => {
    expect(check({ plistNode: nvmNode })).toBe(false);
  });

  it('re-points when the recorded interpreter no longer exists', () => {
    expect(check({ plistNode: nvmNode, plistNodeExists: false })).toBe(true);
  });

  it('does NOT re-point when the plist already matches the active install', () => {
    expect(check({})).toBe(false);
  });

  it('does NOT re-point (churn) when the active entry cannot be resolved (dev/tsx run)', () => {
    expect(check({ activeEntry: null, activeNode: null })).toBe(false);
  });

  it('re-points a plist that has no baked entry yet (older install)', () => {
    expect(check({ plistEntry: null, plistNode: null, plistNodeExists: false })).toBe(true);
  });
});

// Regression guard for #2109: several agents-cli installs on one box reinstalled
// the helper over each other on EVERY invocation, because both the version stamp
// and the plist's baked entry name whichever copy acted last. Recopying the bundle
// replaces the executable under the live helper and kills it; KeepAlive restarts
// it; the next install repeats it. Observed: a new pid every 5-15s, 578 launches
// in the helper's log, and a status item that never stayed visible while
// `agents menubar status` still said `running: yes`.
//
// Ownership — not content — decides, because content cannot. The helper is
// rebuilt/re-signed/re-notarized every release, so consecutive releases ship
// byte-different bundles from identical source: 1.22.20/21/22 all carry the same
// 2876288-byte executable with three different sha256s and three different
// CDHashes. A digest gate would report "changed" for exactly the skew it was
// meant to exempt, which is why this predicate never looks at bytes.
describe('mayInstallMenubarHelper', () => {
  const brew = '/opt/homebrew/lib/node_modules/@phnx-labs/agents-cli/dist/index.js';
  const nvm = '/Users/me/.nvm/versions/node/v24.15.0/lib/node_modules/@phnx-labs/agents-cli/dist/index.js';
  const HOUR = 60 * 60 * 1000;
  // Healthy install, recent heal — the fields that are not what a case is about.
  const base = {
    helperExecMissing: false,
    needsDevIdHeal: false,
    installedVersion: null,
    currentVersion: null,
    msSinceLastHeal: 60_000,
    cooldownMs: HOUR,
    sourceIsDeveloperId: true,
  };

  it('refuses a foreign install while the recorded owner still exists (#2109)', () => {
    // The steady state that produced the loop: nvm 1.22.5 invoking while the
    // Homebrew copy owns the helper. Before the gate this recopied the bundle and
    // killed the running helper on every invocation.
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: brew, activeEntry: nvm, ownerEntryExists: true,
    })).toBe(false);
  });

  it('allows the owner to reinstall — a same-install upgrade still lands', () => {
    // `npm update` keeps the entry path and only bumps the version, so the
    // staleness path behind this gate must still fire, cooldown or not.
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: brew, activeEntry: brew, ownerEntryExists: true,
    })).toBe(true);
  });

  it('lets a newer signed release take over inside the cooldown', () => {
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: nvm, activeEntry: brew, ownerEntryExists: true,
      installedVersion: '1.22.5', currentVersion: '1.22.25',
    })).toBe(true);
  });

  it('never lets an older release reclaim a newer helper', () => {
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: brew, activeEntry: nvm, ownerEntryExists: true,
      installedVersion: '1.22.25', currentVersion: '1.22.5',
      msSinceLastHeal: HOUR + 1,
    })).toBe(false);
  });

  it('never lets an older release reinstall through a formerly owner-shaped entry', () => {
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: nvm, activeEntry: nvm, ownerEntryExists: true,
      installedVersion: '1.22.25', currentVersion: '1.22.5',
      msSinceLastHeal: HOUR + 1,
    })).toBe(false);
  });

  it('keeps the existing owner stable for an equal-version foreign install', () => {
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: nvm, activeEntry: brew, ownerEntryExists: true,
      installedVersion: '1.22.25', currentVersion: '1.22.25',
      msSinceLastHeal: HOUR + 1,
    })).toBe(false);
  });

  it('lets another install take over once the owner is gone from disk', () => {
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: brew, activeEntry: nvm, ownerEntryExists: false,
      installedVersion: '1.22.25', currentVersion: '1.22.5',
    })).toBe(true);
  });

  it('lets a foreign install take over after the cooldown in unversioned legacy state', () => {
    // The stuck state a pure ownership rule creates: a stale-but-present install
    // (an old nvm node dir nobody runs) owns the plist while the user's daily
    // driver upgrades. Refusing forever would freeze the menu bar at whatever the
    // dead owner last installed. The cooldown bounds the churn without stranding.
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: brew, activeEntry: nvm, ownerEntryExists: true,
      msSinceLastHeal: HOUR + 1,
    })).toBe(true);
  });

  it('treats a never-healed install as past the cooldown', () => {
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: brew, activeEntry: nvm, ownerEntryExists: true,
      msSinceLastHeal: null,
    })).toBe(true);
  });

  it('never blocks a repair: a missing helper executable heals from any install', () => {
    // A bundle that is not there cannot be contested, and gating this behind
    // ownership leaves the menu bar dead with no automatic recovery.
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: brew, activeEntry: nvm, ownerEntryExists: true,
      helperExecMissing: true,
      installedVersion: '1.22.25', currentVersion: '1.22.5',
    })).toBe(true);
  });

  it('never blocks a repair: the Developer-ID heal runs from any install', () => {
    // An ad-hoc copy re-prompts for Accessibility until the identity is restored.
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: brew, activeEntry: nvm, ownerEntryExists: true,
      needsDevIdHeal: true,
      installedVersion: '1.22.25', currentVersion: '1.22.5',
    })).toBe(true);
  });

  it('never lets an ad-hoc/dev build seize a healthy helper on the timer', () => {
    // scripts/install.sh puts a dev build beside the npm global, and its bundle
    // cannot be notarized. Recopying it over a good Developer-ID bundle makes
    // Gatekeeper reject the result as "damaged" and AppKit crash at launch
    // (RUSH-2134) — a broken menu bar, not just a cosmetic restart.
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: brew, activeEntry: nvm, ownerEntryExists: true,
      msSinceLastHeal: HOUR + 1, sourceIsDeveloperId: false,
    })).toBe(false);
  });

  it('refuses an ad-hoc build seizing a HEALTHY helper whose owner-entry is gone', () => {
    // The owner-gone branch is deadlock avoidance, but recopying an ad-hoc bundle
    // over a healthy Developer-ID install poisons its Accessibility grant — the
    // ad-hoc signature fails the grant's stored code requirement, so macOS revokes
    // it and re-prompts on the next paste — and Gatekeeper rejects the result as
    // "damaged" (RUSH-2134). This does NOT deadlock: a genuinely broken helper
    // still heals from any source via escape (1), asserted next.
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: brew, activeEntry: nvm, ownerEntryExists: false,
      sourceIsDeveloperId: false,
    })).toBe(false);
  });

  it('still lets an ad-hoc build repair a BROKEN helper whose owner is gone (no deadlock)', () => {
    // The real "nothing else can install it" case is a MISSING/ad-hoc-installed
    // helper — escape (1) (helperExecMissing / needsDevIdHeal) heals it from ANY
    // source, so refusing the healthy-helper takeover above strands nothing.
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: brew, activeEntry: nvm, ownerEntryExists: false,
      sourceIsDeveloperId: false, helperExecMissing: true,
    })).toBe(true);
  });

  it('still lets a Developer-ID build adopt a healthy helper whose owner-entry is gone', () => {
    // A relocated npm dir (owner AGENTS_ENTRY path vanished) must still self-heal
    // for a legitimately signed install — only ad-hoc sources are refused above.
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: brew, activeEntry: nvm, ownerEntryExists: false,
      sourceIsDeveloperId: true,
    })).toBe(true);
  });

  it('adopts a plist that records no owner yet (older install)', () => {
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: null, activeEntry: brew, ownerEntryExists: false,
      installedVersion: '1.22.25', currentVersion: '1.22.5',
    })).toBe(true);
  });

  it('never churns when the active entry cannot be resolved (dev/tsx run)', () => {
    // Matches menubarPlistNeedsRepoint's existing guard: an unresolvable entry
    // must not be written into the plist or used to seize ownership.
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: brew, activeEntry: null, ownerEntryExists: true,
    })).toBe(false);
  });
});

// Regression guard for the auto-heal restart sequence: without a `bootout` first,
// `bootstrap` fails on modern macOS when the job is already loaded, leaving the
// helper in a dead state after a WindowServer disconnect.
describe('restartMenubarLaunchAgent', () => {
  it('boots out the old job, bootstraps the plist, then kickstarts the service', () => {
    const savedAllow = process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME;
    process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME = '1';
    try {
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const exec = (cmd: string, args: readonly string[]) => {
        calls.push({ cmd, args: args as string[] });
        return Buffer.alloc(0);
      };

      restartMenubarLaunchAgent(501, '/tmp/com.phnx-labs.agents-menubar.plist', exec);

      // The service target is `serviceLabel()`, not the bare literal: under a
      // redirected HOME (every test fork, and any sandboxed run) the identifier is
      // namespaced so this bootout cannot tear down the operator's live helper —
      // launchctl routes by identifier alone, never by the plist path (RUSH-2639).
      const target = `gui/501/${serviceLabel()}`;
      expect(calls).toHaveLength(3);
      expect(calls[0]).toEqual({ cmd: 'launchctl', args: ['bootout', target] });
      expect(calls[1]).toEqual({ cmd: 'launchctl', args: ['bootstrap', 'gui/501', '/tmp/com.phnx-labs.agents-menubar.plist'] });
      expect(calls[2]).toEqual({ cmd: 'launchctl', args: ['kickstart', target] });
    } finally {
      if (savedAllow === undefined) delete process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME;
      else process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME = savedAllow;
    }
  });

  // The assertion above would pass against a hardcoded label too, so pin the
  // property that actually matters: the target the call sites use is derived
  // from HOME. Without it a sandboxed fork boots out the production job.
  it('namespaces the service target under a redirected HOME, and only then', () => {
    const savedHome = process.env.HOME;
    try {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-label-'));
      process.env.HOME = sandbox;
      expect(serviceLabel()).toMatch(/^com\.phnx-labs\.agents-menubar\.sandbox-[0-9a-f]{12}$/);
      fs.rmSync(sandbox, { recursive: true, force: true });

      process.env.HOME = os.userInfo().homedir;
      expect(serviceLabel()).toBe('com.phnx-labs.agents-menubar');
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    }
  });

  it('continues through launchctl errors so a partially-loaded job still gets restarted', () => {
    const savedAllow = process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME;
    process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME = '1';
    try {
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const exec = (cmd: string, args: readonly string[]) => {
        calls.push({ cmd, args: args as string[] });
        throw new Error('launchctl failed');
      };

      expect(() => restartMenubarLaunchAgent(501, '/tmp/com.phnx-labs.agents-menubar.plist', exec)).not.toThrow();
      expect(calls).toHaveLength(3);
    } finally {
      if (savedAllow === undefined) delete process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME;
      else process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME = savedAllow;
    }
  });
});

// Regression guard for the "damaged app" bug (RUSH-2134): the shipped helper is
// Developer-ID signed AND notarized (menubar/scripts/build.sh + the
// verify-menubar-helper.sh prepack gate). A signature alone is NOT enough —
// Gatekeeper rejects an un-notarized bundle as "damaged" on macOS 26+ — so the
// launch guards require BOTH `codesign --verify` (codesignVerifies) and
// Gatekeeper acceptance (gatekeeperAssesses). This pins the reason both are
// checked: an ad-hoc / un-notarized bundle passes codesign but fails Gatekeeper,
// and must be refused, never re-signed. Real codesign/spctl (no mocking) → macOS.
const darwinOnly = process.platform === 'darwin' ? describe : describe.skip;
darwinOnly('menubar launch guard requires notarization (real codesign/spctl)', () => {
  function makeAdHocBundle(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-sig-'));
    const app = path.join(dir, 'MenubarHelper.app');
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    // A real Mach-O so codesign has something to sign; /bin/echo is stable.
    // Read the basename from the shipped constant, never a literal: RUSH-3101
    // renamed it and this fixture's hardcoded copy silently went stale.
    fs.copyFileSync('/bin/echo', path.join(app, 'Contents', 'MacOS', MENUBAR_HELPER_EXECUTABLE_NAME));
    // The real bundle declares CFBundleExecutable (menubar/scripts/build.sh:122).
    // Without an Info.plist codesign INFERS the main executable from the bundle
    // name -- MenubarHelper.app -> Contents/MacOS/MenubarHelper -- which stopped
    // existing at the rename, so codesign rejected the whole bundle with
    // "bundle format unrecognized, invalid, or unsuitable" and this fixture
    // handed the assertions an UNSIGNED bundle. Declare it like the real build.
    fs.writeFileSync(
      path.join(app, 'Contents', 'Info.plist'),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '    <key>CFBundleExecutable</key>',
        `    <string>${MENUBAR_HELPER_EXECUTABLE_NAME}</string>`,
        '    <key>CFBundleIdentifier</key>',
        '    <string>com.phnx-labs.agents-menubar</string>',
        '    <key>CFBundlePackageType</key>',
        '    <string>APPL</string>',
        '</dict>',
        '</plist>',
        '',
      ].join('\n'),
    );
    // Ad-hoc sign it: the signature is valid, but it is NOT notarized — the exact
    // state a non-Developer-ID / un-notarized cut leaves the bundle in.
    const signed = spawnSync(
      'codesign',
      ['--force', '--sign', '-', '--identifier', 'com.phnx-labs.agents-menubar', app],
      { encoding: 'utf8' },
    );
    // Fail loud. The previous `stdio: 'ignore'` swallowed the packaging error and
    // turned it into a confusing "expected false to be true" three lines later.
    if (signed.status !== 0) {
      throw new Error(`ad-hoc codesign failed (status ${signed.status}): ${(signed.stderr || '').trim()}`);
    }
    return app;
  }

  it('an ad-hoc-signed (un-notarized) bundle passes codesign but FAILS Gatekeeper', () => {
    const app = makeAdHocBundle();
    // Signature is valid on its own...
    expect(codesignVerifies(app)).toBe(true);
    // ...but Gatekeeper rejects it because it is not notarized. The guard's AND
    // of the two is therefore false, so the helper is refused, not launched.
    expect(gatekeeperAssesses(app)).toBe(false);
    fs.rmSync(path.dirname(app), { recursive: true, force: true });
  });

  it('hasDeveloperIdSignature is false for an ad-hoc bundle', () => {
    const app = makeAdHocBundle();
    expect(hasDeveloperIdSignature(app)).toBe(false);
    fs.rmSync(path.dirname(app), { recursive: true, force: true });
  });
});

// RUSH-2968: launchctl is per-user-session and HOME-independent. A process under a
// redirected HOME still registers jobs in the REAL launchd, even when the label is
// namespaced. The registration abstraction must refuse the call and state why.
darwinOnly('service-manager registration gating (RUSH-2968)', () => {
  it('never invokes launchctl under a redirected HOME', () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec = (cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args: args as string[] });
      return Buffer.alloc(0);
    };

    const warnings: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any, ...rest: any[]) => {
      warnings.push(String(chunk));
      return (realWrite as any)(chunk, ...rest);
    }) as typeof process.stderr.write;

    try {
      restartMenubarLaunchAgent(501, '/tmp/com.phnx-labs.agents-menubar.plist', exec);
    } finally {
      process.stderr.write = realWrite;
    }

    expect(calls).toHaveLength(0);
    expect(warnings.join('')).toMatch(/refusing service-manager registration under redirected HOME/);
  });
});

// Regression guard for the ORPHAN-STORM incident. The helper can crash at
// startup on a loaded machine — `NSApplication.shared` segfaults inside
// `SLSNewConnection` when WindowServer is too starved to hand out a connection.
// With `KeepAlive` and no `ThrottleInterval`, launchd relaunched on its ~10s
// default and every attempt spawned another `agents doctor --json` before dying,
// so a starved box got hit harder the worse it got: 38 orphaned doctors, ~13 of
// 18 cores, load average 490. The throttle paces the respawn; ChildProcess.swift
// bounds and reaps the children.
describe('generateServicePlist — launchd crash-loop throttle', () => {
  const plist = generateServicePlist('/Users/x/Library/Application Support/agents-cli/MenubarHelper.app/Contents/MacOS/AGI Menu');

  it('sets a ThrottleInterval so a startup crash-loop cannot respawn every 10s', () => {
    expect(plist).toContain('<key>ThrottleInterval</key>');
    const seconds = Number(/<key>ThrottleInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist)?.[1]);
    expect(seconds).toBeGreaterThanOrEqual(30);
  });

  it('still keeps the helper alive and starts it at load', () => {
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>RunAtLoad</key>');
  });

  // `plutil` is macOS-only and the CI test shards run on Linux, where spawnSync
  // returns status null (ENOENT) rather than a non-zero exit — so gate on the
  // tool actually being present instead of asserting against a missing binary.
  const hasPlutil = spawnSync('plutil', ['-help'], { encoding: 'utf8' }).error === undefined;

  it.skipIf(!hasPlutil)('emits a plist that plutil accepts', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-plist-')), 'x.plist');
    fs.writeFileSync(file, plist);
    expect(spawnSync('plutil', ['-lint', file], { encoding: 'utf8' }).status).toBe(0);
  });

  // Runs everywhere, so the structural contract is still pinned on Linux CI:
  // a plist launchd will reject is a helper that never starts.
  it('is well-formed XML with a single top-level dict', () => {
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(plist).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
    expect(plist.match(/<dict>/g)?.length).toBe(plist.match(/<\/dict>/g)?.length);
    expect(plist.trimEnd().endsWith('</plist>')).toBe(true);
  });
});

// Regression guard for the STALE-PROCESS bug (RUSH-3019): the upgrade self-heal
// swapped the on-disk bundle but never restarted the running helper, so it kept
// requesting Accessibility under the OLD code identity and the grant never
// stuck. `menubarHealReplacedBundle` is the pure gate that decides when a heal
// changed content a live process could be stale against, as opposed to a
// plist-only repoint (RUSH-3005's churn, not this bug's).
describe('menubarHealReplacedBundle', () => {
  it('is true on a version-bump stale heal', () => {
    expect(menubarHealReplacedBundle({ stale: true, needsDevIdHeal: false })).toBe(true);
  });

  it('is true on the ad-hoc -> Developer ID transition', () => {
    expect(menubarHealReplacedBundle({ stale: false, needsDevIdHeal: true })).toBe(true);
  });

  it('is true when both fire together', () => {
    expect(menubarHealReplacedBundle({ stale: true, needsDevIdHeal: true })).toBe(true);
  });

  it('is false for a plist-only repoint — same version, same identity', () => {
    // This is exactly the mixed-Node-interpreter case RUSH-3005 already owns;
    // restarting the helper here too would double that churn.
    expect(menubarHealReplacedBundle({ stale: false, needsDevIdHeal: false })).toBe(false);
  });
});

describe('restartMenubarHelperAfterSwap', () => {
  const OWN = [{ pid: 74027, executable: '/x/AGI Menu' }];

  it('kickstarts -k the launchd job and does not fall back when it succeeds', () => {
    const savedAllow = process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME;
    process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME = '1';
    try {
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const exec = (cmd: string, args: readonly string[]) => {
        calls.push({ cmd, args: args as string[] });
        return Buffer.alloc(0);
      };
      const killed: number[] = [];
      restartMenubarHelperAfterSwap(501, OWN, exec, (pid) => killed.push(pid));

      const target = `gui/501/${serviceLabel()}`;
      expect(calls).toEqual([{ cmd: 'launchctl', args: ['kickstart', '-k', target] }]);
      expect(killed).toEqual([]);
    } finally {
      if (savedAllow === undefined) delete process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME;
      else process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME = savedAllow;
    }
  });

  // The exact failure verified live: `launchctl kickstart -k` against the GUI
  // domain throws from a shell with no Aqua session ("Could not find service
  // ... in domain for user gui"). The fallback must end the confirmed-own pids
  // so launchd's KeepAlive relaunches from the swapped binary.
  it('falls back to ending the own pid(s) when kickstart -k fails', () => {
    const savedAllow = process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME;
    process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME = '1';
    try {
      const exec = () => { throw new Error('Could not find service ... in domain for user gui'); };
      const killed: number[] = [];
      restartMenubarHelperAfterSwap(501, OWN, exec, (pid) => killed.push(pid));
      expect(killed).toEqual([74027]);
    } finally {
      if (savedAllow === undefined) delete process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME;
      else process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME = savedAllow;
    }
  });

  it('never touches launchd or kills anything under a redirected HOME with no test seam', () => {
    const exec = vi.fn(() => Buffer.alloc(0));
    const kill = vi.fn();
    // No AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME set — the hermetic test
    // HOME (tests/setup.ts) must refuse registration, same as
    // restartMenubarLaunchAgent (RUSH-2968).
    restartMenubarHelperAfterSwap(501, OWN, exec, kill);
    expect(exec).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('ends nothing when no own process is confirmed running', () => {
    const savedAllow = process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME;
    process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME = '1';
    try {
      const exec = () => { throw new Error('no such service'); };
      const killed: number[] = [];
      restartMenubarHelperAfterSwap(501, [], exec, (pid) => killed.push(pid));
      expect(killed).toEqual([]);
    } finally {
      if (savedAllow === undefined) delete process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME;
      else process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME = savedAllow;
    }
  });
});

// Regression guard for the 11-stale-TCC-rows finding (RUSH-3019): a machine that
// moved from an ad-hoc signature to Developer ID (6fa36f73a) keeps a dead TCC
// grant recorded against the old identity forever unless something resets it.
// The reset must run exactly once per machine, never on a machine that was
// always Developer ID (nothing stale to clear there).
describe('shouldMigrateMenubarTcc', () => {
  it('migrates on a real ad-hoc -> Developer ID transition not yet migrated', () => {
    expect(shouldMigrateMenubarTcc({ needsDevIdHeal: true, alreadyMigrated: false })).toBe(true);
  });

  it('never re-runs once already migrated', () => {
    expect(shouldMigrateMenubarTcc({ needsDevIdHeal: true, alreadyMigrated: true })).toBe(false);
  });

  it('never runs when there is no Dev-ID transition', () => {
    expect(shouldMigrateMenubarTcc({ needsDevIdHeal: false, alreadyMigrated: false })).toBe(false);
  });
});

describe('resetMenubarAccessibilityTcc', () => {
  // tests/setup.ts redirects HOME to a fork-private sandbox for the whole
  // suite, so installDir() already resolves under it — no extra sandboxing
  // needed, and the injected exec means the real `tccutil` binary is never
  // invoked here.
  it('resets Accessibility under the bundle identifier and stamps the marker', () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec = (cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args: args as string[] });
      return Buffer.alloc(0);
    };
    resetMenubarAccessibilityTcc(exec);
    expect(calls).toEqual([{ cmd: 'tccutil', args: ['reset', 'Accessibility', 'com.phnx-labs.agents-menubar'] }]);
    const marker = path.join(os.homedir(), 'Library', 'Application Support', 'agents-cli', '.menubar-tcc-migrated');
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker, { force: true });
  });

  it('still stamps the marker when tccutil fails — a missing binary must not block the heal', () => {
    const exec = () => { throw new Error('tccutil: command not found'); };
    resetMenubarAccessibilityTcc(exec);
    const marker = path.join(os.homedir(), 'Library', 'Application Support', 'agents-cli', '.menubar-tcc-migrated');
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker, { force: true });
  });
});

// Regression guard for the stale-process diagnostic behind `agents menubar
// doctor`: a live pid that started before the installed bundle's last write is
// still running the binary an update swapped out from under it.
describe('isMenubarProcessStaleAgainstBundle', () => {
  it('is stale when the pid started before the bundle was last written', () => {
    expect(isMenubarProcessStaleAgainstBundle(1_000, 2_000)).toBe(true);
  });

  it('is not stale when the pid started after the bundle was last written', () => {
    expect(isMenubarProcessStaleAgainstBundle(2_000, 1_000)).toBe(false);
  });

  it('is not stale on an exact tie', () => {
    expect(isMenubarProcessStaleAgainstBundle(1_000, 1_000)).toBe(false);
  });

  // The false positive that made `doctor` demand a re-grant after every healthy
  // upgrade. `ps -o lstart` reports whole seconds, the bundle mtime does not, and
  // the post-swap restart lands inside the swap's own second — so the two
  // timestamps below are the SAME second, 700ms apart. Real values read off zion
  // at 1.22.46, where the helper had already restarted onto the new binary.
  it('is not stale when the pid started in the same second the bundle was written', () => {
    expect(isMenubarProcessStaleAgainstBundle(1_787_441_353_000, 1_787_441_353_700)).toBe(false);
  });

  it('is still stale when the pid predates the bundle by a full second', () => {
    expect(isMenubarProcessStaleAgainstBundle(1_787_441_352_000, 1_787_441_353_700)).toBe(true);
  });
});

/**
 * Drives `installMenubarLaunchAgentOnUpgrade` for real — the function the
 * #2109 storm lived in, and which had no test that executed it at all.
 *
 * Honest scope. Two things make a full convergence drive unreachable rather
 * than merely awkward, and both are properties of the code, not the harness:
 *  - `sourceAppPath()` resolves candidates relative to the MODULE's own
 *    location, so a fake source cannot be planted via HOME; planting one would
 *    mean writing into the source tree.
 *  - the install path refuses any bundle that fails `codesign` + `spctl`, so a
 *    synthetic bundle can never reach `installAndStartService`, and a real
 *    Developer-ID-signed one is not available in CI.
 *
 * What this ACTUALLY verifies, stated narrowly because the first version of
 * this comment claimed more than the assertions did: on a checkout where
 * `sourceAppPath()` finds no bundle the function returns at its first guard, so
 * what is pinned is that it completes without throwing, twice, and registers
 * nothing with the real service manager under a sandbox HOME. The stamp-marker
 * path is asserted below rather than merely claimed here.
 *
 * It does NOT exercise install, verification, or the stamp-on-heal rule — those
 * need a signed bundle. The regression class itself is closed structurally (one
 * resolved `src`, used for both install and stamp) rather than by this test.
 */
describe('installMenubarLaunchAgentOnUpgrade (driven, sandboxed)', () => {
  const savedHome = process.env.HOME;
  const savedRealHome = process.env.AGENTS_REAL_HOME;

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedRealHome === undefined) delete process.env.AGENTS_REAL_HOME; else process.env.AGENTS_REAL_HOME = savedRealHome;
  });

  it('is a safe no-op under a sandbox HOME, and never registers a service', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-menubar-home-'));
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    process.env.HOME = home;
    process.env.AGENTS_REAL_HOME = home;
    try {
      // The seam is deliberately NOT set, so registration is refused — this
      // asserts the guard rather than opting out of it.
      expect(serviceManagerRegistrationAllowed().allowed).toBe(false);

      // Twice: a storm is non-convergence, so one call proving nothing is the
      // point of running it again.
      expect(() => installMenubarLaunchAgentOnUpgrade()).not.toThrow();
      expect(() => installMenubarLaunchAgentOnUpgrade()).not.toThrow();

      // Nothing was registered and nothing was stamped under the sandbox HOME.
      const launchAgents = path.join(home, 'Library', 'LaunchAgents');
      const plists = fs.existsSync(launchAgents) ? fs.readdirSync(launchAgents) : [];
      expect(plists.filter((f) => f.includes('menubar'))).toEqual([]);
      // And no stamp. Reviewer-found: this checked `<HOME>/.agents/`, which is
      // not where the stamp goes at all — `installedVersionMarkerPath()` writes
      // `<HOME>/Library/Application Support/agents-cli/.menubar-version`. The
      // assertion passed because nothing is stamped here either way, i.e. for
      // the wrong reason. Point it at the real path.
      const marker = path.join(home, 'Library', 'Application Support', 'agents-cli', '.menubar-version');
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// The npm tarball ships no helper bundle (PHNX-4036), so on an `npm i -g` Mac the
// floor release's download cache is the ONLY source the network-free startup
// self-heal can install from. These pin the two halves of that path: the cached
// bundle must classify as the floor RELEASE (never `local`, which would flip the
// stamp kind and reinstall forever — #2109), and the background worker must fetch
// exactly when a fetch changes something.
describe('release-path self-heal source (cached floor bundle)', () => {
  it('the cached floor bundle stamps as the floor release, not a local build', () => {
    const cached = cachedFloorBundlePath();
    const floor = helperFloor('menubar');
    expect(cached).toBe(path.join(menubarHelperCacheDir(floor), 'MenubarHelper.app'));
    expect(releaseVersionOfCachedBundle(cached)).toBe(floor);
    expect(stampFor(cached)).toEqual({ source: 'release', helperVersion: floor });
  });
});

describe('menubarHelperPrefetchNeeded', () => {
  const base = { darwin: true, disabledByUser: false, hasSource: false, serviceInstalled: true, stale: true };

  it('fetches when an installed helper is behind the floor and nothing else can be a source', () => {
    expect(menubarHelperPrefetchNeeded(base)).toBe(true);
  });
  it('fetches for a fresh machine with no service yet (the auto-enable the bootstrap promises)', () => {
    expect(menubarHelperPrefetchNeeded({ ...base, serviceInstalled: false, stale: false })).toBe(true);
  });
  it('does nothing when the installed helper already matches the floor', () => {
    expect(menubarHelperPrefetchNeeded({ ...base, stale: false })).toBe(false);
  });
  it('does nothing when a bundle already resolves — shipped with the build or already cached', () => {
    expect(menubarHelperPrefetchNeeded({ ...base, hasSource: true })).toBe(false);
  });
  it('respects `agents menubar disable`', () => {
    expect(menubarHelperPrefetchNeeded({ ...base, disabledByUser: true })).toBe(false);
  });
  it('never runs off macOS', () => {
    expect(menubarHelperPrefetchNeeded({ ...base, darwin: false })).toBe(false);
  });
});
