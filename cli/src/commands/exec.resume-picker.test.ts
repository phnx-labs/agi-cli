import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { spawn } from '@homebridge/node-pty-prebuilt-multiarch';
import { cliEntry, describeLive, tsxLoaderUrl, writeClaudeSession, writeUpdateCache } from './sessions.test-fixture.js';
import { claudeProjectDirName } from '../lib/project-key.js';

const NEW_ID = '11111111-1111-4111-8111-111111111111';
const OLD_ID = '22222222-2222-4222-8222-222222222222';
const ANCIENT_ID = '33333333-3333-4333-8333-333333333333';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describeLive('agents run <harness> --resume picker filters (real CLI, real PTY, indexed transcripts)', () => {
  let home: string;
  let project: string;
  let argvLog: string;
  let env: Record<string, string>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-run-resume-'));
    project = path.join(home, 'proj');
    writeUpdateCache(home);
    const key = claudeProjectDirName(project);
    const now = Date.now();
    writeClaudeSession(home, key, NEW_ID, project, 'newer task alpha', new Date(now - HOUR).toISOString());
    writeClaudeSession(home, key, OLD_ID, project, 'older task beta', new Date(now - 10 * DAY).toISOString());
    writeClaudeSession(home, key, ANCIENT_ID, project, 'ancient task gamma', new Date(now - 40 * DAY).toISOString());

    argvLog = path.join(home, 'argv.jsonl');
    const recorder = path.join(home, 'record-argv.mjs');
    fs.writeFileSync(
      recorder,
      "import fs from 'node:fs';\nfs.appendFileSync(process.env.AG_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');\n",
    );
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([k, v]) =>
        v !== undefined && !/^(AGENTS_|CLAUDE|CODEX|TMUX|TERM_PROGRAM|ITERM|VSCODE|GHOSTTY|KITTY|NODE_OPTIONS)/.test(k)),
    ) as Record<string, string>;
    env = {
      ...inherited,
      HOME: home,
      USERPROFILE: home,
      TERM: 'xterm-256color',
      AGENTS_SKIP_MIGRATION: '1',
      AG_ARGV_LOG: argvLog,
      NODE_OPTIONS: `--import ${tsxLoaderUrl} --import ${pathToFileURL(recorder).href}`,
    };
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function recordedRuns(): string[][] {
    if (!fs.existsSync(argvLog)) return [];
    return fs.readFileSync(argvLog, 'utf-8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as string[])
      .filter((argv) => argv[0] === 'run');
  }

  async function drive(args: string[], keys: (screen: string) => string | undefined): Promise<{ screen: string; exitCode: number }> {
    const child = spawn(process.execPath, [cliEntry, ...args], { cols: 160, rows: 40, cwd: project, env });
    return new Promise((resolve, reject) => {
      let captured = '';
      let step = 0;
      let lastKeyAt = 0;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`run --resume did not finish; after the last key:\n${JSON.stringify(captured.slice(lastKeyAt))}`));
      }, 45_000);
      child.onData((data) => {
        captured += data;
        const send = keys(stripVTControlCharacters(captured).slice(step));
        if (send !== undefined) {
          step = stripVTControlCharacters(captured).length;
          setTimeout(() => {
            lastKeyAt = captured.length;
            child.write(send);
          }, 300);
        }
      });
      child.onExit(({ exitCode }) => {
        clearTimeout(timer);
        resolve({ screen: stripVTControlCharacters(captured), exitCode });
      });
    });
  }

  function onceRendered(...needles: string[]): (screen: string) => string | undefined {
    const queue = [...needles];
    return (screen) => {
      if (queue.length === 0) return undefined;
      const [needle, key] = queue[0].split('=>');
      if (!screen.includes(needle)) return undefined;
      queue.shift();
      return key.replace('CTRLC', '\x03').replace('DOWN', '\x1b[B').replace('SPACE', ' ').replace('ENTER', '\r');
    };
  }

  it('keeps the 30d default, narrows with --since, and cancel launches nothing', async () => {
    const byDefault = await drive(['run', 'claude', '--resume'], onceRendered('older task beta=>CTRLC'));
    expect(byDefault.screen).toContain('newer task alpha');
    expect(byDefault.screen).toContain('older task beta');
    expect(byDefault.screen).not.toContain('ancient task gamma');

    const narrowed = await drive(['run', 'claude', '--resume', '--since', '2d'], onceRendered('newer task alpha=>CTRLC'));
    expect(narrowed.screen).not.toContain('older task beta');
    expect(narrowed.screen).not.toContain('ancient task gamma');

    expect(recordedRuns()).toEqual([
      ['run', 'claude', '--resume'],
      ['run', 'claude', '--resume', '--since', '2d'],
    ]);
  }, 120_000);

  it('--all lifts the window, -n caps the rows, and the chosen row resumes without the picker flags', async () => {
    const capped = await drive(['run', 'claude', '--resume', '--all', '-n', '1'], onceRendered('newer task alpha=>CTRLC'));
    expect(capped.screen).not.toContain('older task beta');

    const picked = await drive(
      ['run', 'claude', '--resume', '--all', '--limit=5', '--since', '60d', '--', '--all', '-n', '1'],
      onceRendered('ancient task gamma=>DOWNSPACE', 'older task beta=>ENTER'),
    );
    expect(picked.screen).toContain('ancient task gamma');

    const [, pickerRun, child, extra] = recordedRuns();
    expect(pickerRun).toEqual(['run', 'claude', '--resume', '--all', '--limit=5', '--since', '60d', '--', '--all', '-n', '1']);
    expect(child).toEqual(['run', 'claude', '--resume', OLD_ID, '--', '--all', '-n', '1']);
    expect(extra).toBeUndefined();
  }, 120_000);

  it('refuses the picker filters next to a concrete id or without --resume', () => {
    for (const args of [
      ['run', 'claude', '--resume', NEW_ID, '--all'],
      ['run', 'claude', '--since', '2d'],
      ['run', 'claude', 'hello', '-n', '3'],
    ]) {
      const res = spawnSync(process.execPath, [cliEntry, ...args], { cwd: project, env, encoding: 'utf-8' });
      expect(res.status, args.join(' ')).toBe(1);
      expect(res.stderr).toContain('only filter the session picker');
    }
    expect(recordedRuns()).toHaveLength(3);
  }, 120_000);
});
