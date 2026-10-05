import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-hosttasks-'));
process.env.HOME = TEST_HOME;

const { saveTask, findTaskBySessionId, findTaskByName } = await import('./tasks.js');
type HostTask = import('./tasks.js').HostTask;

function task(id: string, sessionId?: string, name?: string): HostTask {
  return {
    id,
    host: 'box',
    target: 'user@box',
    agent: 'claude',
    prompt: 'p',
    sessionId,
    name,
    remoteLog: `/r/${id}.log`,
    remoteExit: `/r/${id}.exit`,
    status: 'running',
    createdAt: new Date(Date.now() + parseInt(id, 36)).toISOString(),
  };
}

describe('findTaskBySessionId', () => {
  it('maps a captured session id back to the host task that launched it', () => {
    saveTask(task('aa', 'sess-aaaa'));
    saveTask(task('bb', 'sess-bbbb'));
    const found = findTaskBySessionId('sess-bbbb');
    expect(found?.id).toBe('bb');
    expect(found?.host).toBe('box');
  });

  it('returns null for an unknown session id', () => {
    expect(findTaskBySessionId('sess-missing')).toBeNull();
  });

  it('returns null for an empty query and never matches tasks with no session id', () => {
    saveTask(task('cc'));
    expect(findTaskBySessionId('')).toBeNull();
  });
});

describe('findTaskByName', () => {
  it('resolves a --name handle to its host task (case-insensitive)', () => {
    saveTask(task('d1', 'sess-d1', 'nightly-audit'));
    const found = findTaskByName('Nightly-Audit');
    expect(found?.id).toBe('d1');
  });

  it('returns the newest task when a name was reused across dispatches', () => {
    saveTask(task('e1', 'sess-e1', 'probe'));
    saveTask(task('e2', 'sess-e2', 'probe'));
    expect(findTaskByName('probe')?.id).toBe('e2');
  });

  it('returns null for an unknown name, an empty query, and unnamed tasks', () => {
    saveTask(task('f1', 'sess-f1'));
    expect(findTaskByName('nope')).toBeNull();
    expect(findTaskByName('')).toBeNull();
  });
});
