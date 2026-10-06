import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fleetCandidatesByQuery } from '../lib/session/selection.js';
import { parseRemoteList } from '../lib/session/remote-list.js';
import { writeUpdateCache, writeClaudeSession, runAgents } from './sessions.test-fixture.js';

describe('agents sessions --resolve local-peer critical path', () => {
  it('fails ambiguity with every full-id candidate and keeps misses explicit', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-resolve-errors-'));
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work', 'agents-cli');
      const first = 'cafe8888-1111-4222-8333-444455556666';
      const second = 'cafe8888-aaaa-4bbb-8ccc-ddddeeeeffff';
      writeClaudeSession(tempHome, 'resolve-errors', first, repoDir, 'first ambiguity candidate', '2026-08-03T09:00:00.000Z');
      writeClaudeSession(tempHome, 'resolve-errors', second, repoDir, 'second ambiguity candidate', '2026-08-03T09:01:00.000Z');
      const indexed = runAgents(['sessions', '--all', '--json', '--local'], repoDir, tempHome);
      expect(indexed.status, indexed.stderr).toBe(0);

      const ambiguous = runAgents(['sessions', '--resolve', 'cafe8888', '--json', '--local'], repoDir, tempHome);
      expect(ambiguous.status).toBe(1);
      expect(ambiguous.stdout).toBe('');
      expect(ambiguous.stderr).toContain(first);
      expect(ambiguous.stderr).toContain(second);

      const missing = runAgents(['sessions', '--resolve', 'bade9999', '--json', '--local'], repoDir, tempHome);
      expect(missing.status).toBe(1);
      expect(missing.stdout).toBe('');
      expect(missing.stderr).toContain('No session found matching: bade9999');

      const empty = runAgents(['sessions', '--resolve', '   ', '--json', '--local'], repoDir, tempHome);
      expect(empty.status).toBe(1);
      expect(empty.stdout).toBe('');
      expect(empty.stderr).toContain('--resolve requires a non-empty selector');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 90_000);

  it('keeps a peer-owned content-only FTS hit, projects safe metadata, and dedupes synced copies', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-resolve-peer-'));
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work', 'agents-cli');
      const sessionId = 'abcd7777-1111-4222-8333-444455556666';
      const sessionsDir = path.join(tempHome, '.claude', 'projects', 'resolve-peer');
      fs.mkdirSync(repoDir, { recursive: true });
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, `${sessionId}.jsonl`), [
        JSON.stringify({
          type: 'user', timestamp: '2026-08-03T09:00:00.000Z', cwd: repoDir,
          sessionId, version: '2.1.110', gitBranch: 'main',
          message: { role: 'user', content: 'unrelated first prompt' },
        }),
        JSON.stringify({
          type: 'user', timestamp: '2026-08-03T09:01:00.000Z', cwd: repoDir,
          sessionId, version: '2.1.110', gitBranch: 'main',
          message: { role: 'user', content: 'recap resolver hidden content' },
        }),
      ].join('\n') + '\n');

      const indexed = runAgents(['sessions', '--all', '--json', '--local'], repoDir, tempHome);
      expect(indexed.status, indexed.stderr).toBe(0);

      const peer = runAgents(
        ['sessions', '--resolve-safe-v1', 'recap resolver', '--json', '--all', '--local'],
        repoDir,
        tempHome,
        { AGENTS_SESSIONS_LOCAL: '1' },
      );
      expect(peer.status, peer.stderr).toBe(0);
      const peerRows = JSON.parse(peer.stdout) as Array<Record<string, unknown>>;
      expect(peerRows).toHaveLength(1);
      expect(peerRows[0].id).toBe(sessionId);
      expect(peerRows[0]).toHaveProperty('origin');
      expect(peerRows[0]).not.toHaveProperty('filePath');
      expect(peerRows[0]).not.toHaveProperty('plan');

      const remoteRows = parseRemoteList(peer.stdout, 'peer-one');
      const mirrored = remoteRows.map(row => ({ ...row, machine: 'peer-two' }));
      const candidates = fleetCandidatesByQuery([...remoteRows, ...mirrored], 'recap resolver');
      expect(candidates).toHaveLength(1);
      expect(candidates[0].id).toBe(sessionId);
      expect(candidates[0].hits.map(hit => hit.machine).sort()).toEqual(['peer-one', 'peer-two']);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('exits 1 when the real parent cannot read the device registry', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-resolve-registry-'));
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work');
      const devicesDir = path.join(tempHome, 'broken-devices');
      fs.mkdirSync(repoDir, { recursive: true });
      fs.mkdirSync(devicesDir, { recursive: true });
      fs.writeFileSync(path.join(devicesDir, 'registry.json'), '{broken');
      const result = runAgents(
        ['sessions', '--resolve', 'abcd7777', '--json'],
        repoDir,
        tempHome,
        { AGENTS_DEVICES_DIR: devicesDir },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('device registry');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
