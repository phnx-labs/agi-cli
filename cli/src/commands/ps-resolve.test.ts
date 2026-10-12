import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  metadataResolveOutcome,
  isUniqueEnoughSelector,
  metadataResolveForwardedArgs,
  fleetCandidatesByQuery,
} from '../lib/session/selection.js';
import { parseRemoteList } from '../lib/session/remote-list.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { repoRoot, writeUpdateCache, writeClaudeSession, runAgents, indexSessions } from './sessions.test-fixture.js';

describe('resolveSessionQuery indexed metadata coverage', () => {
  it('resolves complete and partial ids from the real index without using text matches', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-resolve-index-'));
    try {
      const runner = [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "const { upsertSession, closeDB } = await import('./src/lib/session/db.ts');",
        "const { resolveSessionQuery } = await import('./src/lib/session/selection.ts');",
        "const home = process.env.HOME;",
        "const add = (id, topic, content = '') => { const filePath = path.join(home, id + '.jsonl'); fs.writeFileSync(filePath, ''); upsertSession({ id, shortId: id.slice(0, 8), agent: 'claude', timestamp: new Date().toISOString(), filePath, topic }, content); };",
        "const indexed = 'a7c1d88d-b543-48c1-993d-dd5cd8e210c9'; add(indexed, 'old but present');",
        "const rush = 'session_001fa16e-9f97-453d-b0f0-5c35317bcd04'; add(rush, 'competitive watch');",
        "const mentioner = 'aaaa1111-1111-2222-3333-444455556666'; add(mentioner, 'resume previous work: bbbb2222', 'resume previous work bbbb2222 earlier');",
        "const prefix = 'cccc3333-1111-2222-3333-444455556666'; add(prefix, 'the real one');",
        "const localOnly = 'dddd4444-1111-2222-3333-444455556666'; add(localOnly, 'local only');",
        "const pick = (selector, options) => { const r = resolveSessionQuery([], selector, options); return { ids: r.matches.map(s => s.id), byId: r.byId, completeId: r.completeId }; };",
        "const out = { indexed: pick(indexed), rush: pick(rush), absent: pick('2feeb449-5c73-4f1c-9163-8459e7aafeea'), phrase: pick('old but present'), mention: pick('bbbb2222'), prefix: pick('cccc3333'), noFallback: pick('dddd4444', { indexFallback: false }) };",
        "closeDB(); process.stdout.write(JSON.stringify(out));",
      ].join(' ');
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', runner], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        indexed: { ids: ['a7c1d88d-b543-48c1-993d-dd5cd8e210c9'], byId: true, completeId: true },
        rush: { ids: ['session_001fa16e-9f97-453d-b0f0-5c35317bcd04'], byId: true, completeId: true },
        absent: { ids: [], byId: true, completeId: true },
        phrase: { ids: ['a7c1d88d-b543-48c1-993d-dd5cd8e210c9'], byId: false, completeId: false },
        mention: { ids: [], byId: true, completeId: false },
        prefix: { ids: ['cccc3333-1111-2222-3333-444455556666'], byId: true, completeId: false },
        noFallback: { ids: [], byId: true, completeId: false },
      });
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('RUSH-2203 local full-UUID hit skips SSH', () => {
  it('resolves a full id from the local DB with ZERO dials, but a label still consults the fleet', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-local-hit-'));
    try {
      const runner = [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "const { upsertSession, closeDB } = await import('./src/lib/session/db.ts');",
        "const { resolveSessionMetadataValue } = await import('./src/lib/session/selection.ts');",
        "const home = process.env.HOME;",
        "const id = '019fd0c8-b3e9-77a2-a1a4-444698c4d897';",
        "const filePath = path.join(home, id + '.jsonl'); fs.writeFileSync(filePath, '');",
        "upsertSession({ id, shortId: id.slice(0, 8), agent: 'claude', timestamp: new Date().toISOString(), filePath, label: 'ship the resume fix' }, '');",
        "let dialed = 0;",
        "const deps = { gatherRemoteList: async () => { dialed++; throw new Error('SSH DIALED'); } };",
        "const byId = await resolveSessionMetadataValue(id, {}, deps);",
        "const idDials = dialed;",
        "const byLabel = await resolveSessionMetadataValue('ship the resume fix', {}, deps);",
        "closeDB();",
        "process.stdout.write(JSON.stringify({ byIdKind: byId.kind, byIdId: byId.session && byId.session.id, idDials, byLabelKind: byLabel.kind, labelDialed: dialed > idDials }));",
      ].join(' ');
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', runner], {
        cwd: repoRoot,
        env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        byIdKind: 'resolved',
        byIdId: '019fd0c8-b3e9-77a2-a1a4-444698c4d897',
        idDials: 0,
        byLabelKind: 'partial',
        labelDialed: true,
      });
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

const PEER = { AGENTS_SESSIONS_LOCAL: '1' };

describe('agents ps resolve — the peer resolver protocol', () => {
  it('resolves a full id, unique prefix, and keywords through the metadata-only CLI contract', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ps-resolve-local-'));
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work', 'agents-cli');
      const sessionId = 'face7777-1111-4222-8333-444455556666';
      writeClaudeSession(tempHome, 'resolve-local', sessionId, repoDir, 'needle metadata contract', '2026-08-03T09:00:00.000Z');
      const indexed = indexSessions(repoDir, tempHome);
      expect(indexed.status, indexed.stderr).toBe(0);

      for (const selector of [sessionId, 'face7777', 'needle metadata contract']) {
        const result = runAgents(['ps', 'resolve', selector, '--json', '--local'], repoDir, tempHome, PEER);
        expect(result.status, result.stderr).toBe(0);
        const rows = JSON.parse(result.stdout) as SessionMeta[];
        expect(rows.map(row => row.id)).toEqual([sessionId]);
        expect(rows[0]).not.toHaveProperty('filePath');
        expect(rows[0]).not.toHaveProperty('plan');
        expect(rows[0].origin).toBe('cli');
        expect(rows[0]).not.toHaveProperty('account');
        expect(rows[0]).not.toHaveProperty('cwd');
        expect(rows[0]).not.toHaveProperty('mode');
        expect(rows[0]).not.toHaveProperty('recentDirectoriesTouched');
      }
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 90_000);

  it('keeps a peer-owned content-only FTS hit, projects safe metadata, and dedupes synced copies', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ps-resolve-peer-'));
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

      const indexed = indexSessions(repoDir, tempHome);
      expect(indexed.status, indexed.stderr).toBe(0);
      const peer = runAgents(['ps', 'resolve', 'recap resolver', '--json', '--local'], repoDir, tempHome, PEER);
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

  it('answers every candidate of an ambiguous prefix and an empty list for a miss', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ps-resolve-ambiguous-'));
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work', 'agents-cli');
      const first = 'cafe8888-1111-4222-8333-444455556666';
      const second = 'cafe8888-aaaa-4bbb-8ccc-ddddeeeeffff';
      writeClaudeSession(tempHome, 'resolve-errors', first, repoDir, 'first ambiguity candidate', '2026-08-03T09:00:00.000Z');
      writeClaudeSession(tempHome, 'resolve-errors', second, repoDir, 'second ambiguity candidate', '2026-08-03T09:01:00.000Z');

      const ambiguous = runAgents(['ps', 'resolve', 'cafe8888', '--json', '--local'], repoDir, tempHome, PEER);
      expect(ambiguous.status, ambiguous.stderr).toBe(0);
      expect((JSON.parse(ambiguous.stdout) as SessionMeta[]).map(row => row.id).sort()).toEqual([first, second].sort());

      const missing = runAgents(['ps', 'resolve', 'bade9999', '--json', '--local'], repoDir, tempHome, PEER);
      expect(missing.status, missing.stderr).toBe(0);
      expect(JSON.parse(missing.stdout)).toEqual([]);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 90_000);

  it('refuses outside the fleet protocol, without --json, and for an empty selector', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ps-resolve-refuse-'));
    try {
      writeUpdateCache(tempHome);
      const direct = runAgents(['ps', 'resolve', 'abcd7777', '--json', '--local'], tempHome, tempHome);
      expect(direct.status).toBe(1);
      expect(direct.stdout).toBe('');
      expect(direct.stderr).toContain('ps resolve is an internal fleet protocol.');

      const text = runAgents(['ps', 'resolve', 'abcd7777', '--local'], tempHome, tempHome, PEER);
      expect(text.status).toBe(1);
      expect(text.stderr).toContain('ps resolve requires --json.');

      const empty = runAgents(['ps', 'resolve', '   ', '--json', '--local'], tempHome, tempHome, PEER);
      expect(empty.status).toBe(1);
      expect(empty.stdout).toBe('');
      expect(empty.stderr).toContain('ps resolve requires a non-empty selector.');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('maps a launch id to the session the hook recorded, and to null when none did', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ps-resolve-launch-'));
    try {
      writeUpdateCache(tempHome);
      const sessionId = 'beef4444-1111-4222-8333-444455556666';
      const hookDir = path.join(tempHome, '.agents', '.cache', 'terminals', 'sessions');
      fs.mkdirSync(hookDir, { recursive: true });
      fs.writeFileSync(path.join(hookDir, 'launch-l1.json'), JSON.stringify({
        session_id: sessionId, launch_id: 'launch-0001', ts: Date.now() / 1000, completed: true,
      }));

      const hit = runAgents(['ps', 'resolve', '--launch-id', 'launch-0001', '--json', '--local'], tempHome, tempHome);
      expect(hit.status, hit.stderr).toBe(0);
      expect(JSON.parse(hit.stdout)).toEqual({ launchId: 'launch-0001', sessionId });

      const miss = runAgents(['ps', 'resolve', '--launch-id', 'launch-0002', '--json', '--local'], tempHome, tempHome);
      expect(miss.status, miss.stderr).toBe(0);
      expect(JSON.parse(miss.stdout)).toEqual({ launchId: 'launch-0002', sessionId: null });
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('agents ps preview — fleet resolve outcomes', () => {
  it('names every candidate of an ambiguous prefix and keeps a miss explicit', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ps-preview-ambiguous-'));
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work', 'agents-cli');
      const first = 'cafe8888-1111-4222-8333-444455556666';
      const second = 'cafe8888-aaaa-4bbb-8ccc-ddddeeeeffff';
      writeClaudeSession(tempHome, 'resolve-errors', first, repoDir, 'first ambiguity candidate', '2026-08-03T09:00:00.000Z');
      writeClaudeSession(tempHome, 'resolve-errors', second, repoDir, 'second ambiguity candidate', '2026-08-03T09:01:00.000Z');

      const ambiguous = runAgents(['ps', 'preview', 'cafe8888', '--json', '--local'], repoDir, tempHome);
      expect(ambiguous.status).toBe(1);
      expect(ambiguous.stdout).toBe('');
      expect(ambiguous.stderr).toContain(first);
      expect(ambiguous.stderr).toContain(second);

      const missing = runAgents(['ps', 'preview', 'bade9999', '--json', '--local'], repoDir, tempHome);
      expect(missing.status).toBe(1);
      expect(missing.stdout).toBe('');
      expect(missing.stderr).toContain('bade9999');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 90_000);

  it('exits 1 when the real parent cannot read the device registry', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ps-preview-registry-'));
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work');
      const devicesDir = path.join(tempHome, 'broken-devices');
      fs.mkdirSync(repoDir, { recursive: true });
      fs.mkdirSync(devicesDir, { recursive: true });
      fs.writeFileSync(path.join(devicesDir, 'registry.json'), '{broken');
      const result = runAgents(['ps', 'preview', 'abcd7777', '--json'], repoDir, tempHome, { AGENTS_DEVICES_DIR: devicesDir });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('device registry');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('fleet resolve outcomes', () => {
  it('resolves an id-shaped selector — full UUID or short prefix — even when unrelated fleet peers are unavailable', () => {
    const id = '019fd0c8-b3e9-77a2-a1a4-444698c4d897';
    const session: SessionMeta = {
      id,
      shortId: '019fd0c8',
      agent: 'codex',
      version: '0.146.0',
      mode: 'edit',
      machine: 'yosemite-s0',
      timestamp: '2026-08-05T09:29:43.616Z',
      filePath: '/sessions/codex.jsonl',
    };
    const offline = { sessions: [], unreachable: ['offline-box'] };
    expect(metadataResolveOutcome([session], offline, id)).toEqual({ kind: 'resolved', session });
    expect(metadataResolveOutcome([session], offline, '019fd0c8')).toEqual({ kind: 'resolved', session });
    expect(metadataResolveOutcome([session], offline, '019fd0c8-b3e9')).toEqual({ kind: 'resolved', session });
  });

  it('keeps a LABEL selector fail-closed when a peer is unreachable', () => {
    const session: SessionMeta = {
      id: '019fd0c8-b3e9-77a2-a1a4-444698c4d897',
      shortId: '019fd0c8',
      agent: 'codex',
      version: '0.146.0',
      mode: 'edit',
      machine: 'yosemite-s0',
      timestamp: '2026-08-05T09:29:43.616Z',
      filePath: '/sessions/codex.jsonl',
      label: 'release-train',
    };
    expect(metadataResolveOutcome([session], { sessions: [], unreachable: ['offline-box'] }, 'release-train')).toEqual({
      kind: 'partial',
      failedPeers: ['offline-box'],
    });
  });

  it('reports ambiguity — not a resolve — when two reachable sessions share the prefix', () => {
    const base = {
      agent: 'codex' as const,
      version: '0.146.0',
      mode: 'edit',
      timestamp: '2026-08-05T09:29:43.616Z',
    };
    const a: SessionMeta = { ...base, id: '019fd0c8-b3e9-77a2-a1a4-444698c4d897', shortId: '019fd0c8', machine: 'yosemite-s0', filePath: '/sessions/a.jsonl' };
    const b: SessionMeta = { ...base, id: '019fd0c8-aaaa-4bbb-8ccc-dddddddddddd', shortId: '019fd0c8', machine: 'yosemite-s1', filePath: '/sessions/b.jsonl' };
    expect(metadataResolveOutcome([a, b], { sessions: [], unreachable: ['offline-box'] }, '019fd0c8')).toEqual({
      kind: 'partial',
      failedPeers: ['offline-box'],
    });
    const settled = metadataResolveOutcome([a, b], { sessions: [], unreachable: [] }, '019fd0c8');
    expect(settled.kind).toBe('ambiguous');
    expect(settled.kind === 'ambiguous' && settled.candidates.map(c => c.id).sort()).toEqual([b.id, a.id].sort());
  });

  it('keeps a keyword-shaped selector fail-closed even though it is all hex characters', () => {
    const session: SessionMeta = {
      id: '019fd0c8-b3e9-77a2-a1a4-444698c4d897',
      shortId: '019fd0c8',
      agent: 'codex',
      version: '0.146.0',
      mode: 'edit',
      machine: 'yosemite-s0',
      timestamp: '2026-08-05T09:29:43.616Z',
      filePath: '/sessions/codex.jsonl',
      label: 'facade',
    };
    expect(isUniqueEnoughSelector('facade')).toBe(false);
    expect(isUniqueEnoughSelector('decade')).toBe(false);
    expect(isUniqueEnoughSelector('019fd0c8')).toBe(true);
    expect(isUniqueEnoughSelector('019fd0c8-b3e9-77a2-a1a4-444698c4d897')).toBe(true);
    expect(metadataResolveOutcome([session], { sessions: [], unreachable: ['offline-box'] }, 'facade')).toEqual({
      kind: 'partial',
      failedPeers: ['offline-box'],
    });
  });

  it('still reports partial for an id-shaped selector that matched nothing reachable', () => {
    expect(metadataResolveOutcome([], { sessions: [], unreachable: ['offline-box'] }, 'deadbeef')).toEqual({
      kind: 'partial',
      failedPeers: ['offline-box'],
    });
  });

  it('forwards resolver scope to every peer', () => {
    expect(metadataResolveForwardedArgs('recap resolver', { agent: 'codex@0.146.0', project: 'agents-cli' })).toEqual([
      'ps', 'resolve', 'recap resolver', '--json', '--local',
      '--agent', 'codex@0.146.0', '--project', 'agents-cli',
    ]);
  });
});
