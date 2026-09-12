/**
 * RUSH-2639. Every service manifest this CLI writes must carry the caller's HOME
 * and a HOME-namespaced identifier.
 *
 * The bug this pins: the daemon's plist was fixed in isolation, and the two
 * other manifests — the menu-bar helper and the `agents computer` helper — kept
 * omitting HOME. The computer helper's plist is now rendered by the standalone
 * `computer` engine (PHNX-4075), so what this file pins for it is the CONTEXT
 * agents-cli hands that engine: the namespaced label, the registration verdict,
 * and the home env its manifest must bake. The engine cannot derive any of
 * those — only the CLI that redirected HOME knows it did.
 * launchd applies a manifest's `EnvironmentVariables` on top of
 * the LOGIN SESSION's environment, never the caller's, so those two handed their
 * child the account home. Under the hermetic harness (tests/setup.ts redirects
 * HOME to a fork-private sandbox) that child then bootstrapped `~/.agents` in the
 * REAL home — the macOS-only leak that failed the 1.22.40 release CI, with
 * `.system`, `.history`, `.cache`, and `routines` appearing in the runner's home.
 *
 * The check is per-generator rather than one assertion on a shared helper: a
 * generator that stops calling the helper is exactly the regression, and only a
 * test that reads the rendered manifest can catch it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isolatedHomeSuffix, namespacedServiceLabel, serviceManifestHomeEnv } from './service-manifest.js';
import { generateLaunchdPlist, generateSystemdUnit, daemonServiceLabel } from './daemon/daemon.js';
import { generateServicePlist } from './menubar/install-menubar.js';
import { buildServiceContext, COMPUTER_HELPER_SERVICE_LABEL } from './computer/context.js';

const savedHome = process.env.HOME;
const savedRealHome = process.env.AGENTS_REAL_HOME;

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedRealHome === undefined) delete process.env.AGENTS_REAL_HOME; else process.env.AGENTS_REAL_HOME = savedRealHome;
});

/** A redirected HOME that is real on disk, so generators may stat under it. */
function withRedirectedHome<T>(fn: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-manifest-home-'));
  fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  process.env.HOME = home;
  process.env.AGENTS_REAL_HOME = home;
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('serviceManifestHomeEnv', () => {
  it('reports the caller HOME, not the passwd home', () => {
    withRedirectedHome((home) => {
      const env = serviceManifestHomeEnv();
      expect(env.HOME).toBe(home);
      expect(env.AGENTS_REAL_HOME).toBe(home);
      expect(env.HOME).not.toBe(os.userInfo().homedir);
    });
  });

  it('falls back to the passwd home only when HOME is genuinely unset', () => {
    delete process.env.HOME;
    delete process.env.AGENTS_REAL_HOME;
    expect(serviceManifestHomeEnv().HOME).toBe(os.homedir());
  });
});

describe('namespacedServiceLabel', () => {
  it('namespaces under a redirected HOME and leaves the production identifier alone', () => {
    withRedirectedHome(() => {
      expect(namespacedServiceLabel('com.example.svc')).toBe(`com.example.svc.sandbox-${isolatedHomeSuffix()}`);
    });
    process.env.HOME = os.userInfo().homedir;
    expect(namespacedServiceLabel('com.example.svc')).toBe('com.example.svc');
  });
});

// The three generators. Each is asserted on its own rendered output — the leak
// was one generator silently not carrying HOME while its siblings did.
describe('every generated service manifest carries the caller HOME (RUSH-2639)', () => {
  it('the daemon launchd plist bakes HOME and a namespaced Label', () => {
    withRedirectedHome((home) => {
      const plist = generateLaunchdPlist('/usr/local/bin/agents');
      expect(plist).toContain(`<key>HOME</key>\n    <string>${home}</string>`);
      expect(plist).toContain(`<key>AGENTS_REAL_HOME</key>\n    <string>${home}</string>`);
      expect(plist).toContain(`<string>${daemonServiceLabel()}</string>`);
      expect(plist).not.toContain('<string>com.phnx-labs.agents-daemon</string>');
    });
  });

  it('the daemon systemd unit bakes HOME', () => {
    withRedirectedHome((home) => {
      const unit = generateSystemdUnit('/usr/local/bin/agents');
      expect(unit).toContain(`Environment=HOME=${home}`);
      expect(unit).toContain(`Environment=AGENTS_REAL_HOME=${home}`);
    });
  });

  // Regression: this plist carried PATH/AGENTS_NODE/AGENTS_ENTRY/AGENTS_BIN and
  // no HOME, so the launchd-started helper resolved the account home and every
  // `agents` call it made bootstrapped that home's ~/.agents.
  it('the menu-bar launchd plist bakes HOME and a namespaced Label', () => {
    withRedirectedHome((home) => {
      const plist = generateServicePlist('/some/MenubarHelper.app/Contents/MacOS/AGI Menu');
      expect(plist).toContain(`<key>HOME</key>`);
      expect(plist).toContain(`<string>${home}</string>`);
      expect(plist).toContain(`<key>AGENTS_REAL_HOME</key>`);
      expect(plist).toContain(`com.phnx-labs.agents-menubar.sandbox-${isolatedHomeSuffix()}`);
      expect(plist).not.toContain('<string>com.phnx-labs.agents-menubar</string>');
    });
  });

  // The computer helper's plist is the engine's to render, so what must not
  // regress here is the HOME the engine is TOLD to bake. Handing it nothing
  // reproduces the original leak one layer out: the engine would fall back to
  // the login session's home and bootstrap `~/.agents` in the real one.
  it('the computer-helper context carries the caller HOME for the engine to bake', () => {
    withRedirectedHome((home) => {
      const service = buildServiceContext();
      expect(service.homeEnv.HOME).toBe(home);
      expect(service.homeEnv.AGENTS_REAL_HOME).toBe(home);
    });
  });

  it('the computer-helper Label is namespaced under a redirected HOME, and only then', () => {
    withRedirectedHome(() => {
      expect(buildServiceContext().label)
        .toBe(`${COMPUTER_HELPER_SERVICE_LABEL}.sandbox-${isolatedHomeSuffix()}`);
    });
    process.env.HOME = os.userInfo().homedir;
    expect(buildServiceContext().label).toBe(COMPUTER_HELPER_SERVICE_LABEL);
  });

  // The label alone does not protect launchd: it is per-user-session and
  // HOME-independent, so a sandboxed process registering a namespaced job still
  // registers in the REAL launchd (RUSH-2968). The engine cannot see that it is
  // sandboxed, so the refusal has to travel with the context.
  it('refuses service-manager registration under a redirected HOME, and allows it otherwise', () => {
    withRedirectedHome(() => {
      const service = buildServiceContext();
      expect(service.registrationAllowed).toBe(false);
      expect(service.reason).toMatch(/redirected HOME/);
    });
    process.env.HOME = os.userInfo().homedir;
    expect(buildServiceContext().registrationAllowed).toBe(true);
  });
});
