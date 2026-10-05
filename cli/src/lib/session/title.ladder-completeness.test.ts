/** The headline ladder claims to hold on every surface, so this test fails when a surface
 * re-derives its own order (PHNX-3797, SES-14c). */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionHeadline } from './title.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A hand-rolled ladder: `label` OR-ed straight into `topic`. The missing `generatedTitle`
 * between them is the smell. */
const HAND_ROLLED = /\blabel\b[^;\n]{0,40}(\|\||\?\?)[^;\n]{0,40}\btopic\b/;

/** A rebuilt session object literal re-listing `label` and `topic`. TypeScript does not flag a
 * missing optional property, so it silently drops `generatedTitle` (as `agents sessions fork` did,
 * PHNX-3797). Pass the session whole. */
const REBUILT_LITERAL = /\blabel\s*:[^,;]{1,40},[^;]{0,60}\btopic\s*:/;

/** Marker for a reviewed non-headline `label ... topic` use, on the line or directly above, with a
 * reason: `// ladder-exempt: <why>`. Per-line, not per-file: `sessions.ts` and `active.ts` shipped
 * this bug eight times, so a whole-file silencer would defeat the guard. */
const LADDER_EXEMPT_MARKER = 'ladder-exempt';

/** Whole-file exemptions only for subsystems that are not the session headline, with their own
 * contract. Lines in headline-rendering files use LADDER_EXEMPT_MARKER instead. */
const EXEMPT_FILES: Array<{ file: string; why: string }> = [
  { file: 'lib/session/db.ts', why: 'populates the FTS session_text search index, not a rendered headline' },
  { file: 'lib/traces/sync.ts', why: 'the Phoenix Evals console shard — a distinct consumer with its own Untitled fallback' },
];

/** True when line `i` hand-rolls or rebuilds a headline ladder without the `generatedTitle` rung
 * and is not exempt (docblock, line naming `generatedTitle`, or a marker on or above it). One
 * predicate shared by the scan and its proof-test. */
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

  // The type half of this guard is asserted in `title.ts` (`_rungLessRowIsRejected`,
  // `_realCarrierIsAccepted`): tests are excluded from tsconfig, and a `tsc` subprocess here cost
  // ~15s of the required check's 240s (PHNX-3797).

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
