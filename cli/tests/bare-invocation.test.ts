import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('bare `agents` invocation', () => {
  it('prints the root help instead of exiting silently', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-bare-home-'));
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
