import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NO_FANOUT_ENV } from '../lib/session/remote-active.js';
import { writeUpdateCache, runAgents } from './sessions.test-fixture.js';

describe('agents sessions', () => {
  it('queries two distinct tool calls without changing the ordinary list JSON contract', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-tools-'));
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work', 'agents-cli');
      const projectDir = path.join(tempHome, '.claude', 'projects', 'agents-cli-tools');
      const sessionId = '91919191-9191-4919-8919-919191919191';
      fs.mkdirSync(repoDir, { recursive: true });
      fs.mkdirSync(projectDir, { recursive: true });
      const rows = [
        { type: 'user', timestamp: '2026-08-03T00:00:00Z', cwd: repoDir, sessionId, message: { role: 'user', content: 'resolve \x1b[2Jconflicts' } },
        { type: 'assistant', timestamp: '2026-08-03T00:00:01Z', message: { content: [{ type: 'tool_use', id: 'git-1', name: 'Bash', input: { command: 'git merge topic; git status' } }] } },
        { type: 'user', timestamp: '2026-08-03T00:00:02Z', message: { content: [{ type: 'tool_result', tool_use_id: 'git-1', content: 'merge stopped' }] } },
        { type: 'assistant', timestamp: '2026-08-03T00:00:03Z', message: { content: [{ type: 'tool_use', id: 'gh-1', name: 'Bash', input: { command: 'gh pr view' } }] } },
        { type: 'user', timestamp: '2026-08-03T00:00:04Z', message: { content: [{ type: 'tool_result', tool_use_id: 'gh-1', content: 'CONFLICT in app.ts', is_error: true }] } },
      ];
      fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

      expect(runAgents(['sessions', '--all', '--json', '--no-interactive'], repoDir, tempHome).status).toBe(0);

      const toolResult = runAgents([
        'sessions', '--include', 'tools',
        '--query', 'program:git input:merge',
        '--query', 'program:gh output:CONFLICT',
        '--all', '--json', '--no-interactive',
      ], repoDir, tempHome);
      expect(toolResult.status).toBe(0);
      const toolJson = JSON.parse(toolResult.stdout) as { schemaVersion: number; sessions: Array<{ id: string; filePath?: string; calls: unknown[] }> };
      expect(toolJson.schemaVersion).toBe(1);
      expect(toolJson.sessions).toEqual([expect.objectContaining({ id: sessionId, calls: expect.any(Array) })]);
      expect(toolJson.sessions[0].calls).toHaveLength(2);
      expect(toolJson.sessions[0].filePath).toBeUndefined();

      const countResult = runAgents([
        'sessions', '--include', 'tools', '--query', 'program:git', '--count',
        '--all', '--json', '--no-interactive',
      ], repoDir, tempHome);
      expect(countResult.status).toBe(0);
      expect(JSON.parse(countResult.stdout)).toMatchObject({
        kind: 'tool-program-count',
        query: { program: 'git', semantics: 'static-program-occurrences-v1' },
        totals: { occurrences: 2, toolCalls: 1, sessions: 1 },
      });

      const invalidCount = runAgents([
        'sessions', '--include', 'tools', '--query', 'input:git', '--count',
        '--all', '--json', '--no-interactive',
      ], repoDir, tempHome);
      expect(invalidCount.status).toBe(1);
      expect(invalidCount.stderr).toContain('exactly one --query program:<name>');

      const humanResult = runAgents([
        'sessions', '--include', 'tools', '--query', 'program:git',
        '--all', '--no-interactive',
      ], repoDir, tempHome);
      expect(humanResult.status).toBe(0);
      expect(humanResult.stdout).toContain('resolve conflicts');
      expect(humanResult.stdout).not.toContain('\x1b');

      const exactResult = runAgents([
        'sessions', sessionId, '--include', 'tools', '--all', '--json', '--no-interactive',
      ], repoDir, tempHome);
      expect(exactResult.status).toBe(0);
      const exactJson = JSON.parse(exactResult.stdout) as { schemaVersion: number; sessions: Array<{ id: string; calls: unknown[] }> };
      expect(exactJson.sessions).toEqual([expect.objectContaining({ id: sessionId })]);
      expect(exactJson.sessions[0].calls).toHaveLength(2);

      fs.appendFileSync(path.join(projectDir, `${sessionId}.jsonl`), [
        { type: 'assistant', timestamp: '2026-08-03T00:00:05Z', message: { content: [{ type: 'tool_use', id: 'pwd-1', name: 'Bash', input: { command: 'pwd' } }] } },
        { type: 'user', timestamp: '2026-08-03T00:00:06Z', message: { content: [{ type: 'tool_result', tool_use_id: 'pwd-1', content: repoDir }] } },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n');
      const staleExactResult = runAgents([
        'sessions', sessionId, '--include', 'tools', '--all', '--json', '--no-interactive',
      ], repoDir, tempHome);
      expect(JSON.parse(staleExactResult.stdout).sessions[0].calls).toHaveLength(2);

      expect(runAgents(['sessions', '--all', '--json', '--no-interactive'], repoDir, tempHome).status).toBe(0);
      const refreshedExactResult = runAgents([
        'sessions', sessionId, '--include', 'tools', '--all', '--json', '--no-interactive',
      ], repoDir, tempHome);
      expect(refreshedExactResult.status).toBe(0);
      const refreshedExactJson = JSON.parse(refreshedExactResult.stdout) as { sessions: Array<{ calls: Array<{ programs: string[] }> }> };
      expect(refreshedExactJson.sessions[0].calls).toHaveLength(3);
      expect(refreshedExactJson.sessions[0].calls).toContainEqual(expect.objectContaining({ programs: ['pwd'] }));

      const excessiveClauses = runAgents([
        'sessions', '--include', 'tools', '--all', '--json', '--no-interactive',
        ...Array.from({ length: 33 }, () => ['--query', 'program:git']).flat(),
      ], repoDir, tempHome);
      expect(excessiveClauses.status).toBe(1);
      expect(excessiveClauses.stderr).toContain('at most 32');

      const contradictoryScope = runAgents([
        'sessions', sessionId, '--include', 'tools', '--local',
        '--device', 'definitely-remote', '--json', '--no-interactive',
      ], repoDir, tempHome);
      expect(contradictoryScope.status).toBe(1);
      expect(contradictoryScope.stderr).toContain('--local and --device name opposite scopes');

      for (const conflictingFlag of ['--markdown', '--no-redact']) {
        const conflict = runAgents([
          'sessions', sessionId, '--include', 'tools', conflictingFlag,
          '--all', '--json', '--no-interactive',
        ], repoDir, tempHome);
        expect(conflict.status).toBe(1);
        expect(conflict.stderr).toContain(`${conflictingFlag} cannot be used with --include tools`);
      }

      const listResult = runAgents(['sessions', '--all', '--json', '--no-interactive'], repoDir, tempHome);
      expect(listResult.status).toBe(0);
      expect(Array.isArray(JSON.parse(listResult.stdout))).toBe(true);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 120_000);

  it('omits a synced mirror when answering a fleet evidence partition', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-tool-mirror-'));
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work', 'agents-cli');
      const projectDir = path.join(
        tempHome,
        '.agents',
        '.history',
        'backups',
        'claude',
        'origin-one',
        'projects',
        'agents-cli-tools',
      );
      const sessionId = '92929292-9292-4929-8929-929292929292';
      fs.mkdirSync(repoDir, { recursive: true });
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [
        { type: 'user', timestamp: '2026-08-03T00:00:00Z', cwd: repoDir, sessionId, message: { role: 'user', content: 'mirrored command' } },
        { type: 'assistant', timestamp: '2026-08-03T00:00:01Z', message: { content: [{ type: 'tool_use', id: 'git-1', name: 'Bash', input: { command: 'git status' } }] } },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n');

      const indexed = runAgents(['sessions', '--all', '--json', '--no-interactive'], repoDir, tempHome);
      expect(indexed.status, indexed.stderr).toBe(0);

      const localCache = runAgents([
        'sessions', '--include', 'tools', '--query', 'program:git',
        '--all', '--json', '--no-interactive',
      ], repoDir, tempHome);
      expect(localCache.status, localCache.stderr).toBe(0);
      expect(JSON.parse(localCache.stdout).sessions).toHaveLength(1);

      const fleetPartition = runAgents([
        'sessions', '--include', 'tools', '--query', 'program:git',
        '--all', '--json', '--no-interactive',
      ], repoDir, tempHome, { [NO_FANOUT_ENV]: '1' });
      expect(fleetPartition.status, fleetPartition.stderr).toBe(0);
      expect(JSON.parse(fleetPartition.stdout).sessions).toEqual([]);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 90_000);
});
