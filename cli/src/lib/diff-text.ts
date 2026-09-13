/**
 * Tiny unified-diff helpers for human-readable doctor output.
 *
 * Wraps the `diff` package's createPatch into one call that returns a
 * pre-coloured unified diff (red = removed, green = added, dim = context).
 * Used by `agents doctor --diff`.
 */

import chalk from 'chalk';
import { createPatch } from 'diff';

interface UnifiedDiffOptions {
  /** Number of context lines around each change (default: 3). */
  context?: number;
  /** Filename label shown in the patch header for the "expected" side. */
  fromLabel?: string;
  /** Filename label shown in the patch header for the "actual" side. */
  toLabel?: string;
}

/**
 * Build a unified-diff text comparing two strings. Returns an empty string
 * when contents are identical.
 */
export function unifiedDiff(
  expected: string,
  actual: string,
  options: UnifiedDiffOptions = {},
): string {
  if (expected === actual) return '';
  const fromLabel = options.fromLabel ?? 'expected';
  const toLabel = options.toLabel ?? 'actual';
  const context = options.context ?? 3;
  return createPatch(fromLabel, expected, actual, '', '', { context });
}

/**
 * Colour a unified-diff string for terminal output. Indents each line with
 * a constant prefix so it nests cleanly under a header.
 */
export function colorizeUnifiedDiff(patch: string, indent = '    '): string {
  const lines = patch.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('Index:') || line.startsWith('===')) {
      out.push(indent + chalk.gray(line));
    } else if (line.startsWith('@@')) {
      out.push(indent + chalk.cyan(line));
    } else if (line.startsWith('+')) {
      out.push(indent + chalk.green(line));
    } else if (line.startsWith('-')) {
      out.push(indent + chalk.red(line));
    } else {
      out.push(indent + chalk.gray(line));
    }
  }
  return out.join('\n');
}
