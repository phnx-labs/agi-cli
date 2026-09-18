import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  metadataResolveOutcome,
  isUniqueEnoughSelector,
  metadataResolveForwardedArgs,
} from './sessions.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { repoRoot, writeUpdateCache, writeClaudeSession, runAgents } from './sessions.test-fixture.js';

describe('resolveSessionQuery indexed metadata coverage', () => {
  it('resolves complete and partial ids from the real index without using text matches', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-resolve-index-'));
    try {
      const runner = [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "const { upsertSession, closeDB } = await import('./src/lib/session/db.ts');",
        "const { resolveSessionQuery } = await import('./src/commands/sessions.ts');",
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
        // PHNX-2767: a content phrase against an empty listing pool still
        // hydrates the FTS hit. Id-shaped selectors (mention / prefix /
        // noFallback) stay id-only and must not fall through to this path.
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
        "const { resolveSessionMetadataValue } = await import('./src/commands/sessions.ts');",
        "const home = process.env.HOME;",
        "const id = '019fd0c8-b3e9-77a2-a1a4-444698c4d897';",
        "const filePath = path.join(home, id + '.jsonl'); fs.writeFileSync(filePath, '');",
        "upsertSession({ id, shortId: id.slice(0, 8), agent: 'claude', timestamp: new Date().toISOString(), filePath, label: 'ship the resume fix' }, '');",
        // Any dial throws so we can prove whether a peer was contacted.
        "let dialed = 0;",
        "const deps = { gatherRemoteList: async () => { dialed++; throw new Error('SSH DIALED'); } };",
        // Full UUID: globally unique, resolves before any fan-out (dialed stays 0).
        "const byId = await resolveSessionMetadataValue(id, {}, deps);",
        "const idDials = dialed;",
        // Label: NOT globally unique, so it must consult the fleet (a peer could
        // hold a same-label session) — the throwing dep makes it fail closed.
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
        idDials: 0,          // zero SSH: the local index answered the UUID lookup
        byLabelKind: 'partial', // label failed closed because the (throwing) fleet was consulted
        labelDialed: true,   // the label DID reach the fan-out
      });
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('agents sessions --resolve local-peer critical path', () => {
  // 90s, not the default 30s: several real `agents` CLI boots, measured 8.1s
  // idle and 15.0s under 16 CPU-bound background processes (RUSH-2839).
  it('resolves a full id, unique prefix, and keywords through the metadata-only CLI contract', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-resolve-local-'));
    try {
      writeUpdateCache(tempHome);
      const repoDir = path.join(tempHome, 'work', 'agents-cli');
      const sessionId = 'face7777-1111-4222-8333-444455556666';
      writeClaudeSession(tempHome, 'resolve-local', sessionId, repoDir, 'needle metadata contract', '2026-08-03T09:00:00.000Z');
      const indexed = runAgents(['sessions', '--all', '--json', '--local'], repoDir, tempHome);
      expect(indexed.status, indexed.stderr).toBe(0);

      for (const selector of [sessionId, 'face7777', 'needle metadata contract']) {
        const result = runAgents(['sessions', '--resolve', selector, '--json', '--local'], repoDir, tempHome);
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
    // A short id is a UUID prefix, so an offline peer cannot be hiding a second
    // session that shares it — one reachable hit is the answer, not a `partial`.
    expect(metadataResolveOutcome([session], offline, '019fd0c8')).toEqual({ kind: 'resolved', session });
    expect(metadataResolveOutcome([session], offline, '019fd0c8-b3e9')).toEqual({ kind: 'resolved', session });
  });

  it('keeps a LABEL selector fail-closed when a peer is unreachable', () => {
    // Unlike an id, a label is not unique across the fleet: the offline box may
    // genuinely hold a different session carrying the same label, so resolving
    // from one reachable hit would be a guess.
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
    // The accepted risk in SES-9a is bounded by this: a prefix collision among
    // peers that ANSWERED still surfaces, because each distinct full id is its
    // own candidate. Only a collision hiding on a peer that never answered can
    // slip through, which is the trade the spec names explicitly.
    const base = {
      agent: 'codex' as const,
      version: '0.146.0',
      mode: 'edit',
      timestamp: '2026-08-05T09:29:43.616Z',
    };
    const a: SessionMeta = { ...base, id: '019fd0c8-b3e9-77a2-a1a4-444698c4d897', shortId: '019fd0c8', machine: 'yosemite-s0', filePath: '/sessions/a.jsonl' };
    const b: SessionMeta = { ...base, id: '019fd0c8-aaaa-4bbb-8ccc-dddddddddddd', shortId: '019fd0c8', machine: 'yosemite-s1', filePath: '/sessions/b.jsonl' };
    // With a peer still missing, two candidates means we cannot claim
    // uniqueness at all — fail closed rather than pick one.
    expect(metadataResolveOutcome([a, b], { sessions: [], unreachable: ['offline-box'] }, '019fd0c8')).toEqual({
      kind: 'partial',
      failedPeers: ['offline-box'],
    });
    // Once every peer has answered, the same collision surfaces as a real
    // ambiguity listing both machines — never a silent resolve.
    const settled = metadataResolveOutcome([a, b], { sessions: [], unreachable: [] }, '019fd0c8');
    expect(settled.kind).toBe('ambiguous');
    expect(settled.kind === 'ambiguous' && settled.candidates.map(c => c.id).sort()).toEqual([b.id, a.id].sort());
  });

  it('keeps a keyword-shaped selector fail-closed even though it is all hex characters', () => {
    // looksLikeSessionId accepts any 6+ char [0-9a-f-] run, so ordinary words
    // like `facade` and `decade` match it. Those are searches, not identifiers,
    // and must still wait for every peer.
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
    // Nothing was found here, so the session may well live on the offline peer —
    // that is the case where an unreachable box genuinely changes the answer.
    expect(metadataResolveOutcome([], { sessions: [], unreachable: ['offline-box'] }, 'deadbeef')).toEqual({
      kind: 'partial',
      failedPeers: ['offline-box'],
    });
  });

  it('forwards resolver scope to every peer', () => {
    expect(metadataResolveForwardedArgs('recap resolver', { agent: 'codex@0.146.0', project: 'agents-cli' })).toEqual([
      'sessions', '--resolve-safe-v1', 'recap resolver', '--json', '--all', '--local',
      '--agent', 'codex@0.146.0', '--project', 'agents-cli',
    ]);
  });
});
