import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { invocation, resolveSessionsBin, _resetSessionsClientForTest } from '../lib/sessions-client.js';
import { writeUpdateCache, runAgents } from './sessions.test-fixture.js';

function dependencySessions(): { command: string; prefix: string[] } {
  const saved = process.env.SESSIONS_BIN;
  delete process.env.SESSIONS_BIN;
  _resetSessionsClientForTest();
  try {
    return invocation(resolveSessionsBin());
  } finally {
    if (saved !== undefined) process.env.SESSIONS_BIN = saved;
    _resetSessionsClientForTest();
  }
}

describe('agents sessions tool calls', () => {
  it('indexes tool calls that the standalone sessions CLI searches, and refuses to search them itself', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-tools-'));
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work', 'agents-cli');
      const projectDir = path.join(tempHome, '.claude', 'projects', 'agents-cli-tools');
      const sessionId = '91919191-9191-4919-8919-919191919191';
      fs.mkdirSync(repoDir, { recursive: true });
      fs.mkdirSync(projectDir, { recursive: true });
      const rows = [
        { type: 'user', timestamp: '2026-08-03T00:00:00Z', cwd: repoDir, sessionId, message: { role: 'user', content: 'resolve conflicts' } },
        { type: 'assistant', timestamp: '2026-08-03T00:00:01Z', message: { content: [{ type: 'tool_use', id: 'git-1', name: 'Bash', input: { command: 'git merge topic; git status' } }] } },
        { type: 'user', timestamp: '2026-08-03T00:00:02Z', message: { content: [{ type: 'tool_result', tool_use_id: 'git-1', content: 'merge stopped' }] } },
        { type: 'assistant', timestamp: '2026-08-03T00:00:03Z', message: { content: [{ type: 'tool_use', id: 'gh-1', name: 'Bash', input: { command: 'gh pr view' } }] } },
        { type: 'user', timestamp: '2026-08-03T00:00:04Z', message: { content: [{ type: 'tool_result', tool_use_id: 'gh-1', content: 'CONFLICT in app.ts', is_error: true }] } },
      ];
      fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

      const indexed = runAgents(['sessions', '--all', '--json', '--no-interactive'], repoDir, tempHome);
      expect(indexed.status, indexed.stderr).toBe(0);

      const { command, prefix } = dependencySessions();
      const search = spawnSync(command, [
        ...prefix, '--include', 'tools',
        '--query', 'program:git input:merge',
        '--query', 'program:gh output:CONFLICT',
        '--json',
      ], { cwd: repoDir, env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome }, encoding: 'utf-8' });
      expect(search.status, search.stderr).toBe(0);
      const found = JSON.parse(search.stdout) as { sessions: Array<{ id: string; calls: unknown[] }> };
      expect(found.sessions).toEqual([expect.objectContaining({ id: sessionId })]);
      expect(found.sessions[0].calls).toHaveLength(2);

      const refused = runAgents([
        'sessions', '--include', 'tools', '--query', 'program:git', '--json', '--no-interactive',
      ], repoDir, tempHome);
      expect(refused.status).toBe(2);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).toContain('sessions --include tools');

      const tail = runAgents(['sessions', 'tail'], repoDir, tempHome);
      expect(tail.status).toBe(2);
      expect(tail.stdout).toBe('');
      expect(tail.stderr).toContain('sessions tail <id>');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 120_000);
});
