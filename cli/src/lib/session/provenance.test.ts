import { describe, it, expect } from 'vitest';
import {
  parseProcEnviron,
  extractKnownEnv,
  parseSshConnection,
  parseItermSession,
  deriveProvenance,
  detectProvenance,
  PROVENANCE_ENV_KEYS,
} from './provenance.js';

describe('parseProcEnviron', () => {
  it('parses the NUL-separated /proc/<pid>/environ body', () => {
    const raw = 'SHELL=/bin/zsh\0TERM_PROGRAM=iTerm.app\0TMUX_PANE=%3\0';
    expect(parseProcEnviron(raw)).toEqual({
      SHELL: '/bin/zsh',
      TERM_PROGRAM: 'iTerm.app',
      TMUX_PANE: '%3',
    });
  });

  it('keeps values that themselves contain =', () => {
    const raw = 'FOO=a=b=c\0BAR=x\0';
    expect(parseProcEnviron(raw)).toEqual({ FOO: 'a=b=c', BAR: 'x' });
  });

  it('ignores empty entries and malformed (no =) pairs', () => {
    const raw = '\0JUSTNAME\0OK=1\0';
    expect(parseProcEnviron(raw)).toEqual({ OK: '1' });
  });
});

describe('extractKnownEnv (macOS `ps eww` output)', () => {
  it('extracts known keys from a command+env line, preserving spaces in values', () => {
    const line =
      '/usr/local/bin/node /path/to/claude --resume LANG=en_US.UTF-8 ' +
      'SSH_CONNECTION=203.0.113.7 51828 10.0.0.3 22 TMUX=/tmp/tmux-501/default,914,2 ' +
      'TMUX_PANE=%5 TERM_PROGRAM=iTerm.app PWD=/Users/m/src';
    const env = extractKnownEnv(line, PROVENANCE_ENV_KEYS);
    expect(env.SSH_CONNECTION).toBe('203.0.113.7 51828 10.0.0.3 22');
    expect(env.TMUX).toBe('/tmp/tmux-501/default,914,2');
    expect(env.TMUX_PANE).toBe('%5');
    expect(env.TERM_PROGRAM).toBe('iTerm.app');
    expect(env.LANG).toBeUndefined();
  });

  it('returns empty when no known keys are present', () => {
    expect(extractKnownEnv('node script.js PWD=/tmp HOME=/root', PROVENANCE_ENV_KEYS)).toEqual({});
  });
});

describe('parseSshConnection', () => {
  it('parses the four space-joined fields', () => {
    expect(parseSshConnection('203.0.113.7 51828 10.0.0.3 22')).toEqual({
      clientIp: '203.0.113.7',
      clientPort: 51828,
      serverIp: '10.0.0.3',
      serverPort: 22,
    });
  });

  it('rejects malformed values', () => {
    expect(parseSshConnection('nope')).toBeUndefined();
    expect(parseSshConnection('a b c d')).toBeUndefined();
  });
});

describe('parseItermSession', () => {
  it('extracts the UUID after the wNtNpN: prefix (what `id of session` returns)', () => {
    expect(parseItermSession('w0t1p0:9F2A-UUID')).toBe('9F2A-UUID');
  });

  it('tolerates a bare value with no colon', () => {
    expect(parseItermSession('9F2A-UUID')).toBe('9F2A-UUID');
  });

  it('returns undefined for empty / absent', () => {
    expect(parseItermSession(undefined)).toBeUndefined();
    expect(parseItermSession('')).toBeUndefined();
  });
});

describe('deriveProvenance', () => {
  it('local + tmux pane yields a tmux reply rail (addressable)', () => {
    const p = deriveProvenance(
      { TMUX: '/tmp/tmux-501/default,914,2', TMUX_PANE: '%5', TERM_PROGRAM: 'tmux' },
      'zion',
    );
    expect(p.host).toBe('zion');
    expect(p.transport).toBe('local');
    expect(p.mux).toEqual({ kind: 'tmux', socket: '/tmp/tmux-501/default', pane: '%5' });
    expect(p.reply).toEqual({ rail: 'tmux', target: '%5', socket: '/tmp/tmux-501/default' });
  });

  it('ssh session flags transport and captures the origin', () => {
    const p = deriveProvenance(
      { SSH_CONNECTION: '203.0.113.7 51828 10.0.0.3 22', SSH_TTY: '/dev/pts/4' },
      'phoenix-horizon',
    );
    expect(p.transport).toBe('ssh');
    expect(p.ssh).toEqual({ clientIp: '203.0.113.7', clientPort: 51828, serverIp: '10.0.0.3', serverPort: 22 });
  });

  it('iTerm split (no tmux) yields an iterm reply rail carrying the session UUID', () => {
    const p = deriveProvenance(
      { TERM_PROGRAM: 'iTerm.app', ITERM_SESSION_ID: 'w0t2p1:AAAA-BBBB' },
      'zion',
    );
    expect(p.mux).toBeUndefined();
    expect(p.reply).toEqual({ rail: 'iterm', session: 'AAAA-BBBB' });
  });

  it('tmux inside iTerm still prefers the tmux rail (works inside any host app)', () => {
    const p = deriveProvenance(
      { TERM_PROGRAM: 'iTerm.app', ITERM_SESSION_ID: 'w0t0p0:UUID', TMUX: '/tmp/s,1,0', TMUX_PANE: '%7' },
      'zion',
    );
    expect(p.reply).toEqual({ rail: 'tmux', target: '%7', socket: '/tmp/s' });
  });

  it('no tmux, no iterm, no ssh => local and NOT addressable (reply null)', () => {
    const p = deriveProvenance({ TERM_PROGRAM: 'vscode' }, 'this-mac');
    expect(p.transport).toBe('local');
    expect(p.mux).toBeUndefined();
    expect(p.reply).toBeNull();
  });

  it('screen session is recognized but not (yet) addressable', () => {
    const p = deriveProvenance({ STY: '12345.pts-0.host' }, 'box');
    expect(p.mux).toEqual({ kind: 'screen', session: '12345.pts-0.host' });
    expect(p.reply).toBeNull();
  });
});

describe('detectProvenance (real process, no mocks)', () => {
  it('reads the running test process env and reports its own host', async () => {
    const p = await detectProvenance(process.pid);
    if (process.platform === 'linux' || process.platform === 'darwin') {
      expect(p).toBeDefined();
      expect(p!.host.length).toBeGreaterThan(0);
      expect(p!.transport === 'local' || p!.transport === 'ssh').toBe(true);
      expect(p!.transport).toBe(process.env.SSH_CONNECTION ? 'ssh' : 'local');
    } else {
      expect(p).toBeUndefined();
    }
  });

  it('returns undefined for an impossible pid', async () => {
    expect(await detectProvenance(0)).toBeUndefined();
    expect(await detectProvenance(-1)).toBeUndefined();
  });
});
