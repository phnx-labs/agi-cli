/**
 * PHNX-3320 — `agents --help` hid 29 of 69 groups, including `ssh` (5th most
 * used). Compact help stays a 10-group front door; `--help --all` lists the
 * real registered tree. This spawns the CLI entry so it cannot pass against a
 * hand-built Commander stub.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FRONT_DOOR } from './help.js';
import { buildFullCommandTree, visibleTopLevelGroups } from '../cli/command-registry.js';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TWO_COLUMN = /^\s{2,6}[a-z][a-z0-9_:-]+\s{2,}/;

function twoColumnNames(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => TWO_COLUMN.test(line))
    .map((line) => line.trim().split(/\s+/)[0]!);
}

function runHelp(args: string[]): { stdout: string; status: number | null; stderr: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-help-home-'));
  fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents: {}\n');
  const result = spawnSync('node', ['--import', 'tsx', 'src/index.ts', ...args], {
    cwd: CLI_ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENTS_SKIP_MIGRATION: '1',
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
      NO_COLOR: '1',
    },
    encoding: 'utf-8',
  });
  fs.rmSync(home, { recursive: true, force: true });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe('agents --help (PHNX-3320)', { timeout: 30_000 }, () => {
  it('compact help names the front door, points at --all, and stays at most 12 two-column rows', () => {
    const { stdout, status } = runHelp(['--help']);

    expect(status).toBe(0);
    expect(stdout).toContain('Usage: agents [command] [options]');
    expect(stdout).toContain('Start here:');
    expect(stdout).toContain('Every day:');
    expect(stdout).toContain('agents --help --all');

    const names = twoColumnNames(stdout);
    expect(names.length).toBeLessThanOrEqual(12);
    for (const group of Object.keys(FRONT_DOOR)) {
      expect(stdout, `${group} must appear as a leading help token`).toMatch(
        new RegExp(`^\\s{2,6}${group}(?![\\w-])`, 'm'),
      );
    }
    // The bug: these groups were never named, and there was no pointer.
    expect(names).not.toContain('ssh');
    expect(names).not.toContain('repos');
    expect(names).not.toContain('computer');
    expect(names).not.toContain('notify');
    expect(stdout).not.toMatch(/^\s{2,6}ssh(?![\w-])/m);
  });

  it('agents --help --all names every visible group, including ssh/repos/computer/notify', async () => {
    const { stdout, status, stderr } = runHelp(['--help', '--all']);
    expect(status, stderr).toBe(0);
    expect(stdout).toContain('All command groups:');

    const named = new Set(twoColumnNames(stdout));
    for (const missing of ['ssh', 'repos', 'computer', 'notify']) {
      expect(named.has(missing), `${missing} must appear as a two-column row`).toBe(true);
    }

    const tree = await buildFullCommandTree();
    const groups = visibleTopLevelGroups(tree);
    expect(groups.length).toBeGreaterThanOrEqual(69);
    const unseen = groups.map((g) => g.name).filter((name) => !named.has(name));
    expect(unseen).toEqual([]);
  });
});
