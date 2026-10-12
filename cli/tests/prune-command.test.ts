import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entrypoint = path.join(repoRoot, 'src', 'index.ts');

function runCli(args: string[]): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-prune-help-'));
  fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents: {}\n');
  try {
    return execFileSync('node', [tsxCli, entrypoint, ...args], {
      cwd: repoRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AGENTS_SKIP_MIGRATION: '1',
        AGENTS_NO_AUTOPULL: '1',
        AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
        NO_COLOR: '1',
      },
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('prune command', () => {
  it('surfaces prune in the full group listing (agents --help --all)', () => {
    const helpText = runCli(['--help', '--all']);

    expect(helpText).toMatch(/^\s{2}prune\s{2,}/m);
    expect(helpText).toMatch(/Uninstall/i);
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
