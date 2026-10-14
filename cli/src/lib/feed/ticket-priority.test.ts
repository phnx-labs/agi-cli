import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TICKET_PRIORITY_TTL_MS, cachedTicketPriority } from './ticket-priority.js';
import type { LinearExec } from '../quick-todo.js';

describe('cachedTicketPriority', () => {
  let dir: string;
  let calls: string[][];
  const prev = process.env.AGENTS_LINEAR_CACHE_PATH;
  const linear = (priority: unknown): LinearExec => async (args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ identifier: args[1], priority }), stderr: '' };
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-priority-'));
    process.env.AGENTS_LINEAR_CACHE_PATH = dir;
    calls = [];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENTS_LINEAR_CACHE_PATH; else process.env.AGENTS_LINEAR_CACHE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('answers unknown first, reads Linear once in the background, then serves the cache until the TTL', async () => {
    expect(cachedTicketPriority('PHNX-1', 0, linear(1))).toBeUndefined();
    expect(cachedTicketPriority('PHNX-1', 1, linear(1))).toBeUndefined();
    await settle();
    expect(calls).toEqual([['tasks', 'PHNX-1', '--json']]);
    expect(cachedTicketPriority('PHNX-1', 2, linear(1))).toBe(1);
    expect(cachedTicketPriority('PHNX-1', TICKET_PRIORITY_TTL_MS - 1, linear(1))).toBe(1);
    await settle();
    expect(calls).toHaveLength(1);
  });

  it('records a failed read as unknown for the TTL instead of retrying every pass', async () => {
    const failing: LinearExec = async (args) => { calls.push(args); throw new Error('linear: not signed in'); };
    expect(cachedTicketPriority('PHNX-2', 0, failing)).toBeUndefined();
    await settle();
    expect(cachedTicketPriority('PHNX-2', 1_000, failing)).toBeUndefined();
    await settle();
    expect(calls).toHaveLength(1);
  });
});
