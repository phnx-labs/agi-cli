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
 * A REBUILT session object: an object literal that re-lists `label` and `topic`
 * as properties. TypeScript does not flag a missing OPTIONAL property, so such a
 * literal silently drops `generatedTitle` and degrades the headline to the raw
 * topic — even though the receiving signature names the field. The `agents
 * sessions fork` call site did exactly this (PHNX-3797). Pass the session whole
 * instead of re-listing its fields.
 */
const REBUILT_LITERAL = /\blabel\s*:[^,;]{1,40},[^;]{0,60}\btopic\s*:/;

/**
 * Marker a single line carries when its `label ... topic` is a REVIEWED
 * non-headline use — put it on the line, or the line directly above, with a
 * reason: `// ladder-exempt: <why>`. This is deliberately per-LINE, not
 * per-file: `commands/sessions.ts` and `lib/session/active.ts` are the very
 * files that shipped this bug eight times, so a whole-file pass would hand the
 * highest-churn headline code a standing silencer and defeat the guard for
 * every future edit. A marker exempts exactly one line and no more.
 */
const LADDER_EXEMPT_MARKER = 'ladder-exempt';

/**
 * Whole-file exemptions reserved for subsystems that are NOT the session
 * headline at all — a different consumer with its own contract. Keep this list
 * to genuine cross-subsystem boundaries; a line inside a headline-rendering file
 * uses {@link LADDER_EXEMPT_MARKER} instead, so the rest of that file stays
 * guarded. (The three ladder implementations themselves — `deriveSessionRecap`,
 * `sessionHeadline`, `previousRowTitle` — need no entry: their own
 * `label || generatedTitle || topic` lines name `generatedTitle` and are skipped
 * by the check below.)
 */
const EXEMPT_FILES: Array<{ file: string; why: string }> = [
  { file: 'lib/session/db.ts', why: 'populates the FTS session_text search index, not a rendered headline' },
  { file: 'lib/traces/sync.ts', why: 'the Phoenix Evals console shard — a distinct consumer with its own Untitled fallback' },
];

/**
 * True when line `i` hand-rolls / rebuilds a headline ladder without the
 * `generatedTitle` rung and is not exempted (a docblock, a `generatedTitle`-naming
 * line, or a {@link LADDER_EXEMPT_MARKER} on the line or directly above it). The
 * ONE predicate both the file scan and its own proof-test use, so they can never
 * drift apart.
 */
function flagsLadderViolation(lines: string[], i: number): boolean {
  const line = lines[i];
  const code = line.trim();
  if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return false;
  if (line.includes('generatedTitle')) return false;
  if (line.includes(LADDER_EXEMPT_MARKER) || (i > 0 && lines[i - 1].includes(LADDER_EXEMPT_MARKER))) return false;
  return HAND_ROLLED.test(line) || REBUILT_LITERAL.test(line);
}

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
    expect(sessionHeadline({ label: undefined, generatedTitle: 'b', topic: 'c' })).toBe('b');
    expect(sessionHeadline({ label: undefined, generatedTitle: undefined, topic: 'c' })).toBe('c');
  });

  // The TYPE half of this guard — that a projection which dropped
  // `generatedTitle` cannot be passed to sessionHeadline at all — is asserted in
  // `title.ts` itself (`_rungLessRowIsRejected` / `_realCarrierIsAccepted`),
  // because `tsconfig.json` excludes `src/**\/*.test.ts` and a test therefore
  // cannot typecheck anything without spawning its own compiler. This file used
  // to do exactly that, and one `tsc` subprocess cost ~15s of the required
  // check's 240s budget — the single slowest thing PHNX-3797 added. Moving the
  // assertion into typechecked source made it both free and STRONGER: it now
  // runs on every `bun run build`, not only on the CI runs where impact
  // selection happens to pick this test file up. Both directions are
  // mutation-proven (weakening the guard to `T`, and over-tightening it to
  // `never`, each break the build).

  it('the per-line marker is load-bearing — an UNMARKED hand-rolled ladder is still caught in a headline file', () => {
    // Proof the narrowing (whole-file exemption → per-line marker) did not turn
    // into a blanket silencer: only the unmarked offender is flagged; a marker on
    // the line, or on the line directly above, exempts exactly that one line.
    const sample = [
      `const a = s.label || s.topic;`,                                 // 0: offender
      `const b = s.label || s.topic; // ladder-exempt: not a headline`, // 1: marked inline
      `// ladder-exempt: not a headline`,                              // 2: marker line
      `const c = s.label || s.topic;`,                                 // 3: marked by line above
    ];
    const flagged = sample.map((_, i) => i).filter((i) => flagsLadderViolation(sample, i));
    expect(flagged).toEqual([0]);
  });

  it('no source file re-derives OR rebuilds a headline without the generatedTitle rung', () => {
    const exemptFiles = new Set(EXEMPT_FILES.map((e) => path.join(SRC, e.file)));
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (exemptFiles.has(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (flagsLadderViolation(lines, i)) {
          offenders.push(`${path.relative(SRC, file)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      'these render a session headline without the generatedTitle rung — call sessionHeadline() ' +
      'from lib/session/title.ts, or add a justified entry to EXEMPT if it is not a headline',
    ).toEqual([]);
  });
});
