import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { parseState, writeStateAtomic, cleanupOrphanedStateFiles, stateFilePath } from '../src/state-file.js';
import type { SessionState } from '../src/types.js';

function tmpStateDir(): string {
  const dir = path.join(os.tmpdir(), `session-tracker-state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function deadPid(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    child.on('exit', () => resolve(child.pid!));
  });
}

function makeState(pid: number): SessionState {
  return {
    session_id: 'sess-123',
    agent: 'claude',
    cwd: '/tmp',
    pid,
    ts: Date.now(),
    method: 'hook-stdin',
  };
}

describe('parseState', () => {
  it('parses the canonical schema written by hook.sh', () => {
    const raw = JSON.stringify({
      session_id: 'aaaa-bbbb',
      agent: 'claude',
      cwd: '/x',
      pid: 123,
      ts: 1780000000000,
      method: 'hook-stdin',
      terminal_id: 'cl-1',
    });
    const s = parseState(raw);
    expect(s).not.toBeNull();
    expect(s!.session_id).toBe('aaaa-bbbb');
    expect(s!.agent).toBe('claude');
    expect(s!.terminal_id).toBe('cl-1');
  });

  it('parses the legacy 04-capture hook schema (no agent, no method)', () => {
    const raw = '{"session_id": "df106759-aaaa", "cwd": "/x", "pid": 35013, "ts": 1780964717}';
    const s = parseState(raw);
    expect(s).not.toBeNull();
    expect(s!.session_id).toBe('df106759-aaaa');
    expect(s!.agent).toBe('unknown');
    expect(s!.method).toBe('hook-stdin');
  });

  it('rejects missing session_id', () => {
    const raw = '{"cwd": "/x", "pid": 1, "ts": 1}';
    expect(parseState(raw)).toBeNull();
  });

  it('rejects malformed JSON', () => {
    expect(parseState('{not json')).toBeNull();
  });
});


describe('writeStateAtomic', () => {
  it('writes a valid state file and cleans up its temp file on failure', async () => {
    const dir = tmpStateDir();
    try {
      const state = makeState(process.pid);
      await writeStateAtomic(state, dir);

      const final = stateFilePath(process.pid, dir);
      expect(fs.existsSync(final)).toBe(true);
      expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);

      await writeStateAtomic({ ...state, ts: state.ts + 1 }, dir);
      const files = fs.readdirSync(dir);
      expect(files.filter((f) => f === `${process.pid}.json`)).toHaveLength(1);
      expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cleanupOrphanedStateFiles', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes dead-pid records, zero-byte JSON files, and orphaned temp files', async () => {
    const dir = tmpStateDir();
    dirs.push(dir);

    const dead = await deadPid();

    const liveState = makeState(process.pid);
    await writeStateAtomic(liveState, dir);

    fs.writeFileSync(path.join(dir, `${dead}.json`), JSON.stringify(makeState(dead)), 'utf8');

    fs.writeFileSync(path.join(dir, '999999.json'), '', 'utf8');

    fs.writeFileSync(path.join(dir, `.${dead}.abcdef`), 'orphan', 'utf8');

    fs.writeFileSync(path.join(dir, `.${process.pid}.uvwxyz`), 'in-flight', 'utf8');

    const removed = await cleanupOrphanedStateFiles(dir);
    expect(removed).toBe(3);

    const remaining = new Set(fs.readdirSync(dir));
    expect(remaining.has(`${process.pid}.json`)).toBe(true);
    expect(remaining.has(`.${process.pid}.uvwxyz`)).toBe(true);
    expect(remaining.has(`${dead}.json`)).toBe(false);
    expect(remaining.has('999999.json')).toBe(false);
    expect(remaining.has(`.${dead}.abcdef`)).toBe(false);
  });

  it('is a no-op when the state directory does not exist', async () => {
    const removed = await cleanupOrphanedStateFiles(path.join(os.tmpdir(), 'does-not-exist-' + Date.now()));
    expect(removed).toBe(0);
  });
});
