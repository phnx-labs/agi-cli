/** Managed known_hosts pinning (RUSH-1767), security-shaped: a host is "pinned" only when its key
 * is recorded (else the credential-copy check ships tokens over an unverified connection), policy
 * flips to StrictHostKeyChecking=yes exactly when pinned, and re-scanning a pinned key is a no-op. */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  hostKeyCheckingOpts,
  isDevicePinned,
  isHostPinned,
  isHostPinnedIn,
  newKnownHostsLines,
  recordScannedKeys,
} from './known-hosts.js';
import type { DeviceProfile } from './registry.js';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI0000000000000000000000000000000000000000000';

describe('isHostPinnedIn', () => {
  it('matches a recorded host, case-insensitively, and splits comma / [host]:port entries', () => {
    expect(isHostPinnedIn(`yosemite-s0.ts.net ${KEY}`, 'yosemite-s0.ts.net')).toBe(true);
    expect(isHostPinnedIn(`YOSEMITE-s0.ts.net ${KEY}`, 'yosemite-s0.ts.net')).toBe(true);
    expect(isHostPinnedIn(`a.ts.net,b.ts.net ${KEY}`, 'b.ts.net')).toBe(true);
    expect(isHostPinnedIn(`[box.ts.net]:2222 ${KEY}`, 'box.ts.net')).toBe(true);
  });

  it('does not match an absent host, a hashed entry, or an empty needle', () => {
    expect(isHostPinnedIn(`yosemite-s0.ts.net ${KEY}`, 'other.ts.net')).toBe(false);
    expect(isHostPinnedIn(`|1|abc=|def= ${KEY}`, 'yosemite-s0.ts.net')).toBe(false);
    expect(isHostPinnedIn('', 'yosemite-s0.ts.net')).toBe(false);
    expect(isHostPinnedIn(`yosemite-s0.ts.net ${KEY}`, '   ')).toBe(false);
  });
});

describe('hostKeyCheckingOpts', () => {
  it('verifies strictly against the managed store once pinned', () => {
    const opts = hostKeyCheckingOpts(true, '/managed/known_hosts');
    expect(opts).toEqual([
      '-o', 'UserKnownHostsFile=/managed/known_hosts',
      '-o', 'StrictHostKeyChecking=yes',
    ]);
  });

  it('learns on first connect (accept-new) before a host is pinned', () => {
    const opts = hostKeyCheckingOpts(false, '/managed/known_hosts');
    expect(opts).toContain('StrictHostKeyChecking=accept-new');
    expect(opts).not.toContain('StrictHostKeyChecking=yes');
    expect(opts).toContain('UserKnownHostsFile=/managed/known_hosts');
  });
});

describe('newKnownHostsLines', () => {
  it('returns only lines absent from the store, dropping comments/blanks and inner dupes', () => {
    const existing = `# managed\nold.ts.net ${KEY}\n`;
    const scanned = `# ssh-keyscan header\nold.ts.net ${KEY}\nnew.ts.net ${KEY}\nnew.ts.net ${KEY}\n`;
    expect(newKnownHostsLines(existing, scanned)).toEqual([`new.ts.net ${KEY}`]);
  });

  it('is a no-op when every scanned key is already pinned', () => {
    const line = `box.ts.net ${KEY}`;
    expect(newKnownHostsLines(`${line}\n`, `# c\n${line}\n`)).toEqual([]);
  });
});

describe('recordScannedKeys (the non-device / ssh-config-alias pin path)', () => {
  // Remedy for RUSH-1767's dead end: a bare `~/.ssh/config` Host alias is not a registered device,
  // so `agents ssh <alias>` cannot pin it. The --copy-creds check scans the alias's resolved
  // HostName and records it here; this store-write half makes the scan count as pinned.
  it('pins a non-device host from ssh-keyscan output, idempotently', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-'));
    const file = path.join(dir, 'known_hosts');
    try {
      const scan = `# web.internal:22 SSH-2.0-OpenSSH_9.6\nweb.internal ${KEY}\n`;
      expect(isHostPinned('web.internal', file)).toBe(false);
      expect(recordScannedKeys('web.internal', scan, file)).toEqual({ pinned: true, added: 1 });
      expect(isHostPinned('web.internal', file)).toBe(true);
      expect(recordScannedKeys('web.internal', scan, file)).toEqual({ pinned: true, added: 0 });
      expect(fs.readFileSync(file, 'utf-8').match(/web\.internal/g)).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pins a custom-port alias recorded as [host]:port', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-'));
    const file = path.join(dir, 'known_hosts');
    try {
      const scan = `[box.internal]:2222 ${KEY}\n`;
      expect(recordScannedKeys('box.internal', scan, file)).toEqual({ pinned: true, added: 1 });
      expect(isHostPinned('box.internal', file)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports not-pinned when the scan yields no usable key (gate then refuses)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-'));
    const file = path.join(dir, 'known_hosts');
    try {
      expect(recordScannedKeys('dead.internal', '# no key\n', file)).toEqual({ pinned: false, added: 0 });
      expect(isHostPinned('dead.internal', file)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isHostPinned (on-disk store)', () => {
  it('reads the managed store and reports a recorded host as pinned', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-'));
    const file = path.join(dir, 'known_hosts');
    fs.writeFileSync(file, `pinned.ts.net ${KEY}\n`);
    try {
      expect(isHostPinned('pinned.ts.net', file)).toBe(true);
      expect(isHostPinned('unpinned.ts.net', file)).toBe(false);
      expect(isHostPinned('pinned.ts.net', path.join(dir, 'absent'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isDevicePinned', () => {
  const dev = (name: string, dnsName?: string): DeviceProfile =>
    ({ name, ...(dnsName ? { address: { dnsName } } : {}) }) as DeviceProfile;

  it('is pinned when the FQDN the ssh connection dials is pinned, even if the bare name is not (PHNX-3505)', () => {
    const pinned = (host: string) => host === 'yosemite-m6.tail1a85a1.ts.net';
    expect(isDevicePinned(dev('yosemite-m6', 'yosemite-m6.tail1a85a1.ts.net'), pinned)).toBe(true);
  });

  it('is pinned when only the bare name is pinned', () => {
    expect(isDevicePinned(dev('mac-mini', 'mac-mini.tail1a85a1.ts.net'), (h) => h === 'mac-mini')).toBe(true);
  });

  it('is not pinned when neither the FQDN nor the bare name is pinned', () => {
    expect(isDevicePinned(dev('yosemite-m6', 'yosemite-m6.tail1a85a1.ts.net'), () => false)).toBe(false);
  });

  it('falls back to the bare-name check when the device has no address', () => {
    expect(isDevicePinned(dev('mark-1'), (h) => h === 'mark-1')).toBe(true);
    expect(isDevicePinned(dev('mark-1'), () => false)).toBe(false);
  });
});
