import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { updateMeta } from '../state.js';
import { backfillActiveRowsFromMeta, type ActiveSession } from './active.js';
import { getSessionById, upsertSessionsBatch, closeDB } from './db.js';
import { SessionWatchState, toSessionWatchRow, toPreviousSessionWatchRow } from './remote/watch.js';
import type { SessionMeta } from './types.js';

beforeAll(() => {
  const native = JSON.parse(fs.readFileSync(new URL('./testdata/account-labels.json', import.meta.url), 'utf8'));
  updateMeta(meta => ({ ...meta, accounts: { ...meta.accounts, native } }));
});
afterAll(() => closeDB());

describe('indexed account slot label on live/watch rows (PHNX-4218)', () => {
  it.each([
    ['recorded slot', 'claude', { accountId: 'team', account: 'same@example.test' }, 'work'],
    ['org and email', 'claude', { accountKey: 'claude:org=personal', account: 'same@example.test' }, 'gmail'],
    ['org without email', 'claude', { accountKey: 'claude:org=personal' }, undefined],
    ['org with unregistered email', 'claude', { accountKey: 'claude:org=personal', account: 'other@example.test' }, undefined],
    ['exact org-only key without email', 'claude', { accountKey: 'claude:org=org-only' }, undefined],
    ['exact org-only key with email', 'claude', { accountKey: 'claude:org=org-only', account: 'org@example.test' }, 'org'],
    ['full identity', 'codex', { accountKey: 'codex:account=two' }, 'code'],
    ['unique email', 'codex', { account: 'code@example.test' }, 'code'],
    ['ambiguous email', 'claude', { account: 'same@example.test' }, undefined],
    ['unknown email', 'claude', { account: 'unknown@example.test' }, undefined],
    ['missing slot must not use email', 'codex', { accountId: 'removed', account: 'code@example.test' }, undefined],
    ['unknown key must not use email', 'codex', { accountKey: 'codex:account=other', account: 'code@example.test' }, undefined],
    ['wrong harness', 'claude', { accountId: 'codex' }, undefined],
    ['no identity', 'claude', {}, undefined],
  ] as const)('%s', (_case, agent, identity, label) => {
    const id = `account-label-${_case}`;
    const filePath = path.join(process.env.HOME!, `${id}.jsonl`);
    fs.copyFileSync(new URL('./testdata/timeline-claude.jsonl', import.meta.url), filePath);
    const meta: SessionMeta = { id, shortId: id, agent, timestamp: new Date().toISOString(), filePath, messageCount: 1, ...identity };
    upsertSessionsBatch([{ meta, content: '' }]);
    const indexed = getSessionById(id)!;
    expect(indexed).not.toBeNull();
    const row: ActiveSession = { context: 'terminal', kind: agent, sessionId: id, status: 'running' };
    backfillActiveRowsFromMeta([row], new Map([[id, indexed]]));
    expect(row.account).toBe(indexed.account);
    expect(row.accountLabel).toBe(label);
    expect(toSessionWatchRow('test-device', row).accountLabel).toBe(label);
    expect(toPreviousSessionWatchRow('test-device', indexed).accountLabel).toBe(label);
    const reset = new SessionWatchState().reset('test-device', [], [indexed]);
    if (reset.type !== 'reset') throw new Error('expected reset');
    expect(reset.rows[0].accountLabel).toBe(label);
  });
});
