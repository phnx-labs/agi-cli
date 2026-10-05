import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  repoRoot,
  writeUpdateCache,
  writeClaudeSession,
  writeCodexSession,
  runAgents,
  outputOf,
} from './sessions.test-fixture.js';

describe('agents sessions (render-mode)', () => {
  it('resolves explicit IDs across directories even when the default listing is scoped to cwd', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-render-global-'));

    try {
      writeUpdateCache(tempHome);

      const phnxDir = path.join(tempHome, 'work', 'phnx-labs');
      const agentsCliDir = path.join(tempHome, 'work', 'agents-cli');
      const siblingSessionId = '33333333-3333-4333-8333-333333333333';

      writeClaudeSession(
        tempHome,
        'phnx-labs-test',
        '44444444-4444-4444-8444-444444444444',
        phnxDir,
        'Inspect the phnx-labs session list',
        '2026-04-17T19:35:30.000Z'
      );
      writeClaudeSession(
        tempHome,
        'agents-cli-test',
        siblingSessionId,
        agentsCliDir,
        'Review sibling repo state',
        '2026-04-17T19:36:30.000Z'
      );

      const result = runAgents(['sessions', siblingSessionId, '--markdown'], phnxDir, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain('Review sibling repo state');
      expect(output).not.toContain(`No session found matching: ${siblingSessionId}`);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('resolves Claude /resume history IDs to the resumed transcript', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-render-history-'));

    try {
      writeUpdateCache(tempHome);

      const projectRoot = path.join(tempHome, 'work', 'phnx-labs');
      const transcriptCwd = path.join(projectRoot, 'extension');
      const transcriptId = '92267176-d991-45c2-a8e5-e851e30a203b';
      const historyOnlyId = 'f6a6cd2d-2138-41c4-b653-d2881ce9cdd3';

      fs.mkdirSync(path.join(tempHome, '.claude', 'projects', 'phnx-labs-test'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.claude', 'history.jsonl'),
        JSON.stringify({
          display: '/resume',
          timestamp: Date.parse('2026-04-17T19:30:00.000Z'),
          project: projectRoot,
          sessionId: historyOnlyId,
        }) + '\n',
        'utf-8'
      );
      fs.mkdirSync(transcriptCwd, { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.claude', 'projects', 'phnx-labs-test', `${transcriptId}.jsonl`),
        [
          JSON.stringify({
            type: 'user',
            timestamp: '2026-04-17T19:00:00.000Z',
            cwd: transcriptCwd,
            sessionId: transcriptId,
            version: '2.1.110',
            gitBranch: 'main',
            message: { role: 'user', content: 'Earlier context' },
          }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-04-17T19:00:05.000Z',
            cwd: transcriptCwd,
            sessionId: transcriptId,
            version: '2.1.110',
            gitBranch: 'main',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Earlier reply' }],
            },
          }),
          JSON.stringify({
            type: 'attachment',
            timestamp: '2026-04-17T19:30:30.000Z',
            cwd: transcriptCwd,
            sessionId: transcriptId,
            version: '2.1.110',
            gitBranch: 'main',
            attachment: {
              type: 'hook_success',
              hookName: 'SessionStart:resume',
              hookEvent: 'SessionStart',
            },
          }),
          JSON.stringify({
            type: 'user',
            timestamp: '2026-04-17T19:30:45.000Z',
            cwd: transcriptCwd,
            sessionId: transcriptId,
            version: '2.1.110',
            gitBranch: 'main',
            message: { role: 'user', content: 'Continue from where we left off' },
          }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-04-17T19:31:00.000Z',
            cwd: transcriptCwd,
            sessionId: transcriptId,
            version: '2.1.110',
            gitBranch: 'main',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Loaded resumed transcript' }],
            },
          }),
        ].join('\n') + '\n',
        'utf-8'
      );

      const result = runAgents(['sessions', historyOnlyId, '--markdown'], repoRoot, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain('Loaded resumed transcript');
      expect(output).not.toContain(`No transcript session found matching: ${historyOnlyId}`);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('resolves text queries against session topics, not only IDs', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-render-query-'));

    try {
      writeUpdateCache(tempHome);

      const projectDir = path.join(tempHome, 'work', 'agents-cli');
      const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const prompt = 'Search across sessions by prompt text';

      writeCodexSession(
        tempHome,
        sessionId,
        projectDir,
        prompt,
        '2026-04-17T19:41:30.000Z'
      );

      const result = runAgents(['sessions', 'prompt text', '--markdown'], projectDir, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain(prompt);
      expect(output).not.toContain('No session found matching: prompt text');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('applies --project filters before resolving search queries', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-render-project-filter-'));

    try {
      writeUpdateCache(tempHome);

      const workspaceDir = path.join(tempHome, 'work');
      const agentsDir = path.join(workspaceDir, 'agents');
      const agentsCliDir = path.join(workspaceDir, 'agents-cli');

      writeCodexSession(
        tempHome,
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        agentsDir,
        'Filter scoped search target',
        '2026-04-17T19:42:30.000Z'
      );
      writeCodexSession(
        tempHome,
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        agentsCliDir,
        'Filter scoped search decoy',
        '2026-04-17T19:43:30.000Z'
      );

      const result = runAgents(
        ['sessions', '--project', 'agents-cli', 'scoped search', '--markdown'],
        workspaceDir,
        tempHome,
      );
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain('Filter scoped search decoy');
      expect(output).not.toContain('Filter scoped search target');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('applies --agent filters before resolving search queries', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-render-agent-filter-'));

    try {
      writeUpdateCache(tempHome);

      const projectDir = path.join(tempHome, 'work', 'agents-cli');

      writeClaudeSession(
        tempHome,
        'agents-cli-claude',
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        projectDir,
        'Shared filter phrase from claude',
        '2026-04-17T19:44:30.000Z'
      );
      writeCodexSession(
        tempHome,
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        projectDir,
        'Shared filter phrase from codex',
        '2026-04-17T19:45:30.000Z'
      );

      const result = runAgents(
        ['sessions', '--agent', 'codex', 'shared filter phrase', '--markdown'],
        projectDir,
        tempHome,
      );
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain('Shared filter phrase from codex');
      expect(output).not.toContain('Shared filter phrase from claude');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('agents sessions preview', () => {
  it('resolves the displayed 8-character id and emits the stable rich JSON envelope', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-preview-'));
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work', 'agents-cli');
      const sessionId = 'feed7777-1111-4222-8333-444455556666';
      writeClaudeSession(tempHome, 'preview-local', sessionId, repoDir, 'preview the session card', '2026-08-03T09:00:00.000Z');
      const indexed = runAgents(['sessions', '--all', '--json', '--local'], repoDir, tempHome);
      expect(indexed.status, indexed.stderr).toBe(0);

      const result = runAgents(['sessions', 'preview', 'feed7777', '--json', '--local'], repoDir, tempHome);
      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.schemaVersion).toBe(1);
      expect(output.session.id).toBe(sessionId);
      expect(output.session.shortId).toBe('feed7777');
      expect(output.active).toBeNull();
      expect(output.preview.schemaVersion).toBe(1);
      expect(output.preview.firstUser).toContain('preview the session card');
      expect(output.error).toBeNull();
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
