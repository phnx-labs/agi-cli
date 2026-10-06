import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const cliEntry = path.join(repoRoot, 'src', 'index.ts');
const tsxBin = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

let home: string;

function run(args: string[]) {
  return spawnSync(process.execPath, [tsxBin, cliEntry, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, NODE_NO_WARNINGS: '1' },
    encoding: 'utf-8',
  });
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-cli-' + crypto.randomBytes(4).toString('hex') + '-'));
  fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('agents sessions stats (real CLI parse)', () => {
  it('emits the versioned stats envelope on --json even though the parent owns --json', () => {
    const res = run(['sessions', 'stats', '--json']);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as { schemaVersion: number; kind: string; ranked: unknown[] };
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.kind).toBe('sessions-stats');
    expect(Array.isArray(parsed.ranked)).toBe(true);
  });

  it('carries --kind through to the filters (a parent-unknown flag on the child)', () => {
    const res = run(['sessions', 'stats', '--kind', 'skill', '--json']);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as { filters: { kind: string | null } };
    expect(parsed.filters.kind).toBe('skill');
  });

  it('fails loud on an invalid --kind instead of silently ignoring it', () => {
    const res = run(['sessions', 'stats', '--kind', 'bogus']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--kind must be one of');
  });

  it('fails loud on a negative --top', () => {
    const res = run(['sessions', 'stats', '--top', '-3']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--top must be');
  });

  it('exposes the resources backfill with its own versioned envelope', () => {
    const res = run(['sessions', 'backfill', 'resources', '--json']);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as { schemaVersion: number; kind: string; updated: number };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.kind).toBe('resources-backfill');
    expect(typeof parsed.updated).toBe('number');
  });
});

describe('agents insights resources (real CLI parse)', () => {
  function filters(args: string[]) {
    const res = run(args);
    expect(res.status, res.stderr).toBe(0);
    const parsed = JSON.parse(res.stdout) as { schemaVersion: number; kind: string; filters: Record<string, string | null> };
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.kind).toBe('sessions-stats');
    return parsed.filters;
  }

  it('treats the insights default --agent [] as unset and keeps the all-time window', () => {
    expect(filters(['insights', 'resources', '--json'])).toMatchObject({ agent: null, since: null });
    expect(filters(['insights', '--json', 'resources'])).toMatchObject({ agent: null, since: null });
  });

  it('reads one --agent as a scalar wherever it is written', () => {
    expect(filters(['insights', '--agent', 'claude', 'resources', '--json']).agent).toBe('claude');
    expect(filters(['insights', 'resources', '--agent', 'claude', '--json']).agent).toBe('claude');
    expect(filters(['insights', 'resources', '-a', 'kimi', '--json']).agent).toBe('kimi');
  });

  it('rejects two different agents instead of filtering on their union', () => {
    const res = run(['insights', '--agent', 'claude', 'resources', '-a', 'kimi', '--json']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('resource usage filters on one --agent; got kimi, claude');
  });
});
