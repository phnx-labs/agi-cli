
import chalk from 'chalk';
import { createPatch } from 'diff';

interface UnifiedDiffOptions {
  context?: number;
  fromLabel?: string;
  toLabel?: string;
}

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
