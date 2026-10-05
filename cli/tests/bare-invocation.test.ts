import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Regression: bare `agents` must print root help. The lazy-startup path registers no subcommands
// and commander only auto-shows help when they exist, so without the bare-invocation branch in
// src/index.ts the CLI exits silently.
describe('bare `agents` invocation', () => {
  it('prints the root help instead of exiting silently', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-bare-home-'));
    // A populated config makes this a non-first-run home; spawnSync is non-TTY
    // anyway, so the interactive setup path cannot trigger.
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents: {}\n');

    const result = spawnSync('node', ['--import', 'tsx', 'src/index.ts'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AGENTS_SKIP_MIGRATION: '1',
      },
      encoding: 'utf-8',
    });

    expect(result.stdout).toContain('Usage: agents [options] [command]');
    expect(result.stdout).toContain('Quick start:');
    expect(result.status).toBe(0);
  });
});
