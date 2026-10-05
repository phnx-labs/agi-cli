import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadReminders, pickReminderForSession } from './reminders.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reminders-'));
  file = path.join(dir, 'reminders.yaml');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadReminders', () => {
  it('returns [] when the file does not exist (not opted in)', () => {
    expect(loadReminders(path.join(dir, 'missing.yaml'))).toEqual([]);
  });

  it('parses short/full pairs and falls back full -> short', () => {
    fs.writeFileSync(
      file,
      [
        'reminders:',
        '  - short: "Move with confidence"',
        '    full: "Move with confidence; accept the consequences."',
        '  - short: "Behavior, not words"',
      ].join('\n'),
    );
    expect(loadReminders(file)).toEqual([
      { short: 'Move with confidence', full: 'Move with confidence; accept the consequences.' },
      { short: 'Behavior, not words', full: 'Behavior, not words' },
    ]);
  });

  it('skips entries with no short text', () => {
    fs.writeFileSync(file, ['reminders:', '  - full: "orphan full"', '  - short: "kept"'].join('\n'));
    expect(loadReminders(file)).toEqual([{ short: 'kept', full: 'kept' }]);
  });

  it('throws on a present-but-malformed file so the command can surface it', () => {
    fs.writeFileSync(file, 'not-a-reminders-doc: true');
    expect(() => loadReminders(file)).toThrow(/reminders:/);
  });
});

describe('pickReminderForSession', () => {
  const reminders = [
    { short: 'a', full: 'a' },
    { short: 'b', full: 'b' },
    { short: 'c', full: 'c' },
  ];

  it('returns null when there are no reminders', () => {
    expect(pickReminderForSession([], 'session-1')).toBeNull();
  });

  it('is deterministic — same session id always maps to the same reminder', () => {
    const first = pickReminderForSession(reminders, 'session-abc');
    const again = pickReminderForSession(reminders, 'session-abc');
    expect(again).toEqual(first);
  });

  it('spreads distinct session ids across the list', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const pick = pickReminderForSession(reminders, `session-${i}`);
      if (pick) seen.add(pick.short);
    }
    expect(seen).toEqual(new Set(['a', 'b', 'c']));
  });

  it('falls back to the first reminder when no session id is given', () => {
    expect(pickReminderForSession(reminders, undefined)?.short).toBe('a');
  });
});
