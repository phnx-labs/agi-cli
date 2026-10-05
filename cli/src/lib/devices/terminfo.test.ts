import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  shouldSyncTerminfo,
  terminfoSynced,
  markTerminfoSynced,
  localTerminfoSource,
  terminfoHostKey,
} from './terminfo.js';

describe('shouldSyncTerminfo', () => {
  it('skips non-interactive invocations (a remote command)', () => {
    expect(shouldSyncTerminfo({ term: 'xterm-ghostty', shell: 'posix', interactive: false })).toBe(false);
  });

  it('skips Windows/powershell devices — the console ignores terminfo', () => {
    expect(shouldSyncTerminfo({ term: 'xterm-ghostty', shell: 'powershell', interactive: true })).toBe(false);
  });

  it('skips when TERM is unset or blank', () => {
    expect(shouldSyncTerminfo({ term: undefined, shell: 'posix', interactive: true })).toBe(false);
    expect(shouldSyncTerminfo({ term: '   ', shell: 'posix', interactive: true })).toBe(false);
  });

  it('skips universally-shipped terminfo names (no wasted round-trip)', () => {
    for (const t of ['xterm', 'xterm-256color', 'screen-256color', 'tmux-256color', 'vt100', 'linux']) {
      expect(shouldSyncTerminfo({ term: t, shell: 'posix', interactive: true })).toBe(false);
    }
  });

  it('syncs exotic terminal entries the remote is unlikely to have', () => {
    for (const t of ['xterm-ghostty', 'xterm-kitty', 'alacritty', 'wezterm', 'foot', 'rio']) {
      expect(shouldSyncTerminfo({ term: t, shell: 'posix', interactive: true })).toBe(true);
    }
  });
});

describe('terminfoHostKey', () => {
  it('uses the bare host when no login user is set', () => {
    expect(terminfoHostKey({ user: undefined, name: 'box' }, 'box.ts.net')).toBe('box.ts.net');
  });

  it('qualifies the key with the remote user — terminfo is per-user (~/.terminfo)', () => {
    const addr = 'box.ts.net';
    expect(terminfoHostKey({ user: 'alice', name: 'box' }, addr)).not.toBe(terminfoHostKey({ user: 'bob', name: 'box' }, addr));
    expect(terminfoHostKey({ user: 'alice', name: 'box' }, addr)).toBe('alice@box.ts.net');
  });

  it('falls back to the device name when the address is unresolved', () => {
    expect(terminfoHostKey({ user: 'alice', name: 'box' }, undefined)).toBe('alice@box');
  });
});

describe('terminfo sync cache stamp', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-terminfo-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('is false before any sync, true after marking, and round-trips exotic names', () => {
    expect(terminfoSynced('host-a', 'xterm-ghostty', tmp)).toBe(false);
    markTerminfoSynced('host-a', 'xterm-ghostty', tmp);
    expect(terminfoSynced('host-a', 'xterm-ghostty', tmp)).toBe(true);
  });

  it('keys the stamp by BOTH host and TERM', () => {
    markTerminfoSynced('host-a', 'xterm-ghostty', tmp);
    expect(terminfoSynced('host-b', 'xterm-ghostty', tmp)).toBe(false);
    expect(terminfoSynced('host-a', 'xterm-kitty', tmp)).toBe(false);
  });

  it('treats a stale stamp (older than the TTL) as un-synced', () => {
    markTerminfoSynced('host-a', 'xterm-ghostty', tmp);
    const stamp = path.join(tmp, 'devices', 'terminfo', 'host-a__xterm-ghostty');
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stamp, old, old);
    expect(terminfoSynced('host-a', 'xterm-ghostty', tmp)).toBe(false);
  });

  it('does not crash on hosts/terms with filesystem-hostile characters', () => {
    const host = 'user@10.0.0.1:22';
    markTerminfoSynced(host, 'xterm-ghostty', tmp);
    expect(terminfoSynced(host, 'xterm-ghostty', tmp)).toBe(true);
  });
});

describe('localTerminfoSource', () => {
  it('returns a compilable source for a term this machine has, or null otherwise', () => {
    const src = localTerminfoSource('xterm');
    if (src !== null) {
      expect(src).toContain('xterm');
    } else {
      expect(src).toBeNull();
    }
  });

  it('returns null for a terminfo name that does not exist', () => {
    expect(localTerminfoSource('definitely-not-a-real-term-xyz')).toBeNull();
  });
});
