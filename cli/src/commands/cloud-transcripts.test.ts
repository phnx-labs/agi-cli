import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { startRushApi, type RushApi } from '../lib/cloud/testdata/rush-api.js';

const repoRoot = process.cwd();
const cliEntry = path.join(repoRoot, 'src', 'index.ts');
const tsxBin = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

let home: string;
let api: RushApi;

function transcripts(args: string[], key: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NODE_NO_WARNINGS: '1', AGENTS_SESSIONS_DB: '', RUSH_PROXY_BASE: api.url };
  delete env.RUSH_API_KEY;
  delete env.RUSH_ORG;
  Object.assign(env, key);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxBin, cliEntry, 'cloud', 'transcripts', ...args], { cwd: home, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

beforeAll(async () => {
  api = await startRushApi();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-transcripts-'));
  fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
  const local = path.join(home, '.claude', 'projects', '-work-proj');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(
    path.join(local, '44444444-4444-4444-8444-444444444444.jsonl'),
    JSON.stringify({ type: 'user', timestamp: '2026-10-01T00:00:00.000Z', sessionId: '44444444-4444-4444-8444-444444444444', cwd: '/work/proj', uuid: 'u1', message: { role: 'user', content: 'local only' } }) + '\n',
  );
});

afterAll(async () => {
  await api.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('agents cloud transcripts (real CLI)', () => {
  it('exits 1 without a Rush API key and never falls back to local sessions', async () => {
    for (const selector of [[], ['44444444']]) {
      const res = await transcripts([...selector, '--json']);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('Failed to list cloud sessions: Rush Cloud needs RUSH_API_KEY and RUSH_ORG');
      expect(res.stdout).toBe('');
    }
  });

  it('lists sessions and renders one transcript through the developer API', async () => {
    const created = await fetch(`${api.url}/o/${api.org}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${api.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'claude', input: 'reply with the word ok' }),
    }).then((r) => r.json() as Promise<{ execution_id: string }>);
    const key = { RUSH_API_KEY: api.apiKey, RUSH_ORG: api.org };

    const list = await transcripts(['--json'], key);
    expect(list.status).toBe(0);
    expect(JSON.parse(list.stdout).map((s: { id: string }) => s.id)).toEqual([created.execution_id]);

    const md = await transcripts([created.execution_id, '--markdown'], key);
    expect(md.status).toBe(0);
    expect(md.stdout).toContain('reply with the word ok');
    expect(md.stdout).toContain('echo ok');
    expect(api.requests.at(-1)).toMatchObject({ path: `/o/${api.org}/sessions/${created.execution_id}/messages`, bearer: api.apiKey });
  });

  it('rejects conflicting turn filters before contacting the service', async () => {
    const res = await transcripts(['--first', '1', '--last', '1']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--first and --last are mutually exclusive');
  });
});
