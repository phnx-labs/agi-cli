import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entrypoint = path.join(repoRoot, 'src', 'index.ts');

function runCli(args: string[]): string {
  return execFileSync('node', [tsxCli, entrypoint, ...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      NO_COLOR: '1',
    },
  });
}

describe('prune command', () => {
  it('surfaces prune in the complete help, pointed to from the curated root help', () => {
    const rootHelp = runCli(['--help']);
    expect(rootHelp).toContain('--help-all');

    const helpText = runCli(['--help-all']);
    expect(helpText).toContain('prune [options] <specs...>');
    expect(helpText).toContain('Uninstall agent CLI versions');
  });

  it('shows dedicated help for version prune', () => {
    const helpText = runCli(['prune', '--help']);

    expect(helpText).toContain('Usage: agents prune [options] <specs...>');
    expect(helpText).toContain('Uninstall agent CLI versions');
    expect(helpText).toContain('agents prune claude@2.0.50');
    expect(helpText).toContain('agents prune claude');
    expect(helpText).toContain('cleanup [options] [target]');
    expect(helpText).not.toContain('Usage: agents [command] [options]');
  });

  it('shows remove as an alias for version prune', () => {
    const helpText = runCli(['remove', '--help']);

    expect(helpText).toContain('Usage: agents remove [options] <specs...>');
    expect(helpText).toContain('Alias for agents prune');
    expect(helpText).toContain('agents remove claude@2.0.50');
  });

  it('moves destructive cleanup help under agents prune cleanup', () => {
    const helpText = runCli(['prune', 'cleanup', '--help']);

    expect(helpText).toContain('Usage: agents prune cleanup [options] [target]');
    expect(helpText).toContain('--dry-run');
    expect(helpText).toContain('agents prune cleanup --dry-run');
    expect(helpText).toContain('agents prune cleanup claude');
    expect(helpText).toContain('agents prune cleanup skills');
    expect(helpText).not.toContain('Usage: agents [command] [options]');
  });

  it('shows dry-run support for view prune help', () => {
    const helpText = runCli(['view', '--help']);

    expect(helpText).toContain('--dry-run');
    expect(helpText).toContain('agents view --prune --dry-run');
    expect(helpText).toContain('With --prune --dry-run: preview only, no deletions');
  });
});
