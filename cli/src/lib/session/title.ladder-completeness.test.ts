import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionHeadline } from './title.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Rebuilt literals evade TypeScript because generatedTitle is optional; guard both ladder spellings textually.
const HAND_ROLLED = /\blabel\b[^;\n]{0,40}(\|\||\?\?)[^;\n]{0,40}\btopic\b/;

const REBUILT_LITERAL = /\blabel\s*:[^,;]{1,40},[^;]{0,60}\btopic\s*:/;

// ladder-exempt is deliberately per-line; whole-file exemptions are only non-headline subsystems.
const LADDER_EXEMPT_MARKER = 'ladder-exempt';

const EXEMPT_FILES: Array<{ file: string; why: string }> = [
  { file: 'lib/session/db.ts', why: 'populates the FTS session_text search index, not a rendered headline' },
  { file: 'lib/traces/sync.ts', why: 'the Phoenix Evals console shard — a distinct consumer with its own Untitled fallback' },
];

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


  it('the per-line marker is load-bearing — an UNMARKED hand-rolled ladder is still caught in a headline file', () => {
    const sample = [
      `const a = s.label || s.topic;`,
      `const b = s.label || s.topic; // ladder-exempt: not a headline`,
      `// ladder-exempt: not a headline`,
      `const c = s.label || s.topic;`,
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
