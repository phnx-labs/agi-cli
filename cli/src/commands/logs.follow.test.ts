import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveSessionsBin, runSessions, _resetSessionsClientForTest } from '../lib/sessions-client.js';
import { cliEntry, describeLive, runAgents, tsxLoaderUrl, writeClaudeSession, writeUpdateCache } from './sessions.test-fixture.js';

const temps: string[] = [];
const savedHome = process.env.HOME;
const savedSessionsBin = process.env.SESSIONS_BIN;

afterEach(() => {
  process.env.HOME = savedHome;
  if (savedSessionsBin === undefined) delete process.env.SESSIONS_BIN;
  else process.env.SESSIONS_BIN = savedSessionsBin;
  _resetSessionsClientForTest();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function dependencySessionsBin(): string {
  delete process.env.SESSIONS_BIN;
  _resetSessionsClientForTest();
  const bin = resolveSessionsBin();
  _resetSessionsClientForTest();
  return bin;
}

function indexedClaudeSession(): { home: string; cwd: string; id: string; transcript: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-logs-follow-'));
  temps.push(home);
  writeUpdateCache(home);
  const cwd = path.join(home, 'repo');
  const id = '5a5a5a5a-5a5a-45a5-85a5-5a5a5a5a5a5a';
  const projectKey = cwd.replace(/[/.]/g, '-');
  writeClaudeSession(home, projectKey, id, cwd, 'follow me', '2026-10-08T10:00:00.000Z');
  const indexed = runAgents(['sessions', '--all', '--json', '--no-interactive'], cwd, home);
  expect(indexed.status, indexed.stderr).toBe(0);
  return { home, cwd, id, transcript: path.join(home, '.claude', 'projects', projectKey, `${id}.jsonl`) };
}

describe('runSessions', () => {
  it("returns the standalone sessions CLI's own exit code", async () => {
    const { home } = indexedClaudeSession();
    process.env.SESSIONS_BIN = dependencySessionsBin();
    process.env.HOME = home;
    _resetSessionsClientForTest();
    expect(await runSessions(['tail', '00000000-0000-4000-8000-000000000000'])).toBe(1);
  }, 120_000);
});

describeLive('agents logs -f', () => {
  it('streams through `sessions tail --json` and survives Ctrl+C long enough to report the child exit', async () => {
    const { home, cwd, id, transcript } = indexedClaudeSession();
    const child = spawn('node', ['--import', tsxLoaderUrl, cliEntry, 'logs', id, '-f', '--full'], {
      cwd,
      detached: true,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        SESSIONS_BIN: dependencySessionsBin(),
        AGENTS_SKIP_MIGRATION: '1',
        NODE_NO_WARNINGS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }));
    });

    const marker = 'tail-marker-7c1e';
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-10-08T10:00:05.000Z',
      sessionId: id,
      message: { role: 'assistant', content: [{ type: 'text', text: marker }] },
    }) + '\n';
    const deadline = Date.now() + 60_000;
    while (!stdout.includes(marker) && Date.now() < deadline) {
      fs.appendFileSync(transcript, line);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(stdout, stderr).toContain(marker);
    const firstLine = stdout.split('\n').find((l) => l.includes(marker))!;
    expect(JSON.parse(firstLine).type).toBe('assistant');

    process.kill(-child.pid!, 'SIGINT');
    const { code, signal } = await exited;
    expect(signal, stderr).toBeNull();
    expect(code).toBe(130);
  }, 120_000);
});
