import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isolatedHomeSuffix, namespacedServiceLabel, serviceManifestHomeEnv } from './service-manifest.js';
import { generateLaunchdPlist, generateSystemdUnit, daemonServiceLabel } from './daemon/daemon.js';
import { generateServicePlist } from './menubar/install-menubar.js';

const savedHome = process.env.HOME;
const savedRealHome = process.env.AGENTS_REAL_HOME;

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedRealHome === undefined) delete process.env.AGENTS_REAL_HOME; else process.env.AGENTS_REAL_HOME = savedRealHome;
});

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

});
