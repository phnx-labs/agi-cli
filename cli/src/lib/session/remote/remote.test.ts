import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildForwardedArgs,
  buildRemoteCommand,
  ensureWholeIndex,
  shellQuote,
  classifySshFailure,
  remoteCachePath,
  formatStaleBanner,
  formatUnreachable,
  isRemoteCacheFresh,
  REMOTE_CACHE_MAX_AGE_MS,
  readRemoteCache,
  writeRemoteCache,
  serveWarmRemoteCache,
  replayRemoteCache,
} from './remote.js';

// Reproduce both remote login-shell layers; this is the quoting/injection proof, not a direct argv unit test.
function decodeRemoteArgv(forwarded: string[]): string[] {
  const shim = `agents() { for a in "$@"; do printf '%s\\n' "$a"; done; }; export -f agents; `;
  const res = spawnSync('bash', ['-c', shim + buildRemoteCommand(forwarded)], { encoding: 'utf-8' });
  expect(res.status).toBe(0);
  return res.stdout.split('\n').slice(0, -1);
}

const argv = (...userArgs: string[]) => ['/usr/bin/bun', '/path/agents', ...userArgs];

describe('buildForwardedArgs', () => {
  it('drops --device and its value, keeping the rest', () => {
    expect(
      buildForwardedArgs(argv('sessions', 'auth bug', '--device', 'yosemite-s0', '--json'), new Set(['yosemite-s0'])),
    ).toEqual(['sessions', 'auth bug', '--json']);
  });

  it('drops the --device=value form', () => {
    expect(buildForwardedArgs(argv('sessions', '--device=yosemite-s0', 'query'))).toEqual(['sessions', 'query']);
  });

  it('drops plural --devices values so a peer cannot re-fan-out', () => {
    expect(
      buildForwardedArgs(
        argv('sessions', '--computer', '--devices', 'box1', 'box2', '--json'),
        new Set(['box1', 'box2']),
      ),
    ).toEqual(['sessions', '--computer', '--json']);
  });

  it('drops the --devices=value form', () => {
    expect(buildForwardedArgs(argv('sessions', '--devices=all', '--computer')))
      .toEqual(['sessions', '--computer']);
  });

  it('stops consuming at the first token that is not a known host', () => {
    expect(
      buildForwardedArgs(
        argv('sessions', '--device', 'box1', 'box2', 'auth'),
        new Set(['box1', 'box2']),
      ),
    ).toEqual(['sessions', 'auth']);
  });
});

describe('ensureWholeIndex', () => {
  it('adds --all so a remote listing spans the peer index, not its login cwd', () => {
    expect(ensureWholeIndex(['sessions', '--agent', 'grok'])).toEqual(['sessions', '--agent', 'grok', '--all']);
  });

  it('is idempotent — never adds a second --all', () => {
    expect(ensureWholeIndex(['sessions', '--all'])).toEqual(['sessions', '--all']);
  });

  it('preserves an explicit path query (--all is inert when a path filter wins on the remote)', () => {
    expect(ensureWholeIndex(['sessions', '/srv/app'])).toEqual(['sessions', '/srv/app', '--all']);
  });
});

describe('shellQuote', () => {
  it('wraps a plain word in single quotes', () => {
    expect(shellQuote('agents')).toBe("'agents'");
  });

  it('escapes embedded single quotes (the injection-prone case)', () => {
    expect(shellQuote("o'brien")).toBe("'o'\\''brien'");
  });
});

describe('buildRemoteCommand', () => {
  it('wraps the invocation in bash -lc so the remote login PATH resolves agents', () => {
    expect(buildRemoteCommand(['sessions', 'q']).startsWith('bash -lc ')).toBe(true);
  });

  it('reconstructs the exact argv on the remote through both shell layers', () => {
    expect(decodeRemoteArgv(['sessions', 'auth bug', '--last', '3']))
      .toEqual(['sessions', 'auth bug', '--last', '3']);
  });

  it('keeps a query with a single quote injection-safe (no early quote-break)', () => {
    expect(decodeRemoteArgv(['sessions', "it's broken"]))
      .toEqual(['sessions', "it's broken"]);
  });

  it('neutralizes shell metacharacters in a query (no command substitution)', () => {
    expect(decodeRemoteArgv(['sessions', '$(whoami); rm -rf /', '--json']))
      .toEqual(['sessions', '$(whoami); rm -rf /', '--json']);
  });

  it('pins the peer local so --device does not re-sweep its fleet', () => {
    expect(buildRemoteCommand(['sessions', '--agent', 'codex'])).toContain('AGENTS_SESSIONS_LOCAL=1');
  });
});

describe('classifySshFailure', () => {
  it('maps a clean exit to ok', () => {
    expect(classifySshFailure({ status: 0 })).toBe('ok');
  });

  it('maps ssh exit 255 to unreachable (connection layer, not the remote query)', () => {
    expect(classifySshFailure({ status: 255 })).toBe('unreachable');
  });

  it('maps any other non-zero to query-failed (remote agents ran and failed)', () => {
    expect(classifySshFailure({ status: 1 })).toBe('query-failed');
    expect(classifySshFailure({ status: 2 })).toBe('query-failed');
    expect(classifySshFailure({ status: null })).toBe('query-failed');
  });

  it('maps a spawn error (ssh binary missing, etc.) to spawn-error', () => {
    expect(classifySshFailure({ error: new Error('ENOENT'), status: null })).toBe('spawn-error');
  });
});

describe('remoteCachePath', () => {
  it('is deterministic for the same host and args', () => {
    const a = remoteCachePath('mac-mini', ['sessions', '--last', '3']);
    const b = remoteCachePath('mac-mini', ['sessions', '--last', '3']);
    expect(a).toBe(b);
  });

  it('separates distinct queries into distinct files', () => {
    const a = remoteCachePath('mac-mini', ['sessions', '--last', '3']);
    const b = remoteCachePath('mac-mini', ['sessions', '--last', '5']);
    expect(a).not.toBe(b);
  });

  it('separates distinct hosts even for the same query', () => {
    const a = remoteCachePath('box-a', ['sessions', 'auth']);
    const b = remoteCachePath('box-b', ['sessions', 'auth']);
    expect(a).not.toBe(b);
  });

  it('keeps the host readable but filesystem-safe in the filename', () => {
    const p = remoteCachePath('deploy@staging.example.com', ['sessions']);
    const file = path.basename(p);
    expect(file.startsWith('deploy@staging.example.com__')).toBe(true);
    expect(file.endsWith('.txt')).toBe(true);
  });
});

describe('offline banners', () => {
  it('stale banner names the host and how old the cache is', () => {
    const twoHoursAgo = new Date('2026-06-29T00:00:00Z').getTime() - 2 * 3_600_000;
    const msg = formatStaleBanner('mac-mini', twoHoursAgo);
    expect(msg).toContain('mac-mini');
    expect(msg.toLowerCase()).toContain('cached');
  });

  it('unreachable message names the host and the cause', () => {
    const msg = formatUnreachable('mac-mini');
    expect(msg).toContain('mac-mini');
    expect(msg.toLowerCase()).toContain('unreachable');
  });
});

describe('remote cache freshness (RUSH-2062 — reachable host skips SSH)', () => {
  it('isRemoteCacheFresh is true only inside the max-age window', () => {
    expect(isRemoteCacheFresh(1000, 1000 + REMOTE_CACHE_MAX_AGE_MS, REMOTE_CACHE_MAX_AGE_MS)).toBe(true);
    expect(isRemoteCacheFresh(1000, 1000 + REMOTE_CACHE_MAX_AGE_MS + 1, REMOTE_CACHE_MAX_AGE_MS)).toBe(false);
  });

  it('write + read with maxAge serves a fresh entry (reachable path skips SSH)', () => {
    const host = `test-host-fresh-${process.pid}`;
    const args = ['sessions', '--active', '--json', `q-${Date.now()}`];
    writeRemoteCache(host, args, 'SESSION_ROWS_OK\n');
    const hit = readRemoteCache(host, args, { maxAgeMs: REMOTE_CACHE_MAX_AGE_MS, nowMs: Date.now() });
    expect(hit).not.toBeNull();
    expect(hit!.output).toBe('SESSION_ROWS_OK\n');
  });

  it('read with maxAge returns null for a deliberately aged entry', () => {
    const host = `test-host-stale-${process.pid}`;
    const args = ['sessions', '--active', '--json', `stale-${Date.now()}`];
    writeRemoteCache(host, args, 'OLD_ROWS\n');
    const p = remoteCachePath(host, args);
    const old = (Date.now() - REMOTE_CACHE_MAX_AGE_MS - 5_000) / 1000;
    fs.utimesSync(p, old, old);
    const hit = readRemoteCache(host, args, { maxAgeMs: REMOTE_CACHE_MAX_AGE_MS, nowMs: Date.now() });
    expect(hit).toBeNull();
    const anyAge = readRemoteCache(host, args);
    expect(anyAge?.output).toBe('OLD_ROWS\n');
  });

  it('serveWarmRemoteCache writes stdout for a fresh hit and returns true', () => {
    const host = `test-host-serve-${process.pid}`;
    const args = ['sessions', `serve-${Date.now()}`];
    writeRemoteCache(host, args, 'WARM_OUT\n');
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: typeof process.stdout.write }).write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(serveWarmRemoteCache(host, args, { nowMs: Date.now() })).toBe(true);
      expect(chunks.join('')).toBe('WARM_OUT\n');
    } finally {
      process.stdout.write = orig;
    }
  });

  it('replayRemoteCache serves any-age cache with a stale banner on stderr', () => {
    const host = `test-host-replay-${process.pid}`;
    const args = ['sessions', `replay-${Date.now()}`];
    writeRemoteCache(host, args, 'REPLAY_OUT\n');
    const out: string[] = [];
    const err: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout as { write: typeof process.stdout.write }).write = ((c: string | Uint8Array) => {
      out.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    }) as typeof process.stdout.write;
    (process.stderr as { write: typeof process.stderr.write }).write = ((c: string | Uint8Array) => {
      err.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(replayRemoteCache(host, args)).toBe(true);
      expect(out.join('')).toBe('REPLAY_OUT\n');
      expect(err.join('').toLowerCase()).toContain('cached');
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
  });
});
