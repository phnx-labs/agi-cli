import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildFullCommandTree } from '../cli/command-registry.js';
import {
  isKnownTopLevelCommand,
  RETIRED_TOP_LEVEL_COMMANDS,
} from '../lib/startup/command-registry.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

let testHome: string | undefined;

afterEach(() => {
  if (testHome) {
    fs.rmSync(testHome, { recursive: true, force: true });
    testHome = undefined;
  }
});

function guardedHome(): string {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-inbox-retired-'));
  const systemDir = path.join(testHome, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
  return testHome;
}

describe('the retired top-level `agents inbox`', () => {
  it('is not registered on the real command tree', async () => {
    const program = await buildFullCommandTree();
    const names = program.commands.flatMap((c) => [c.name(), ...c.aliases()]);
    expect(names).not.toContain('inbox');
    expect(names).toContain('feed');
    expect(isKnownTopLevelCommand('inbox')).toBe(false);
    expect(RETIRED_TOP_LEVEL_COMMANDS.has('inbox')).toBe(true);
  });

  it('a bare `agents inbox` is an unknown command, not an auto-correct', () => {
    const home = guardedHome();
    const r = spawnSync('bun', [INDEX, 'inbox'], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: home,
        AGENTS_NO_UPDATE_CHECK: '1',
        AGENTS_SECRETS_PASSPHRASE: '',
      },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr ?? '').toMatch(/unknown command/i);
  });
});
