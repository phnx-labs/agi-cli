import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const cliDir = path.resolve(__dirname, '..', '..');
const entrypoint = path.join(cliDir, 'src', 'index.ts');

function runTodo(args: string[]): { code: number; stdout: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-todo-'));
  fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
  try {
    const stdout = execFileSync('bun', [entrypoint, 'projects', 'todo', ...args], {
      cwd: cliDir,
      env: { ...process.env, HOME: home, AGENTS_NO_AUTOPULL: '1', AGENTS_SKIP_MIGRATION: '1', AGENTS_CLI_DISABLE_AUTO_UPDATE: '1' },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '' };
  }
}

describe('agents projects todo', () => {
  it('answers an invalid issue id with the ok:false JSON every verb prints, and exit 1', () => {
    for (const verb of ['done', 'undo']) {
      const { code, stdout } = runTodo([verb, 'not-an-id', '--json']);
      expect(code).toBe(1);
      expect(JSON.parse(stdout)).toEqual({ ok: false, todo: null, message: 'Expected a Linear issue identifier like PHNX-123, got "not-an-id".' });
    }
  });

  it('refuses a line that is only tokens without creating anything', () => {
    const { code, stdout } = runTodo(['add', '--json', '--', '#AGI tomorrow !!']);
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, todo: null });
  });
});
