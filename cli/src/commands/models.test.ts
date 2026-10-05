import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatModelAliasLines, formatModelSourceLine, formatModelSummaryLine } from './models.js';
import { stringWidth, stripAnsi } from '../lib/session/width.js';

describe('models responsive formatting', () => {
  it('truncates the source path to the requested width', () => {
    const line = formatModelSourceLine('bundle', '~/very/long/path/inside/a/version/home/models/catalog.json', 44);
    expect(stringWidth(line)).toBeLessThanOrEqual(44);
    expect(line).toMatch(/^  source: bundle \(/);
  });

  it('wraps aliases under a hanging indent', () => {
    const lines = formatModelAliasLines([
      'opus=claude-opus-4-20250514',
      'sonnet=claude-sonnet-4-20250514',
      'haiku=claude-haiku-4-20250514',
    ], 54);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => stringWidth(line) <= 54)).toBe(true);
    expect(stripAnsi(lines[1]).startsWith('           ')).toBe(true);
  });

  it('caps model id and display name rows', () => {
    const line = formatModelSummaryLine('*', 'provider/super-long-model-id-with-extra-suffix', 'A display name that is also too long', 'daily-driver', 60);
    expect(stringWidth(line)).toBeLessThanOrEqual(60);
    expect(stripAnsi(line)).toContain('provider/super-long-model-id');
  });
});

const repoRoot = process.cwd();
const entrypoint = path.join(repoRoot, 'src/index.ts');

function runAgents(home: string, args: string[]): string {
  return execFileSync('bun', [entrypoint, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_SKIP_MIGRATION: '1',
      AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
    },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('models set (run defaults)', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-models-set-test-'));
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('writes the same run.defaults store as `config get` reads', () => {
    const setOut = runAgents(home, ['models', 'set', 'claude@2.1.220', '--model', 'opus-5']);
    expect(setOut).toContain('claude:2.1.220');
    expect(setOut).toContain('model opus-5');

    const yaml = fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8');
    expect(yaml).toContain('claude:2.1.220');
    expect(yaml).toContain('model: opus-5');

    const getOut = runAgents(home, ['config', 'get', 'run.claude@2.1.220.model']);
    expect(getOut).toContain('run.claude@2.1.220.model');
    expect(getOut).toContain('opus-5');
  });

  it('accepts the @ and : selector forms and both flags', () => {
    runAgents(home, ['models', 'set', 'claude:*', '--mode', 'full', '--model', 'opus']);
    const yaml = fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8');
    expect(yaml).toContain('claude:*');
    expect(yaml).toContain('mode: skip');
    expect(yaml).toContain('model: opus');
  });

  it('shows the current default for a selector when no flags are given', () => {
    runAgents(home, ['models', 'set', 'claude@2.1.220', '--model', 'opus-5']);
    const showOut = runAgents(home, ['models', 'set', 'claude@2.1.220']);
    expect(showOut).toContain('claude:2.1.220');
    expect(showOut).toContain('model opus-5');
  });

  it('lists all defaults when given no selector', () => {
    runAgents(home, ['models', 'set', 'claude@2.1.220', '--model', 'opus-5']);
    const listOut = runAgents(home, ['models', 'set']);
    expect(listOut).toContain('Agent Defaults');
    expect(listOut).toContain('claude:2.1.220');
  });

  it('errors (does not silently drop flags) when a selector is omitted but flags are given', () => {
    let err: { status?: number; stderr?: string; stdout?: string } | undefined;
    try {
      runAgents(home, ['models', 'set', '--model', 'opus-5']);
    } catch (e) {
      err = e as { status?: number; stderr?: string; stdout?: string };
    }
    expect(err).toBeDefined();
    expect(err?.status).toBe(1);
    expect(String(err?.stderr) + String(err?.stdout)).toContain('Selector is required');
    expect(fs.existsSync(path.join(home, '.agents', 'agents.yaml'))).toBe(false);
  });

  it('reports no default set for an unconfigured selector', () => {
    const out = runAgents(home, ['models', 'set', 'claude@9.9.9']);
    expect(out).toContain('No default set for claude:9.9.9');
  });

  it('retires the top-level `agents set` as unknown', () => {
    let err: { status?: number; stderr?: string; stdout?: string } | undefined;
    try {
      runAgents(home, ['set', 'claude@2.1.220', '--model', 'opus-5']);
    } catch (e) {
      err = e as { status?: number; stderr?: string; stdout?: string };
    }
    expect(err).toBeDefined();
    expect(err?.status).toBe(1);
    expect(String(err?.stderr)).toContain("unknown command 'set'");
  });
});
