import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeUpdateCache, writeClaudeSession, runAgents } from './sessions.test-fixture.js';

describe('agents ps preview', () => {
  it('resolves the displayed 8-character id and emits the stable rich JSON envelope', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-preview-'));
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work', 'agents-cli');
      const sessionId = 'feed7777-1111-4222-8333-444455556666';
      writeClaudeSession(tempHome, 'preview-local', sessionId, repoDir, 'preview the session card', '2026-08-03T09:00:00.000Z');
      const result = runAgents(['ps', 'preview', 'feed7777', '--json', '--local'], repoDir, tempHome);
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
