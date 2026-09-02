/**
 * The headline ladder is a claim about EVERY surface, so it needs a test that
 * fails when a new surface re-derives its own ordering (PHNX-3797, SES-14c).
 *
 * The first version of this feature swept `sessions.ts` and the watch rows and
 * left eight other renders — the watchdog report, `agents cost`, the
 * browser/computer linked-session columns, `agents logs`, mailbox addressing,
 * and the fork recap — still computing `label || topic`. Each one silently drops
 * the `generatedTitle` rung, so a session with a generated title but no
 * `/rename` label reads one way in `agents sessions` and another everywhere
 * else. Nothing caught that but a human reading the diff; this does.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionHeadline } from './title.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * A hand-rolled ladder: `label` OR-ed straight into `topic`. `generatedTitle`
 * between them is the whole point, so its absence is the smell.
 */
const HAND_ROLLED = /\blabel\b[^;\n]{0,40}(\|\||\?\?)[^;\n]{0,40}\btopic\b/;

/**
 * Deliberate, reviewed exemptions — each is NOT a session headline. Keep this
 * list short and justified; a new entry needs a reason, not a silencer.
 */
const EXEMPT: Array<{ file: string; why: string }> = [
  { file: 'commands/sessions.ts', why: 'the compact --active preview base (preview || label || topic), a different field from the row title' },
  { file: 'lib/session/active.ts', why: 'deriveSessionRecap IS the ladder for live rows; orchestratorLabel runs before any index backfill' },
  { file: 'lib/session/title.ts', why: 'sessionHeadline IS the ladder for indexed rows' },
  { file: 'lib/session/remote/watch.ts', why: 'previousRowTitle IS the ladder for durable history rows' },
  { file: 'lib/session/db.ts', why: 'populates the FTS session_text search index, not a rendered headline' },
  { file: 'lib/traces/sync.ts', why: 'the Phoenix Evals console shard — a distinct consumer with its own Untitled fallback' },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'testdata') continue;
      sourceFiles(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.bench.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('the session headline ladder is the only ladder (SES-14c)', () => {
  it('resolves label > generatedTitle > topic', () => {
    expect(sessionHeadline({ label: 'a', generatedTitle: 'b', topic: 'c' })).toBe('a');
    expect(sessionHeadline({ generatedTitle: 'b', topic: 'c' })).toBe('b');
    expect(sessionHeadline({ topic: 'c' })).toBe('c');
  });

  it('no source file re-derives `label || topic` for a headline', () => {
    const exempt = new Set(EXEMPT.map((e) => path.join(SRC, e.file)));
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (exempt.has(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.includes('generatedTitle')) return;
        if (HAND_ROLLED.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      'these render a session headline without the generatedTitle rung — call sessionHeadline() ' +
      'from lib/session/title.ts, or add a justified entry to EXEMPT if it is not a headline',
    ).toEqual([]);
  });
});
