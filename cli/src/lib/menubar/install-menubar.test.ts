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
  cachedReleaseBundlePath,
  menubarUpdateSkipReason,
  menubarUpdateOutcome,
  menubarHelperPrefetchNeeded,
  stampVersionLabel,
  LOCAL_BUILD_LABEL,
  releaseVersionOfCachedBundle,
  stampFor,
  isMenubarProcessStaleAgainstBundle,
  menubarHealReplacedBundle,
  menubarPlistNeedsRepoint,
  mayInstallMenubarHelper,
  menubarGateVersion,
  MENUBAR_HELPER_EXECUTABLE_NAME,
  processesToEnd,
  resetMenubarAccessibilityTcc,
  restartMenubarHelperAfterSwap,
  restartMenubarLaunchAgent,
  serviceLabel,
  shouldMigrateMenubarTcc,
} from './install-menubar.js';

describe('classifyMenubarProcesses', () => {
  const INSTALLED =
    '/Users/muqsit/Library/Application Support/agents-cli/MenubarHelper.app/Contents/MacOS/AGI Menu';
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

  it('does not count a --notify one-shot as a second copy', () => {
    const comm = `43244 ${INSTALLED}\n91002 ${INSTALLED}`;
    const command = `43244 ${INSTALLED}\n91002 ${INSTALLED} --notify --title Done`;
    const r = classifyMenubarProcesses(comm, command, INSTALLED);
    expect(r.own.map((p) => p.pid)).toEqual([43244]);
  });

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
    expect(isMenubarStale({ installed: REL('1.1.0'), available: REL('1.0.0'), execExists: true })).toBe(false);
  });

  it('is NOT stale when the helper version matches and the binary is present', () => {
    expect(isMenubarStale({ installed: REL('1.0.0'), available: REL('1.0.0'), execExists: true })).toBe(false);
  });

  it('is stale on a pre-stamp install (no marker yet)', () => {
    expect(isMenubarStale({ installed: null, available: REL('1.0.0'), execExists: true })).toBe(true);
  });

  it('is stale exactly once on a legacy bare-string stamp, then re-stamped', () => {
    expect(isMenubarStale({ installed: { source: 'legacy', raw: '1.22.49' }, available: REL('1.0.0'), execExists: true })).toBe(true);
  });

  it('is stale when the install KIND changes (local <-> release)', () => {
    expect(isMenubarStale({ installed: LOC('/src/MenubarHelper.app@111'), available: REL('1.0.0'), execExists: true })).toBe(true);
    expect(isMenubarStale({ installed: REL('1.0.0'), available: LOC('/src/MenubarHelper.app@111'), execExists: true })).toBe(true);
  });

  it('tracks a local build by source path + mtime, since it carries no version', () => {
    expect(isMenubarStale({ installed: LOC('/src/MenubarHelper.app@111'), available: LOC('/src/MenubarHelper.app@111'), execExists: true })).toBe(false);
    expect(isMenubarStale({ installed: LOC('/src/MenubarHelper.app@111'), available: LOC('/src/MenubarHelper.app@222'), execExists: true })).toBe(true);
  });

  it('stamps from the SAME resolved source the installer uses', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'install-menubar.ts'),
      'utf-8',
    );
    const start = src.indexOf('function startMenubarServiceFromSource');
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, src.indexOf('\nfunction ', start + 10));
    expect(fn.length).toBeGreaterThan(200);
    expect(fn).toContain('const src = opts.sourceAppPath ?? sourceAppPath()');
    expect(fn).toContain('sourceAppPath: src');
    expect(fn).toContain('stampFor(src)');
    expect(fn).not.toContain('stampFor(opts.sourceAppPath)');
  });

  it('classifies a release only when the bundle is really in its cache dir', () => {
    const cacheFor = (v: string) => `/cache/menubar/mac-helper/v${v}`;
    expect(releaseVersionOfCachedBundle('/cache/menubar/mac-helper/v1.0.1/MenubarHelper.app', cacheFor)).toBe('1.0.1');
    expect(releaseVersionOfCachedBundle('/Users/me/src/v1.0.1/menubar/MenubarHelper.app', cacheFor)).toBeNull();
    expect(releaseVersionOfCachedBundle('/Users/me/src/agents-cli/cli/menubar/MenubarHelper.app', cacheFor)).toBeNull();
  });

  it('stampFor uses the real cache dir, not a path pattern', () => {
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-converge-'));
    const local = path.join(dir, 'MenubarHelper.app');
    fs.mkdirSync(local);
    try {
      for (const source of [local, path.join(menubarHelperCacheDir('1.0.1'), 'MenubarHelper.app')]) {
        const written = stampFor(source);
        const computed = stampFor(source);
        expect(isMenubarStale({ installed: written, available: computed, execExists: true })).toBe(false);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds the cache match even when an earlier path segment looks like a version', () => {
    const cacheFor = (v: string) => `/Users/me/.nvm/versions/node/v24.15.0/cache/menubar/mac-helper/v${v}`;
    expect(releaseVersionOfCachedBundle(`${cacheFor('1.0.1')}/MenubarHelper.app`, cacheFor)).toBe('1.0.1');
  });

  it('does not let a local build win or lose a version contest', () => {
    const base = {
      ownerEntryExists: true,
      sourceIsDeveloperId: true,
      plistEntry: '/a',
      activeEntry: '/b',
      helperExecMissing: false,
      needsDevIdHeal: false,
      msSinceLastHeal: 0,
      cooldownMs: 3_600_000,
    };
    expect(mayInstallMenubarHelper({ ...base, installedVersion: '1.0.0', currentVersion: LOCAL_BUILD_LABEL })).toBe(false);
    expect(mayInstallMenubarHelper({ ...base, installedVersion: LOCAL_BUILD_LABEL, currentVersion: '1.0.0' })).toBe(false);
  });

  it('a local rebuild is a real change, not two equal `local` labels', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-rebuild-'));
    const app = path.join(dir, 'MenubarHelper.app');
    fs.mkdirSync(app);
    try {
      const before = stampFor(app);
      fs.utimesSync(app, new Date(), new Date(Date.now() + 60_000));
      const after = stampFor(app);

      expect(stampVersionLabel(before)).toBe(stampVersionLabel(after));
      expect(JSON.stringify(before)).not.toBe(JSON.stringify(after));
      expect(isMenubarStale({ installed: before, available: after, execExists: true })).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the setup bundle step compares stamps, not the lossy label", () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'install-menubar.ts'),
      'utf-8',
    );
    const i = src.indexOf('const bundleUnchanged');
    expect(i).toBeGreaterThan(-1);
    const around = src.slice(i, src.indexOf("step('bundle'", i) + 200);
    expect(around).toContain('isMenubarStale({');
    expect(around).toContain('available: availableStamp()');
    expect(around).not.toMatch(/bundleUnchanged[\s\S]{0,120}stampVersionLabel\(bundleStamp\) ===/);
    expect(around).not.toContain('=== getCliVersion()');
  });

  it('never compares against the CLI version', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'install-menubar.ts'),
      'utf-8',
    );
    const start = src.indexOf('export function isMenubarStale');
    const end = src.indexOf('function menubarSetupStale');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fn = src.slice(start, end);
    expect(fn.length).toBeGreaterThan(200);
    expect(fn).not.toContain('getCliVersion');
  });
});

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

describe('mayInstallMenubarHelper', () => {
  const brew = '/opt/homebrew/lib/node_modules/@phnx-labs/agents-cli/dist/index.js';
  const nvm = '/Users/me/.nvm/versions/node/v24.15.0/lib/node_modules/@phnx-labs/agents-cli/dist/index.js';
  const HOUR = 60 * 60 * 1000;
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
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: brew, activeEntry: nvm, ownerEntryExists: true,
    })).toBe(false);
  });

  it('allows the owner to reinstall — a same-install upgrade still lands', () => {
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
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: brew, activeEntry: nvm, ownerEntryExists: true,
      helperExecMissing: true,
      installedVersion: '1.22.25', currentVersion: '1.22.5',
    })).toBe(true);
  });

  it('never blocks a repair: the Developer-ID heal runs from any install', () => {
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: brew, activeEntry: nvm, ownerEntryExists: true,
      needsDevIdHeal: true,
      installedVersion: '1.22.25', currentVersion: '1.22.5',
    })).toBe(true);
  });

  it('never lets an ad-hoc/dev build seize a healthy helper on the timer', () => {
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: brew, activeEntry: nvm, ownerEntryExists: true,
      msSinceLastHeal: HOUR + 1, sourceIsDeveloperId: false,
    })).toBe(false);
  });

  it('refuses an ad-hoc build seizing a HEALTHY helper whose owner-entry is gone', () => {
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: brew, activeEntry: nvm, ownerEntryExists: false,
      sourceIsDeveloperId: false,
    })).toBe(false);
  });

  it('still lets an ad-hoc build repair a BROKEN helper whose owner is gone (no deadlock)', () => {
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: brew, activeEntry: nvm, ownerEntryExists: false,
      sourceIsDeveloperId: false, helperExecMissing: true,
    })).toBe(true);
  });

  it('still lets a Developer-ID build adopt a healthy helper whose owner-entry is gone', () => {
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
    expect(mayInstallMenubarHelper({
      ...base, plistEntry: brew, activeEntry: null, ownerEntryExists: true,
    })).toBe(false);
  });
});

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

const darwinOnly = process.platform === 'darwin' ? describe : describe.skip;
darwinOnly('menubar launch guard requires notarization (real codesign/spctl)', () => {
  function makeAdHocBundle(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-sig-'));
    const app = path.join(dir, 'MenubarHelper.app');
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    fs.copyFileSync('/bin/echo', path.join(app, 'Contents', 'MacOS', MENUBAR_HELPER_EXECUTABLE_NAME));
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
    const signed = spawnSync(
      'codesign',
      ['--force', '--sign', '-', '--identifier', 'com.phnx-labs.agents-menubar', app],
      { encoding: 'utf8' },
    );
    if (signed.status !== 0) {
      throw new Error(`ad-hoc codesign failed (status ${signed.status}): ${(signed.stderr || '').trim()}`);
    }
    return app;
  }

  it('an ad-hoc-signed (un-notarized) bundle passes codesign but FAILS Gatekeeper', () => {
    const app = makeAdHocBundle();
    expect(codesignVerifies(app)).toBe(true);
    expect(gatekeeperAssesses(app)).toBe(false);
    fs.rmSync(path.dirname(app), { recursive: true, force: true });
  });

  it('hasDeveloperIdSignature is false for an ad-hoc bundle', () => {
    const app = makeAdHocBundle();
    expect(hasDeveloperIdSignature(app)).toBe(false);
    fs.rmSync(path.dirname(app), { recursive: true, force: true });
  });
});

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

  const hasPlutil = spawnSync('plutil', ['-help'], { encoding: 'utf8' }).error === undefined;

  it.skipIf(!hasPlutil)('emits a plist that plutil accepts', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-plist-')), 'x.plist');
    fs.writeFileSync(file, plist);
    expect(spawnSync('plutil', ['-lint', file], { encoding: 'utf8' }).status).toBe(0);
  });

  it('is well-formed XML with a single top-level dict', () => {
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(plist).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
    expect(plist.match(/<dict>/g)?.length).toBe(plist.match(/<\/dict>/g)?.length);
    expect(plist.trimEnd().endsWith('</plist>')).toBe(true);
  });
});

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

  it('is not stale when the pid started in the same second the bundle was written', () => {
    expect(isMenubarProcessStaleAgainstBundle(1_787_441_353_000, 1_787_441_353_700)).toBe(false);
  });

  it('is still stale when the pid predates the bundle by a full second', () => {
    expect(isMenubarProcessStaleAgainstBundle(1_787_441_352_000, 1_787_441_353_700)).toBe(true);
  });
});

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
      expect(serviceManagerRegistrationAllowed().allowed).toBe(false);

      expect(() => installMenubarLaunchAgentOnUpgrade()).not.toThrow();
      expect(() => installMenubarLaunchAgentOnUpgrade()).not.toThrow();

      const launchAgents = path.join(home, 'Library', 'LaunchAgents');
      const plists = fs.existsSync(launchAgents) ? fs.readdirSync(launchAgents) : [];
      expect(plists.filter((f) => f.includes('menubar'))).toEqual([]);
      const marker = path.join(home, 'Library', 'Application Support', 'agents-cli', '.menubar-version');
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

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

describe('auto-update decision (menubarUpdateSkipReason / menubarUpdateOutcome)', () => {
  const release = { source: 'release' as const, helperVersion: '1.2.3' };
  const base = { darwin: true, disabledByUser: false, serviceInstalled: true, shipped: false, installed: release };

  it('proceeds for an installed release helper with no shipped bundle', () => {
    expect(menubarUpdateSkipReason(base)).toBeNull();
  });

  it('a downloaded release cache is NOT a shipped bundle: the pass still proceeds', () => {
    expect(menubarUpdateSkipReason({ ...base, shipped: false })).toBeNull();
  });

  it('skips: not darwin, opted out, not installed, shipped bundle, local or legacy or missing stamp', () => {
    expect(menubarUpdateSkipReason({ ...base, darwin: false })).toMatch(/macOS/);
    expect(menubarUpdateSkipReason({ ...base, disabledByUser: true })).toMatch(/disabled/);
    expect(menubarUpdateSkipReason({ ...base, serviceInstalled: false })).toMatch(/not installed/);
    expect(menubarUpdateSkipReason({ ...base, shipped: true })).toMatch(/ships its own/);
    expect(menubarUpdateSkipReason({ ...base, installed: { source: 'local', sourceStamp: 'x@1' } })).toMatch(/local, not a release/);
    expect(menubarUpdateSkipReason({ ...base, installed: { source: 'legacy', raw: '1.22.0' } })).toMatch(/not a release/);
    expect(menubarUpdateSkipReason({ ...base, installed: null })).toMatch(/unstamped/);
  });

  it('updates only when the available build is strictly newer', () => {
    expect(menubarUpdateOutcome('1.2.3', '1.3.0')).toBe('updated');
    expect(menubarUpdateOutcome('1.3.0', '1.3.0')).toBe('current');
    expect(menubarUpdateOutcome('1.3.0', '1.2.3')).toBe('current');
  });
});

describe('cachedReleaseBundlePath', () => {
  it('is the floor cache until a newer version has been resolved', () => {
    expect(cachedReleaseBundlePath()).toBe(cachedFloorBundlePath());
  });
});

describe('menubarGateVersion (R5: helpers auto-update)', () => {
  it('judges the downloaded release, not the cached one', () => {
    const downloaded = path.join(menubarHelperCacheDir('1.15.0'), 'MenubarHelper.app');
    expect(menubarGateVersion(downloaded, () => '1.14.13')).toBe('1.15.0');
  });

  it('falls back to the cached source when no bundle is given', () => {
    expect(menubarGateVersion(null, () => '1.14.13')).toBe('1.14.13');
  });
});
