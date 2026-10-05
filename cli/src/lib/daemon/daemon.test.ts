/** Daemon service-manifest generation. Security contract: the manifest (launchd plist / systemd
 * unit) NEVER embeds a Claude OAuth token, even one in the `claude` bundle. Residual of RUSH-2819;
 * keep the name daemon.test.ts: CI maps lib/daemon/daemon.ts to it. */

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

// RUSH-2639 (1.22.40 macOS release CI): launchd does not inherit `launchctl load`'s caller
// environment, so a plist carrying only PATH lets the daemon resolve HOME to the real login value.
// Under the hermetic harness that bootstrapped a real ~/.agents on the CI runner.
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

// RUSH-2639 (residual): launchd/systemd route unload/load/list by service identifier alone, so
// test instances and the real install shared one label, and `launchctl unload <own plist>`
// silently killed the job under that label. Namespace the identifier under a redirected HOME.
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

// RUSH-2639: reproduce the macOS CI leak end to end. launchd applies a plist's
// EnvironmentVariables over the login session's own environment, not the caller's, so an
// env-inheriting shim would never have caught it. This shim applies only the real plist.
describe.skipIf(process.platform !== 'darwin')('startDaemon — launchd does not inherit the caller env (RUSH-2639)', () => {
  let tmpHome = '';
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join('/tmp', 'agd-2639-launchd-'));
    for (const k of ['HOME', 'PATH', 'AGENTS_DAEMON_DIR', 'AGENTS_REAL_HOME', 'AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME', 'AGENTS_ALLOW_TEST_DAEMON']) saved[k] = process.env[k];
    process.env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME = '1';
    // W4: these tests deliberately launch daemons under a sandbox HOME.
    process.env.AGENTS_ALLOW_TEST_DAEMON = '1';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // RUSH-2968: the originating leak site. launchctl is per-user-session and HOME-independent, so
  // startDaemon under a redirected HOME must never touch the real launchd; without the test seam
  // it falls back to a detached spawn and the shim must record ZERO invocations.
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

    // A minimal stand-in for launchd: reads the REAL plist `startDaemon()` wrote, takes only its
    // EnvironmentVariables dict, and spawns the child with that as the whole environment plus a
    // foreign base (no HOME). Without the RUSH-2639 fix the child would see no HOME.
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

// RUSH-2418: crash-loop prevention had only the OS supervisor's uncapped retry. `KeepAlive` with
// no `ThrottleInterval` relaunches on launchd's ~10s default, so a daemon dying on boot restarts
// six times a minute forever. Same fix as the menu-bar helper (`menubar/install-menubar.ts:308`).
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

// The systemd half of PHNX-4116's "always recovers" guarantee: restart is paced (RestartSec=30)
// but uncapped (StartLimitIntervalSec=0), so a repeatedly deadline-breaching daemon restarts every
// ~30s instead of being abandoned in `failed`. KillMode=process spares detached routine children.
describe.skipIf(process.platform === 'win32')('generateSystemdUnit — restart-always, uncapped (PHNX-4116)', () => {
  it('sets StartLimitIntervalSec=0 so systemd never gives up retrying', () => {
    const unit = generateSystemdUnit();
    // The [Unit] section carries the (0 =) uncapped limit, where systemd reads it.
    const unitSection = unit.slice(unit.indexOf('[Unit]'), unit.indexOf('[Service]'));
    expect(unitSection).toContain('StartLimitIntervalSec=0');
    // The old burst cap is gone — a repeating hang must keep being restarted.
    expect(unit).not.toContain('StartLimitBurst');
  });

  it('keeps Restart=always paced by RestartSec, and sets KillMode=process', () => {
    const unit = generateSystemdUnit();
    const serviceSection = unit.slice(unit.indexOf('[Service]'));
    expect(serviceSection).toContain('Restart=always');
    expect(Number(/RestartSec=(\d+)/.exec(serviceSection)?.[1])).toBeGreaterThan(0);
    expect(serviceSection).toContain('KillMode=process');
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

  // Parse the daemon PATH into ordered segments so assertions test real invariants on any runner's
  // `process.execPath` layout (CI's /usr/local/bin/node vs a dev box's nvm), not a
  // machine-specific substring.
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
    // A shim outside the Node bin dir (the ~/.local/bin global-install shape): the Node dir must
    // still be present for the shebang, but the agents shim dir must lead so a `command` routine's
    // bare `agents` resolves the running binary, not a stale one in the Node prefix.
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
    // systemd/launchd pin PATH and never source ~/.profile, so a login-shell install at
    // ~/.rush/bin/rush is invisible to the daemon and the notify preflight (`which rush`) fails
    // forever. Reproduce against the generated unit PATH, not a mocked lookup.
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
  // #556: launch the detached daemon as `node <entry> __daemon-run`, not by executing the entry
  // path. A `.js`/shim path relies on a shebang (POSIX) or a console-owning wrapper (Windows)
  // whose exit tears the daemon down ~36ms after it binds.
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
  // Regression for the #315 compiled-binary self-spawn bug: teams/message/profiles relaunched as
  // `[process.execPath, process.argv[1], ...]`, and under the Bun standalone argv[1] is the
  // virtual `/$bunfs/root/agents`, giving "unknown command".
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
