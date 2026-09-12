import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  writeUpdateCache,
  writeClaudeSession,
  runAgents,
  outputOf,
  describeLive,
} from './sessions.test-fixture.js';

/**
 * A direct id/alias resume that names an explicit terminal backend
 * (--iterm/--ghostty/--tmux/--vscodium/--terminal-app) used to be silently
 * accepted and ignored: `sessionsResumeAction`'s direct-selector branch always
 * called `runStrictResume`, which execs `agents run --resume <id>` in the
 * current process and has no concept of a terminal backend at all —
 * `resolveBackend` (which understands those flags) was only ever reached from
 * the multi-select picker path. Fixed by routing a direct selector through the
 * same `openResumeBatch` (resolveBackend + openSurfaces) engine whenever an
 * explicit backend flag is present.
 */
describeLive('agents sessions resume <id> --vscodium (explicit terminal backend)', () => {
  it('routes a direct full-UUID resume through the terminal engine, not the flag-blind strict-resume path', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-resume-backend-'));
    try {
      writeUpdateCache(tempHome);
      const cwd = path.join(tempHome, 'work', 'proj');
      const sessionId = '33333333-3333-4333-8333-333333333333';
      writeClaudeSession(tempHome, 'proj-test', sessionId, cwd, 'Do the thing', '2026-04-17T19:35:30.000Z');

      // Warm the session index the same way a real fleet's daemon would before
      // an operator resumes anything (RUSH-2682's index-lag window is a daemon
      // concern, not what this test is proving).
      runAgents(['sessions'], cwd, tempHome);

      const result = runAgents(['sessions', 'resume', sessionId, '--vscodium'], cwd, tempHome);
      const output = outputOf(result);
      // This banner is printed ONLY by openResumeBatch, right before it calls
      // openSurfaces with the forced backend — runStrictResume never prints it
      // and has no forced-backend concept, so seeing it proves --vscodium was
      // honored rather than silently dropped.
      expect(output).toContain('Opening 1 session in vscodium-agent');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 30_000);

  it('a direct resume with NO explicit backend still goes through strict resume (no regression)', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-resume-strict-'));
    try {
      writeUpdateCache(tempHome);
      const cwd = path.join(tempHome, 'work', 'proj');
      const sessionId = '44444444-4444-4444-8444-444444444444';
      writeClaudeSession(tempHome, 'proj-test', sessionId, cwd, 'Do the thing', '2026-04-17T19:35:30.000Z');
      runAgents(['sessions'], cwd, tempHome);

      const result = runAgents(['sessions', 'resume', sessionId], cwd, tempHome);
      const output = outputOf(result);
      expect(output).not.toContain('Opening 1 session in');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 30_000);
});
