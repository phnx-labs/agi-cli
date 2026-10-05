import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, mkdtempSync, writeFileSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as state from '../state.js';

let CACHE_ROOT: string = mkdtempSync(join(tmpdir(), 'agents-cli-progress-boot-'));
vi.spyOn(state, 'getCacheDir').mockImplementation(() => CACHE_ROOT);

const { sshReachable } = await import('../ssh-exec.js');
const {
  exitMarker,
  splitProgressBytes,
  mirrorAliasesSource,
  buildStreamingFollowCommand,
  parseStreamingExitFrame,
  followHostTask,
  buildWindowsProgressCommand,
} = await import('./progress.js');
const { localLogPath } = await import('./tasks.js');

const LOCALHOST_SSH = sshReachable('localhost', 5000);

it('builds a byte-accurate Windows log/exit poll from the requested offset', () => {
  const command = buildWindowsProgressCommand({
    remoteLog: '$HOME/.agents/.cache/hosts/abc.log',
    remoteExit: '$HOME/.agents/.cache/hosts/abc.exit',
    taskId: 'abc',
    offset: 17,
  });
  const encoded = command.match(/-EncodedCommand (\S+)$/)?.[1];
  const script = Buffer.from(encoded!, 'base64').toString('utf16le');
  expect(script).toContain('$out.Write($bytes, 17, $bytes.Length - 17)');
  expect(script).toContain("Join-Path $HOME '.agents/.cache/hosts/abc.log'");
  const marker = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
  expect(Buffer.from(marker!, 'base64').toString('utf8')).toBe(exitMarker('abc'));
});

beforeEach(() => {
  CACHE_ROOT = mkdtempSync(join(tmpdir(), 'agents-cli-progress-'));
  mkdirSync(join(CACHE_ROOT, 'hosts'), { recursive: true });
  mkdirSync(join(CACHE_ROOT, 'ssh'), { recursive: true, mode: 0o700 });
});

afterEach(() => {
  rmSync(CACHE_ROOT, { recursive: true, force: true });
});

describe('exitMarker', () => {
  it('embeds the task id so it cannot collide with generic output', () => {
    expect(exitMarker('a1b2c3d4')).toBe('\n@@AGENTS_HOST_EXIT_a1b2c3d4@@\n');
  });
});

describe('splitProgressBytes', () => {
  const id = 'a1b2c3d4';
  const M = exitMarker(id);
  const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

  it('splits log bytes from the exit code in a single combined fetch', () => {
    const r = splitProgressBytes(buf(`hello world${M}0`), id)!;
    expect(r.logChunk.toString('utf8')).toBe('hello world');
    expect(r.exit.toString('utf8')).toBe('0');
    expect(r.consumed).toBe(11);
  });

  it('returns an empty exit while the job is still running', () => {
    const r = splitProgressBytes(buf(`some streamed output${M}`), id)!;
    expect(r.logChunk.toString('utf8')).toBe('some streamed output');
    expect(r.exit.toString('utf8')).toBe('');
  });

  it('reports an empty log chunk when there is no new output', () => {
    const r = splitProgressBytes(buf(`${M}`), id)!;
    expect(r.logChunk.length).toBe(0);
    expect(r.consumed).toBe(0);
    expect(r.exit.toString('utf8')).toBe('');
  });

  it('returns null when the marker is absent (transient fetch miss)', () => {
    expect(splitProgressBytes(buf('partial ssh output'), id)).toBeNull();
    expect(splitProgressBytes(buf(''), id)).toBeNull();
  });

  it('splits on the LAST marker so a token echoed in the log cannot spoof the boundary', () => {
    const echoed = `agent printed ${M} in its output`;
    const r = splitProgressBytes(buf(`${echoed}${M}137`), id)!;
    expect(r.exit.toString('utf8')).toBe('137');
    expect(r.logChunk.toString('utf8')).toBe(echoed);
  });

  it('is scoped per task id — another run’s marker is not treated as ours', () => {
    const other = exitMarker('ffffffff');
    expect(splitProgressBytes(buf(`log body${other}0`), id)).toBeNull();
  });

  it('counts exact wire bytes when a multibyte char precedes the marker', () => {
    const r = splitProgressBytes(buf(`héllo${M}0`), id)!;
    expect(r.consumed).toBe(6);
    expect(r.logChunk.length).toBe(6);
    expect(r.logChunk.toString('utf8')).toBe('héllo');
  });

  it('counts a multibyte char truncated at the buffer end by its raw bytes', () => {
    const half = buf('café').subarray(0, 4);
    const combined = Buffer.concat([half, Buffer.from(M, 'utf8')]);
    const r = splitProgressBytes(combined, id)!;
    expect(r.consumed).toBe(4);
    expect(r.logChunk.length).toBe(4);
  });
});

describe('mirrorAliasesSource', () => {
  it('flags aliasing when local and remote are the same file (localhost host)', () => {
    expect(mirrorAliasesSource('66306:1234567', '66306:1234567')).toBe(true);
  });

  it('does not flag distinct files (a genuine remote host)', () => {
    expect(mirrorAliasesSource('66306:1234567', '2049:9999999')).toBe(false);
  });

  it('does not flag when either identity is unknown', () => {
    expect(mirrorAliasesSource(null, '2049:9999999')).toBe(false);
    expect(mirrorAliasesSource('66306:1234567', null)).toBe(false);
    expect(mirrorAliasesSource(null, null)).toBe(false);
  });
});

describe('streaming follow protocol', () => {
  it('builds a remote tail stream that sends the exit frame on stderr', () => {
    const command = buildStreamingFollowCommand({
      remoteLog: '$HOME/.agents/.cache/hosts/a1b2c3d4.log',
      remoteExit: '$HOME/.agents/.cache/hosts/a1b2c3d4.exit',
      taskId: 'a1b2c3d4',
      offset: 12,
    });

    expect(command).toContain('tail -c +13 -f $HOME/.agents/.cache/hosts/a1b2c3d4.log');
    expect(command).toContain('while [ ! -s $HOME/.agents/.cache/hosts/a1b2c3d4.exit ]');
    expect(command).toContain("printf '\\n@@AGENTS_HOST_EXIT_a1b2c3d4@@\\n' >&2");
    expect(command).toContain('cat $HOME/.agents/.cache/hosts/a1b2c3d4.exit >&2 2>/dev/null');
    expect(command).toContain('trap cleanup EXIT HUP INT TERM');
  });

  it('parses the final stderr frame without treating preceding stderr as log bytes', () => {
    const stderr = Buffer.from(`ssh warning${exitMarker('a1b2c3d4')}137\n`, 'utf8');

    expect(parseStreamingExitFrame(stderr, 'a1b2c3d4')?.toString('utf8')).toBe('137\n');
    expect(parseStreamingExitFrame(Buffer.from('ssh warning', 'utf8'), 'a1b2c3d4')).toBeNull();
  });
});

describe.skipIf(!LOCALHOST_SSH)('followHostTask streaming over real ssh (localhost)', () => {
  it('streams log bytes live, mirrors them locally, and returns the remote exit code', async () => {
    const taskId = 'stream01';
    const remoteLog = join(CACHE_ROOT, 'remote-stream01.log');
    const remoteExit = join(CACHE_ROOT, 'remote-stream01.exit');
    writeFileSync(remoteLog, 'first\n');
    setTimeout(() => {
      appendFileSync(remoteLog, 'second\n');
      writeFileSync(remoteExit, '7\n');
    }, 250);

    const code = await followHostTask('localhost', {
      remoteLog,
      remoteExit,
      taskId,
      pollMs: 100,
      maxPollMs: 200,
      timeoutMs: 5000,
    });

    expect(code).toBe(7);
    expect(readFileSync(localLogPath(taskId), 'utf8')).toBe('first\nsecond\n');
  });
});
