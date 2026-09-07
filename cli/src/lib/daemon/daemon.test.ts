/**
 * Daemon service-manifest generation.
 *
 * The load-bearing security contract under test: the service manifest (launchd
 * plist / systemd unit) NEVER embeds a Claude OAuth token — even when one is
 * configured in the `claude` secrets bundle. The daemon holds no Claude
 * credential of its own; routine runs authenticate through the per-account
 * CLAUDE_CONFIG_DIR login on the device. The bundle is seeded through the real
 * standalone `secrets` engine (PHNX-3989) in a fresh, isolated store
 * (`installKeychainHermeticity`) so a token can be configured and the
 * generators proven to omit it.
 *
 * RUSH-2819: this is the residual slice of the original daemon.test.ts (2201
 * lines / 88 tests / ~112s in CI) — the manifest/plist/systemd/launch-shape
 * tests, which are fast (no real process spawns). The heavier integration
 * suites live in the sibling daemon.lifecycle.test.ts, daemon.stop.test.ts, and
 * daemon.registry.test.ts; shared helpers are in daemon.test-fixture.ts. Kept
 * as `daemon.test.ts` because CI's companion-test selection maps
 * lib/daemon/daemon.ts -> daemon.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  generateLaunchdPlist,
  generateSystemdUnit,
  getDaemonLaunch,
  getAgentsInvocation,
  getAgentsBinPath,
  startDaemon,
  writeOwnerOnlyServiceManifest,
  isolatedHomeSuffix,
  daemonServiceLabel,
  daemonSystemdUnitName,
} from './daemon.js';
import { secretsKeychainItem, writeBundleWithItemsSync } from '../secrets-client.js';
import type { SecretsBundle } from '../secrets-types.js';
import { DIST_ENTRY, installKeychainHermeticity } from './daemon.test-fixture.js';

const systemdQuote = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Seed the `claude` bundle with a keychain-backed CLAUDE_CODE_OAUTH_TOKEN. */
function seedKeychainBacked(value: string): void {
  const bundle: SecretsBundle = { name: 'claude', vars: { CLAUDE_CODE_OAUTH_TOKEN: 'keychain:CLAUDE_CODE_OAUTH_TOKEN' } };
  writeBundleWithItemsSync(bundle, new Map([[secretsKeychainItem('claude', 'CLAUDE_CODE_OAUTH_TOKEN'), value]]));
}

installKeychainHermeticity();

describe('writeOwnerOnlyServiceManifest', () => {
  it('creates the file with mode 0600 immediately (no world-readable TOCTOU window)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-daemon-manifest-'));
    const manifestPath = path.join(tmpDir, 'com.agents.daemon.plist');
    writeOwnerOnlyServiceManifest(manifestPath, generateLaunchdPlist());
    expect(fs.existsSync(manifestPath)).toBe(true);
    // NTFS has no POSIX mode bits — the 0o600 lockdown is a no-op on Windows.
    if (process.platform !== 'win32') {
      expect(fs.statSync(manifestPath).mode & 0o777).toBe(0o600);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('re-locks a pre-existing world-readable manifest to 0600 on overwrite', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-daemon-manifest-'));
    const manifestPath = path.join(tmpDir, 'com.agents.daemon.plist');
    // Simulate a stale manifest left world-readable by an older install.
    fs.writeFileSync(manifestPath, 'stale', { mode: 0o644 });
    if (process.platform !== 'win32') {
      fs.chmodSync(manifestPath, 0o644);
      expect(fs.statSync(manifestPath).mode & 0o777).toBe(0o644);
    }
    writeOwnerOnlyServiceManifest(manifestPath, generateLaunchdPlist());
    expect(fs.readFileSync(manifestPath, 'utf-8')).not.toBe('stale');
    // writeFileSync's mode is a no-op when overwriting an existing file, so the
    // unlink-before-create is what forces this back to 0600.
    if (process.platform !== 'win32') {
      expect(fs.statSync(manifestPath).mode & 0o777).toBe(0o600);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('generateLaunchdPlist', () => {
  it('never embeds CLAUDE_CODE_OAUTH_TOKEN, only PATH', () => {
    const plist = generateLaunchdPlist();
    expect(plist).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    // The PATH entry is always present so EnvironmentVariables is never empty.
    expect(plist).toContain('<key>PATH</key>');
    // PATH pins the agents shim dir first so routines resolve the same binary
    // (RUSH-2431), and drops the stale hardcoded nvm version that bricked the
    // daemon fleet-wide when it was pruned.
    expect(plist).toContain(`<string>${path.dirname(getAgentsBinPath())}:`);
    expect(plist).not.toContain('v24.0.0');
  });

  it('omits the token even when one is configured in the claude bundle', () => {
    seedKeychainBacked('sk-ant-oat01-abc123');
    const plist = generateLaunchdPlist();
    expect(plist).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(plist).not.toContain('sk-ant-oat01-abc123');
  });
});

// RUSH-2639 (reopened from the 1.22.40 macOS release CI legs): launchd does
// NOT inherit `launchctl load`'s caller's process environment, so a plist
// whose EnvironmentVariables dict carries only PATH lets a launchd-started
// daemon resolve HOME against the login session's real value regardless of
// what HOME the process that generated (and loaded) the plist was running
// under. Under the hermetic test harness (tests/setup.ts redirects HOME to a
// fork-private sandbox) that meant a launchd-started daemon silently escaped
// the sandbox and bootstrapped a real ~/.agents on the CI runner — see
// tests/setup.ts:222's hermeticity tripwire, which caught exactly this:
// "Before: null. After: .cache:...|.history:...|.system:...|routines:...".
describe('generateLaunchdPlist / generateSystemdUnit — HOME seam (RUSH-2639)', () => {
  let prevHome: string | undefined;
  let prevRealHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevRealHome = process.env.AGENTS_REAL_HOME;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevRealHome === undefined) delete process.env.AGENTS_REAL_HOME; else process.env.AGENTS_REAL_HOME = prevRealHome;
  });

  it('bakes the CALLER\'s HOME into the plist EnvironmentVariables dict, not just PATH', () => {
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-2639-home-'));
    process.env.HOME = sandboxHome;
    delete process.env.AGENTS_REAL_HOME;
    try {
      const plist = generateLaunchdPlist();
      expect(plist).toMatch(new RegExp(`<key>HOME</key>\\s*<string>${sandboxHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`));
      // With AGENTS_REAL_HOME unset, it falls back to the same sandbox HOME —
      // never to os.homedir()'s un-redirected real value.
      expect(plist).toMatch(new RegExp(`<key>AGENTS_REAL_HOME</key>\\s*<string>${sandboxHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`));
    } finally {
      fs.rmSync(sandboxHome, { recursive: true, force: true });
    }
  });

  it('honors a distinct AGENTS_REAL_HOME rather than collapsing it into HOME', () => {
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-2639-home-'));
    const activeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-2639-real-'));
    process.env.HOME = sandboxHome;
    process.env.AGENTS_REAL_HOME = activeHome;
    try {
      const plist = generateLaunchdPlist();
      expect(plist).toContain(`<key>HOME</key>\n    <string>${sandboxHome}</string>`);
      expect(plist).toContain(`<key>AGENTS_REAL_HOME</key>\n    <string>${activeHome}</string>`);
    } finally {
      fs.rmSync(sandboxHome, { recursive: true, force: true });
      fs.rmSync(activeHome, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'bakes the CALLER\'s HOME into the systemd unit, not just PATH',
    () => {
      const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-2639-home-'));
      process.env.HOME = sandboxHome;
      delete process.env.AGENTS_REAL_HOME;
      try {
        const unit = generateSystemdUnit();
        expect(unit).toContain(`Environment=HOME=${sandboxHome}`);
        expect(unit).toContain(`Environment=AGENTS_REAL_HOME=${sandboxHome}`);
      } finally {
        fs.rmSync(sandboxHome, { recursive: true, force: true });
      }
    },
  );
});

// RUSH-2639 (residual): baking HOME into the plist/unit content (above) keeps
// a STARTED daemon inside its sandbox, but launchd/systemd route
// unload/load/list by the service identifier alone, never by file path — so
// every hermetic test instance and the real production install shared one
// literal label/unit name. `launchctl unload <this-instance's-own-plist>`
// silently kills whatever job the OS already has registered under that same
// label, confirmed directly against real launchctl with two throwaway plists
// sharing one label: the second job's own unload (which the code's comment
// calls "not loaded, expected") tore down the first, still alive under a
// different path. Namespace the identifier itself under a redirected HOME so
// two isolated instances (concurrent CI test forks, or a developer's suite
// racing their own always-on daemon) can never collide on it.
describe('daemonServiceLabel / daemonSystemdUnitName — isolated-HOME namespacing (RUSH-2639 residual)', () => {
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  });

  it('two different redirected HOMEs never produce the same launchd label or systemd unit name', () => {
    const sandboxA = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-2639-label-a-'));
    const sandboxB = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-2639-label-b-'));
    try {
      process.env.HOME = sandboxA;
      const labelA = daemonServiceLabel();
      const unitA = daemonSystemdUnitName();

      process.env.HOME = sandboxB;
      const labelB = daemonServiceLabel();
      const unitB = daemonSystemdUnitName();

      expect(labelA).not.toBe(labelB);
      expect(unitA).not.toBe(unitB);
    } finally {
      fs.rmSync(sandboxA, { recursive: true, force: true });
      fs.rmSync(sandboxB, { recursive: true, force: true });
    }
  });

  it('the same redirected HOME is deterministic — a retry never orphans the previous label', () => {
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-2639-label-stable-'));
    try {
      process.env.HOME = sandboxHome;
      expect(daemonServiceLabel()).toBe(daemonServiceLabel());
      expect(daemonSystemdUnitName()).toBe(daemonSystemdUnitName());
    } finally {
      fs.rmSync(sandboxHome, { recursive: true, force: true });
    }
  });

  it('a redirected HOME namespaces the label under the base production identifier, never replacing it', () => {
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-2639-label-prefix-'));
    try {
      process.env.HOME = sandboxHome;
      expect(daemonServiceLabel()).toMatch(/^com\.phnx-labs\.agents-daemon\.sandbox-[0-9a-f]{12}$/);
      expect(daemonSystemdUnitName()).toMatch(/^agents-daemon-sandbox-[0-9a-f]{12}\.service$/);
    } finally {
      fs.rmSync(sandboxHome, { recursive: true, force: true });
    }
  });

  it('generateLaunchdPlist embeds the namespaced label, not the bare production one', () => {
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-2639-label-plist-'));
    try {
      process.env.HOME = sandboxHome;
      const plist = generateLaunchdPlist();
      expect(plist).toContain(`<string>${daemonServiceLabel()}</string>`);
      expect(plist).not.toContain('<string>com.phnx-labs.agents-daemon</string>');
    } finally {
      fs.rmSync(sandboxHome, { recursive: true, force: true });
    }
  });

  it('a HOME matching the real account home (no redirection) is not namespaced', () => {
    const real = os.userInfo().homedir;
    process.env.HOME = real;
    expect(isolatedHomeSuffix()).toBeNull();
    expect(daemonServiceLabel()).toBe('com.phnx-labs.agents-daemon');
    expect(daemonSystemdUnitName()).toBe('agents-daemon.service');
  });
});

// RUSH-2639: reproduce the actual macOS CI leak end to end. launchd applies a
// plist's EnvironmentVariables dict on top of the login session's OWN
// environment — never the environment of whatever process called `launchctl
// load` — so a shim that (like every other shim in this file) simply execs the
// program with `env: {...process.env}` inherited is unrealistic here and would
// never have caught this bug: it silently hands the daemon child the CALLING
// test's sandboxed HOME regardless of what the plist says. This shim instead
// parses the real generated plist and applies ONLY its ProgramArguments /
// EnvironmentVariables against a deliberately foreign base env (no HOME at
// all) — the same shape launchd actually uses — so the assertion only passes
// when `generateLaunchdPlist()` itself carries HOME/AGENTS_REAL_HOME.
describe.skipIf(process.platform !== 'darwin')('startDaemon — launchd does not inherit the caller env (RUSH-2639)', () => {
  let tmpHome = '';
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join('/tmp', 'agd-2639-launchd-'));
    for (const k of ['HOME', 'PATH', 'AGENTS_DAEMON_DIR', 'AGENTS_REAL_HOME', 'AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME']) saved[k] = process.env[k];
    process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME = '1';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // RUSH-2968: the originating leak site. launchctl is per-user-session and
  // HOME-independent, so startDaemon under a redirected HOME must never touch
  // the real launchd — without the test seam it falls back to a detached
  // spawn, and the launchctl shim must record ZERO invocations.
  it('never invokes launchctl under a redirected HOME (falls back to detached)', () => {
    delete process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME;

    const daemonDir = path.join(tmpHome, 'daemon-2968');
    const shimDir = path.join(tmpHome, 'bin-2968');
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.mkdirSync(shimDir, { recursive: true });

    // Recording launchctl shim: ANY invocation writes the marker.
    const markerPath = path.join(tmpHome, 'launchctl-invoked');
    fs.writeFileSync(
      path.join(shimDir, 'launchctl'),
      `#!/bin/sh\necho "$@" >> "${markerPath}"\nexit 0\n`,
      { mode: 0o755 },
    );

    // Stand-in daemon child: records its pid then exits shortly.
    const childPath = path.join(tmpHome, 'fake-daemon-2968.mjs');
    fs.writeFileSync(childPath, [
      `import fs from 'fs';`,
      `fs.writeFileSync(process.env.AGD_PID_2968, String(process.pid));`,
      `setTimeout(() => {}, 1500);`,
    ].join('\n'), 'utf-8');

    const sandboxHome = path.join(tmpHome, 'sandbox-home-2968');
    fs.mkdirSync(sandboxHome, { recursive: true });
    process.env.HOME = sandboxHome;
    process.env.AGENTS_REAL_HOME = sandboxHome;
    process.env.AGENTS_DAEMON_DIR = daemonDir;
    process.env.PATH = `${shimDir}${path.delimiter}${saved.PATH ?? ''}`;
    process.env.AGD_PID_2968 = path.join(tmpHome, 'child-pid-2968');

    try {
      const res = startDaemon(childPath);
      expect(res.method).not.toBe('launchd');
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      delete process.env.AGD_PID_2968;
      // Reap the detached stand-in child if it recorded a pid.
      const pidFile = path.join(tmpHome, 'child-pid-2968');
      if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
        if (!isNaN(pid)) { try { process.kill(pid); } catch { /* already gone */ } }
      }
    }
  });

  it('a launchd-started daemon resolves the SANDBOX HOME baked into the plist, never the login session default', () => {
    const daemonDir = path.join(tmpHome, 'daemon');
    const shimDir = path.join(tmpHome, 'bin');
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.mkdirSync(shimDir, { recursive: true });

    const lockPath = path.join(daemonDir, 'daemon.lock');
    const pidPath = path.join(daemonDir, 'daemon.pid');
    const resultPath = path.join(tmpHome, 'observed-home.json');
    // The stand-in "daemon": records what HOME it was actually launched with,
    // then behaves exactly like the other launchd-shim test's child.
    const childPath = path.join(tmpHome, 'fake-daemon.mjs');
    fs.writeFileSync(childPath, [
      `import fs from 'fs';`,
      `setTimeout(() => {`,
      `  fs.writeFileSync(process.env.AGD_RESULT, JSON.stringify({ observedHome: process.env.HOME || null, observedRealHome: process.env.AGENTS_REAL_HOME || null }));`,
      `  fs.writeFileSync(process.env.AGD_PID, String(process.pid));`,
      `  setTimeout(() => {}, 3000);`,
      `}, 400);`,
    ].join('\n'), 'utf-8');

    // A minimal parser+launcher standing in for launchd: reads the REAL plist
    // `startDaemon()` wrote, pulls only its <key>EnvironmentVariables</key>
    // dict, and spawns the stand-in child with that dict as the WHOLE
    // environment plus a foreign base (no HOME) — never `process.env` of
    // whatever called `launchctl load`. This is what makes the test able to
    // fail: without the RUSH-2639 fix, EnvironmentVariables carries only PATH,
    // so the child would see no HOME at all instead of the sandbox HOME.
    const launcherPath = path.join(tmpHome, 'fake-launchd.mjs');
    fs.writeFileSync(launcherPath, [
      `import fs from 'fs';`,
      `import { spawn } from 'child_process';`,
      `const plistPath = process.argv[2];`,
      `const xml = fs.readFileSync(plistPath, 'utf-8');`,
      `const envSection = xml.match(/<key>EnvironmentVariables<\\/key>\\s*<dict>([\\s\\S]*?)<\\/dict>/)?.[1] || '';`,
      `const pairs = [...envSection.matchAll(/<key>([^<]+)<\\/key>\\s*<string>([^<]*)<\\/string>/g)];`,
      `const plistEnv = Object.fromEntries(pairs.map((m) => [m[1], m[2]]));`,
      // A "foreign login session" base — deliberately WITHOUT HOME, so the
      // only way the child ever sees the sandbox HOME is via the plist.
      `const loginSessionEnv = { PATH: '/usr/bin:/bin', AGD_RESULT: process.env.AGD_RESULT, AGD_PID: process.env.AGD_PID };`,
      `spawn(process.execPath, [process.env.AGD_CHILD], { env: { ...loginSessionEnv, ...plistEnv }, detached: true, stdio: 'ignore' }).unref();`,
    ].join('\n'), 'utf-8');

    const shim = [
      '#!/bin/sh',
      'for a in "$@"; do',
      '  if [ "$a" = "load" ]; then',
      `    "${process.execPath}" "${launcherPath}" "$2" >/dev/null 2>&1 &`,
      '  fi',
      'done',
      'exit 0',
    ].join('\n');
    const shimPath = path.join(shimDir, 'launchctl');
    fs.writeFileSync(shimPath, shim, 'utf-8');
    fs.chmodSync(shimPath, 0o755);

    const sandboxHome = path.join(tmpHome, 'sandbox-home');
    fs.mkdirSync(sandboxHome, { recursive: true });
    process.env.HOME = sandboxHome;
    process.env.AGENTS_REAL_HOME = sandboxHome;
    process.env.AGENTS_DAEMON_DIR = daemonDir;
    process.env.PATH = `${shimDir}${path.delimiter}${saved.PATH ?? ''}`;
    process.env.AGD_CHILD = childPath;
    process.env.AGD_LOCK = lockPath;
    process.env.AGD_PID = pidPath;
    process.env.AGD_RESULT = resultPath;

    try {
      const res = startDaemon(DIST_ENTRY);
      expect(res.method).toBe('launchd');
      expect(res.pid).toBeTruthy();

      const recorded = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
      expect(recorded.observedHome).toBe(sandboxHome);
      expect(recorded.observedRealHome).toBe(sandboxHome);
    } finally {
      for (const k of ['AGD_CHILD', 'AGD_LOCK', 'AGD_PID', 'AGD_RESULT']) delete process.env[k];
      const pid = fs.existsSync(pidPath) ? parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10) : NaN;
      if (!isNaN(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
  }, 30_000);
});

// RUSH-2418: crash-loop prevention had no application-level guarantee at all —
// only the OS supervisor's retry, uncapped. `KeepAlive` with no
// `ThrottleInterval` lets launchd relaunch on its ~10s default, so a daemon that
// dies while booting is restarted six times a minute forever. This is the same
// defect the menu-bar helper already fixed (`menubar/install-menubar.ts:308`,
// pinned by install-menubar.test.ts's "sets a ThrottleInterval so a startup
// crash-loop cannot respawn every 10s"), applied to the daemon's own plist.
describe('generateLaunchdPlist — crash-loop throttle (RUSH-2418)', () => {
  it('sets a ThrottleInterval so a startup crash-loop cannot respawn every 10s', () => {
    const plist = generateLaunchdPlist();
    expect(plist).toContain('<key>ThrottleInterval</key>');
    const seconds = Number(/<key>ThrottleInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist)?.[1]);
    expect(seconds).toBeGreaterThanOrEqual(30);
  });

  it('still keeps the daemon alive and starts it at load', () => {
    const plist = generateLaunchdPlist();
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>RunAtLoad</key>');
  });
});

// The systemd half of the same guarantee. `Restart=always` with no `StartLimit*`
// is an uncapped loop; the burst limit is what lets systemd give up and put the
// unit in `failed` instead of respawning a broken install forever.
describe.skipIf(process.platform === 'win32')('generateSystemdUnit — crash-loop limits (RUSH-2418)', () => {
  it('caps restarts with StartLimitIntervalSec/StartLimitBurst', () => {
    const unit = generateSystemdUnit();
    const interval = Number(/StartLimitIntervalSec=(\d+)/.exec(unit)?.[1]);
    const burst = Number(/StartLimitBurst=(\d+)/.exec(unit)?.[1]);
    expect(interval).toBeGreaterThan(0);
    expect(burst).toBeGreaterThan(0);
    // A cap only caps if the window is long enough to contain the bursts: burst
    // restarts paced by RestartSec must fit inside the interval, else the
    // counter resets before the limit is reached and nothing is bounded.
    const restartSec = Number(/RestartSec=(\d+)/.exec(unit)?.[1]);
    expect(burst * restartSec).toBeLessThanOrEqual(interval);
  });

  it('declares the limits in [Unit], where systemd reads them', () => {
    // StartLimitIntervalSec/StartLimitBurst moved from [Service] to [Unit] in
    // systemd 229. Left in [Service] they are ignored on every modern system —
    // a cap that reads correct and does nothing.
    const unit = generateSystemdUnit();
    const unitSection = unit.slice(unit.indexOf('[Unit]'), unit.indexOf('[Service]'));
    expect(unitSection).toContain('StartLimitIntervalSec=');
    expect(unitSection).toContain('StartLimitBurst=');
  });
});

describe.skipIf(process.platform === 'win32')('generateSystemdUnit', () => {
  it('never embeds a token Environment line, only PATH', () => {
    expect(generateSystemdUnit()).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('omits the token even when one is configured in the claude bundle', () => {
    seedKeychainBacked('sk-ant-oat01-abc123');
    const unit = generateSystemdUnit();
    expect(unit).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(unit).not.toContain('sk-ant-oat01-abc123');
  });

  // Parse the daemon PATH into ordered segments — robust to whatever
  // `process.execPath` is on the runner (CI's Node is /usr/local/bin/node, a dev
  // box's is deep in nvm), so the assertions test the real invariants, not a
  // substring that only holds for one machine's layout.
  const systemdPath = (unit: string): string[] => {
    const m = unit.match(/^Environment=PATH=(.+)$/m);
    if (!m) throw new Error('no PATH line in systemd unit');
    return m[1].split(':');
  };
  const launchdPath = (plist: string): string[] => {
    const m = plist.match(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/);
    if (!m) throw new Error('no PATH in launchd plist');
    return m[1].split(':');
  };

  it('pins the agents shim dir first on PATH so routines resolve the same binary (RUSH-2431)', () => {
    const segs = systemdPath(generateSystemdUnit());
    expect(segs[0]).toBe(path.dirname(getAgentsBinPath()));
    expect(segs).toEqual(expect.arrayContaining(['/usr/local/bin', '/usr/bin', '/bin']));
    expect(generateSystemdUnit()).not.toContain('v24.0.0');
  });

  it('puts the agents shim dir ahead of the Node dir so a stale agents in the Node prefix cannot shadow it (RUSH-2431)', () => {
    // A shim installed OUTSIDE the Node bin dir — the ~/.local/bin global-install
    // shape. The Node dir must still be present (for the shim's shebang), but the
    // agents shim dir has to lead so a `command` routine's bare `agents ...`
    // resolves the same binary the daemon is running, not a stale install in the
    // Node prefix.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shim-'));
    const shimDir = path.join(tmpDir, 'local-bin');
    fs.mkdirSync(shimDir, { recursive: true });
    const shim = path.join(shimDir, 'agents');
    fs.writeFileSync(shim, '');
    try {
      const unitSegs = systemdPath(generateSystemdUnit(shim));
      expect(unitSegs[0]).toBe(shimDir); // agents shim dir now first
      expect(unitSegs).toContain(path.dirname(process.execPath)); // Node still present
      expect(launchdPath(generateLaunchdPlist(shim))).toContain(shimDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('dedups the whole PATH — no dir appears twice, even for a /usr/local/bin install', () => {
    // Shim beside Node, and (on CI) Node itself in /usr/local/bin: the assembled
    // list collides with the system dirs. Full-list dedup must collapse them.
    const nodeDir = path.dirname(process.execPath);
    const segs = systemdPath(generateSystemdUnit(path.join(nodeDir, 'agents')));
    expect(segs.length).toBe(new Set(segs).size);
    expect(segs[0]).toBe(nodeDir);
  });

  it('pins ~/.rush/bin and ~/.local/bin so `which rush` succeeds under the daemon (PHNX-3075)', () => {
    // systemd/launchd pin PATH and never source ~/.profile, so a login-shell
    // install at ~/.rush/bin/rush is invisible to the daemon. The notify
    // preflight (`which rush` in providers/rush.ts) then fails forever while
    // `agents notify --dry-run` from a login shell reports ok. Reproduce that
    // split against the generated unit PATH, not a mocked lookup.
    const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-3075-path-'));
    const prevHome = process.env.HOME;
    const prevRealHome = process.env.AGENTS_REAL_HOME;
    process.env.HOME = sandboxHome;
    process.env.AGENTS_REAL_HOME = sandboxHome;
    const rushDir = path.join(sandboxHome, '.rush', 'bin');
    const localDir = path.join(sandboxHome, '.local', 'bin');
    const rushBin = path.join(rushDir, 'rush');
    fs.mkdirSync(rushDir, { recursive: true });
    fs.writeFileSync(rushBin, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(rushBin, 0o755);
    try {
      const unitSegs = systemdPath(generateSystemdUnit());
      const plistSegs = launchdPath(generateLaunchdPlist());
      for (const segs of [unitSegs, plistSegs]) {
        expect(segs[0]).toBe(path.dirname(getAgentsBinPath()));
        expect(segs).toContain(rushDir);
        expect(segs).toContain(localDir);
        expect(segs.indexOf(rushDir)).toBeGreaterThan(0);
        expect(segs.indexOf(rushDir)).toBeLessThan(segs.indexOf('/usr/bin'));
      }

      const found = spawnSync('which', ['rush'], {
        encoding: 'utf-8',
        env: { PATH: unitSegs.join(':') },
      });
      expect(found.status).toBe(0);
      expect(found.stdout.trim()).toBe(rushBin);

      const withoutUserBins = unitSegs.filter((d) => d !== rushDir && d !== localDir);
      const missed = spawnSync('which', ['rush'], {
        encoding: 'utf-8',
        env: { PATH: withoutUserBins.join(':') },
      });
      expect(missed.status).not.toBe(0);
      expect(missed.stdout.trim()).not.toBe(rushBin);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevRealHome === undefined) delete process.env.AGENTS_REAL_HOME; else process.env.AGENTS_REAL_HOME = prevRealHome;
      fs.rmSync(sandboxHome, { recursive: true, force: true });
    }
  });

  it('pins a JavaScript install to the Node runtime that installed the service', () => {
    const savedArgv1 = process.argv[1];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents daemon runtime '));
    const indexJs = path.join(tmpDir, 'index.js');
    fs.writeFileSync(indexJs, '');
    process.argv[1] = indexJs;
    try {
      expect(generateSystemdUnit()).toContain(
        `ExecStart=${[process.execPath, indexJs, '__daemon-run'].map(systemdQuote).join(' ')}`,
      );
    } finally {
      process.argv[1] = savedArgv1;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('service manifest CLI entry injection', () => {
  it('uses the explicitly installed CLI entry instead of the lifecycle script entry', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-daemon-postinstall-'));
    const installedEntry = path.join(tmpDir, 'dist', 'index.js');
    const postinstallEntry = path.join(tmpDir, 'scripts', 'postinstall.js');
    fs.mkdirSync(path.dirname(installedEntry), { recursive: true });
    fs.mkdirSync(path.dirname(postinstallEntry), { recursive: true });
    fs.writeFileSync(installedEntry, '');
    fs.writeFileSync(postinstallEntry, '');

    const savedArgv1 = process.argv[1];
    process.argv[1] = postinstallEntry;
    try {
      const plist = generateLaunchdPlist(installedEntry);
      const unit = generateSystemdUnit(installedEntry);
      expect(plist).toContain(`<string>${installedEntry}</string>`);
      expect(unit).toContain(systemdQuote(installedEntry));
      expect(plist).not.toContain(postinstallEntry);
      expect(unit).not.toContain(systemdQuote(postinstallEntry));
    } finally {
      process.argv[1] = savedArgv1;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('getDaemonLaunch', () => {
  // #556: the detached daemon must be launched as `node <entry> __daemon-run`,
  // not by executing the entry path directly. Executing a `.js`/shim path relies
  // on a shebang (POSIX) or a console-owning shell wrapper (Windows); on Windows
  // that wrapper's exit closes its console and tears the daemon down ~36ms after
  // it binds the browser IPC socket.
  it('launches a .js entry through the Node runtime', () => {
    const { command, args } = getDaemonLaunch('/opt/agents/dist/index.js');
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['/opt/agents/dist/index.js', '__daemon-run']);
  });

  it('launches .mjs and .cjs entries through the Node runtime too', () => {
    expect(getDaemonLaunch('/x/index.mjs').command).toBe(process.execPath);
    expect(getDaemonLaunch('/x/index.mjs').args[0]).toBe('/x/index.mjs');
    expect(getDaemonLaunch('/x/index.cjs').command).toBe(process.execPath);
  });

  it('runs a non-JS launcher (resolved shim) directly', () => {
    const { command, args } = getDaemonLaunch('/usr/local/bin/agents');
    expect(command).toBe('/usr/local/bin/agents');
    expect(args).toEqual(['__daemon-run']);
  });

  // The fleet-wide crash-loop: `bin/agents` is a symlink to `dist/index.js`, so
  // an extension check on the *link name* (`agents`) misses it, the daemon runs
  // the shim's shebang, and `env node` lands on a pruned/ancient node.
  it('launches an extension-less symlink to a .js entry through the Node runtime', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-symlink-'));
    const indexJs = path.join(tmpDir, 'index.js');
    fs.writeFileSync(indexJs, '#!/usr/bin/env node\n');
    const link = path.join(tmpDir, 'agents');
    fs.symlinkSync(indexJs, link);
    try {
      const { command, args } = getDaemonLaunch(link);
      expect(command).toBe(process.execPath);
      expect(args).toEqual([link, '__daemon-run']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // A real extension-less `#!/usr/bin/env node` shim (dev install) must also be
  // pinned to process.execPath, not run bare off PATH.
  it('launches an extension-less node-shebang shim through the Node runtime', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-shim-'));
    const shim = path.join(tmpDir, 'agents');
    fs.writeFileSync(shim, '#!/usr/bin/env -S node --no-warnings\nrequire("./index.js");\n');
    try {
      const { command, args } = getDaemonLaunch(shim);
      expect(command).toBe(process.execPath);
      expect(args).toEqual([shim, '__daemon-run']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // A real compiled binary (no #!node shebang) runs directly — it owns its runtime.
  it('runs a real compiled launcher (no node shebang) directly', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-native-'));
    const bin = path.join(tmpDir, 'agents');
    fs.writeFileSync(bin, '\x7fELF\x02\x01\x01\x00binary-not-a-script');
    try {
      const { command, args } = getDaemonLaunch(bin);
      expect(command).toBe(bin);
      expect(args).toEqual(['__daemon-run']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('getAgentsInvocation', () => {
  // Regression for the #315 compiled-binary self-spawn bug: teams/message/profiles
  // used to relaunch as `[process.execPath, process.argv[1], …]`. Under the bun
  // standalone binary process.argv[1] is the virtual entry `/$bunfs/root/agents`,
  // so the child became `agents /$bunfs/root/agents …` → "unknown command".
  it('launches a .js entry through the Node runtime', () => {
    const { command, args } = getAgentsInvocation(['run', 'claude'], '/opt/agents/dist/index.js');
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['/opt/agents/dist/index.js', 'run', 'claude']);
  });

  it('runs a native/compiled binary directly — never re-passes a bunfs entry', () => {
    const { command, args } = getAgentsInvocation(['run', 'claude'], '/Users/me/.local/bin/agents');
    expect(command).toBe('/Users/me/.local/bin/agents');
    expect(args).toEqual(['run', 'claude']);
    // The compiled binary is the entry; its own bunfs path must not appear as an arg.
    expect(args.some((a) => a.includes('$bunfs'))).toBe(false);
  });

  it('resolves a bun virtual entry to the real binary (process.execPath), not the un-exec-able $bunfs path', () => {
    const { command, args } = getAgentsInvocation(['run', 'claude'], '/$bunfs/root/agents');
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['run', 'claude']);
    expect(command.includes('$bunfs')).toBe(false);
  });
});

describe('getAgentsBinPath (sibling shim resolution)', () => {
  let savedArgv1: string | undefined;

  beforeEach(() => { savedArgv1 = process.argv[1]; });
  afterEach(() => {
    if (savedArgv1 !== undefined) process.argv[1] = savedArgv1;
  });

  it('resolves compiled browser and computer shims to index.js', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-shim-'));
    fs.writeFileSync(path.join(tmpDir, 'index.js'), '');
    fs.writeFileSync(path.join(tmpDir, 'browser.js'), '');
    fs.writeFileSync(path.join(tmpDir, 'computer.js'), '');
    process.argv[1] = path.join(tmpDir, 'browser.js');
    expect(getAgentsBinPath()).toBe(path.join(tmpDir, 'index.js'));
    process.argv[1] = path.join(tmpDir, 'computer.js');
    expect(getAgentsBinPath()).toBe(path.join(tmpDir, 'index.js'));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves installed browser and computer shims to the agents launcher', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-shim-'));
    fs.writeFileSync(path.join(tmpDir, 'agents'), '');
    fs.writeFileSync(path.join(tmpDir, 'browser'), '');
    fs.writeFileSync(path.join(tmpDir, 'computer'), '');
    process.argv[1] = path.join(tmpDir, 'browser');
    expect(getAgentsBinPath()).toBe(path.join(tmpDir, 'agents'));
    process.argv[1] = path.join(tmpDir, 'computer');
    expect(getAgentsBinPath()).toBe(path.join(tmpDir, 'agents'));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps the main compiled and installed entries unchanged', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-shim-'));
    const indexJs = path.join(tmpDir, 'index.js');
    const agentsBin = path.join(tmpDir, 'agents');
    fs.writeFileSync(indexJs, '');
    fs.writeFileSync(agentsBin, '');
    process.argv[1] = indexJs;
    expect(getAgentsBinPath()).toBe(indexJs);
    process.argv[1] = agentsBin;
    expect(getAgentsBinPath()).toBe(agentsBin);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves a Bun standalone virtual entry to its physical executable', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-bun-standalone-'));
    const physicalBin = path.join(tmpDir, process.platform === 'win32' ? 'agents.exe' : 'agents');
    fs.writeFileSync(physicalBin, '');
    expect(getAgentsBinPath('/$bunfs/root/agents', physicalBin)).toBe(physicalBin);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses a Bun standalone virtual entry without a physical executable', () => {
    const missingBin = path.join(os.tmpdir(), `agents-missing-${process.pid}`);
    expect(() => getAgentsBinPath('/$bunfs/root/agents', missingBin)).toThrow(
      `Cannot resolve agents CLI: Bun standalone executable not found at ${missingBin}`,
    );
  });

  it('refuses a sibling shim when its main entry is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-shim-'));
    const browserJs = path.join(tmpDir, 'browser.js');
    fs.writeFileSync(browserJs, '');
    process.argv[1] = browserJs;
    expect(() => getAgentsBinPath()).toThrow(`main CLI entry not found at ${path.join(tmpDir, 'index.js')}`);
    const browser = path.join(tmpDir, 'browser');
    fs.writeFileSync(browser, '');
    process.argv[1] = browser;
    expect(() => getAgentsBinPath()).toThrow(`main CLI entry not found at ${path.join(tmpDir, 'agents')}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates launchd arguments for the main entry from both shim layouts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-plist-'));
    const indexJs = path.join(tmpDir, 'index.js');
    const browserJs = path.join(tmpDir, 'browser.js');
    const agentsBin = path.join(tmpDir, 'agents');
    const browserBin = path.join(tmpDir, 'browser');
    for (const file of [indexJs, browserJs, agentsBin, browserBin]) fs.writeFileSync(file, '');
    process.argv[1] = browserJs;
    let plist = generateLaunchdPlist();
    expect(plist).toContain(`<string>${process.execPath}</string>`);
    expect(plist).toContain(`<string>${indexJs}</string>`);
    expect(plist).not.toContain(`<string>${browserJs}</string>`);
    process.argv[1] = browserBin;
    plist = generateLaunchdPlist();
    expect(plist).toContain(`<string>${agentsBin}</string>`);
    expect(plist).not.toContain(`<string>${browserBin}</string>`);
    expect(plist).toContain('<string>__daemon-run</string>');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
