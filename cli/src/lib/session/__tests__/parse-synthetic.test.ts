/**
 * Harness-injected `role=user` scaffolding must not be treated as a genuine user
 * turn. A Claude session opened with a `!`-prefix command (`j <dir>`) stores
 * `<bash-input>`/`<bash-stdout>` as user records; before the `_synthetic` flag
 * these were counted by `--first`/`--last` and returned by `--include user`, so
 * `--include user --first 1` returned the jump command instead of the real ask.
 * Fixture is synthetic — no user data.
 */

import { describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSession } from '@phnx-labs/sessions-cli/reader';
import { filterEvents } from '@phnx-labs/sessions-cli/reader';

function writeClaudeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-'));
  const file = path.join(dir, 'session.jsonl');
  const lines = [
    { type: 'user', timestamp: '2026-08-01T00:00:00Z', message: { role: 'user', content: '<bash-input>j agents-cli</bash-input>' } },
    { type: 'user', timestamp: '2026-08-01T00:00:01Z', message: { role: 'user', content: '<bash-stdout>/home/u/agents-cli</bash-stdout><bash-stderr></bash-stderr>' } },
    { type: 'user', timestamp: '2026-08-01T00:00:02Z', message: { role: 'user', content: '<system-reminder>The user named this session Foo.</system-reminder>' } },
    { type: 'user', timestamp: '2026-08-01T00:00:03Z', message: { role: 'user', content: 'Refactor the auth module and add tests.' } },
    { type: 'assistant', timestamp: '2026-08-01T00:00:04Z', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } },
    { type: 'user', timestamp: '2026-08-01T00:00:05Z', message: { role: 'user', content: 'Also update the docs.' } },
  ];
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n'));
  return file;
}

describe('parseSession flags harness-injected user turns as _synthetic', () => {
  test('bash-input / bash-stdout / system-reminder are marked, real asks are not', () => {
    const events = parseSession(writeClaudeFixture(), 'claude');
    const userMsgs = events.filter(e => e.type === 'message' && e.role === 'user');
    // 3 injected + 2 real user messages survive parsing.
    const synthetic = userMsgs.filter(e => e._synthetic);
    const genuine = userMsgs.filter(e => !e._synthetic);
    expect(synthetic.map(e => e.content)).toEqual([
      '<bash-input>j agents-cli</bash-input>',
      '<bash-stdout>/home/u/agents-cli</bash-stdout><bash-stderr></bash-stderr>',
      '<system-reminder>The user named this session Foo.</system-reminder>',
    ]);
    expect(genuine.map(e => e.content)).toEqual([
      'Refactor the auth module and add tests.',
      'Also update the docs.',
    ]);
  });

  test('--include user drops synthetic scaffolding', () => {
    const events = parseSession(writeClaudeFixture(), 'claude');
    const userOnly = filterEvents(events, { include: ['user'] });
    expect(userOnly.map(e => e.content)).toEqual([
      'Refactor the auth module and add tests.',
      'Also update the docs.',
    ]);
  });

  test('--first 1 returns the first REAL turn, not the jump command', () => {
    const events = parseSession(writeClaudeFixture(), 'claude');
    // First genuine turn = the "Refactor…" ask through just before the next real turn.
    const firstTurn = filterEvents(events, { first: 1 });
    const userInFirst = firstTurn.filter(e => e.type === 'message' && e.role === 'user' && !e._synthetic);
    expect(userInFirst.map(e => e.content)).toEqual(['Refactor the auth module and add tests.']);
    // The synthetic scaffolding still precedes it in the full-fidelity slice…
    expect(firstTurn.some(e => e.content === '<bash-input>j agents-cli</bash-input>')).toBe(true);
    // …but the second genuine ask is beyond the first turn boundary.
    expect(firstTurn.some(e => e.content === 'Also update the docs.')).toBe(false);
  });

  test('--include user --first 1 yields only the first real ask', () => {
    const events = parseSession(writeClaudeFixture(), 'claude');
    const out = filterEvents(events, { include: ['user'], first: 1 });
    expect(out.map(e => e.content)).toEqual(['Refactor the auth module and add tests.']);
  });

  test('--exclude user drops synthetic scaffolding too (it is user-role noise)', () => {
    // Regression: synthetic events must not leak through --exclude user. They
    // map to role=user, so excluding "user" drops both genuine and synthetic.
    const events = parseSession(writeClaudeFixture(), 'claude');
    const out = filterEvents(events, { exclude: ['user'] });
    expect(out.some(e => e.role === 'user')).toBe(false);
    expect(out.some(e => e.content?.startsWith('<bash-input>'))).toBe(false);
    expect(out.map(e => e.content)).toEqual(['On it.']); // only the assistant turn
  });

  test('the default stream (no filter) keeps synthetic events for full fidelity', () => {
    const events = parseSession(writeClaudeFixture(), 'claude');
    const out = filterEvents(events, {});
    expect(out.some(e => e.content === '<bash-input>j agents-cli</bash-input>')).toBe(true);
  });
});
