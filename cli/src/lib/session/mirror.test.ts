import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate a fresh HOME BEFORE importing state/db — db.ts captures DB_PATH at
// module load (same pattern as the migration tests in this directory).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-mirror-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

// Pin this box's device id so the suite is independent of the host it runs on
// (PHNX-3850). Otherwise machineId() resolves to the real hostname: on a box
// literally named `yosemite-m6` it collides with the peer this file uses as a
// remote publisher, and consumeSessionMirrorFromSharedStore skips that peer's
// digest as "self" — the fold never runs and the placeholder-label overwrite is
// never exercised. A fixed id that matches no peer keeps self and every peer
// distinct on every machine.
process.env.AGENTS_SYNC_MACHINE_ID = 'mirror-test-self';

const { getSessionsDir, getUserAgentsDir } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const db = await import('./db.js');
const mirror = await import('./mirror.js');
const { readFleetSharedDeviceStates, updateFleetSharedDeviceState } = await import('../fleet-shared-state.js');
const { machineId } = await import('./sync/config.js');
const Database = (await import('../sqlite.js')).default;

const self = machineId();

function seedLocalSession(over: Partial<Parameters<typeof db.upsertSession>[0]> & { id: string }): void {
  const meta: any = {
    id: over.id,
    shortId: over.id.slice(0, 8),
    agent: 'claude',
    timestamp: '2026-09-01T10:00:00.000Z',
    lastActivity: '2026-09-01T10:30:00.000Z',
    filePath: `/tmp/${over.id}.jsonl`,
    machine: self,
    topic: 'do the thing',
    firstUserMessage: 'Please do the thing end to end and open a PR.',
    ...over,
  };
  db.upsertSession(meta, meta.firstUserMessage ?? '');
}

function rawRow(id: string): any {
  const d = new Database(path.join(getSessionsDir(), 'sessions.db'));
  try {
    return d.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  } finally {
    d.close();
  }
}

describe('session mirror (real DB + real shared-state files)', () => {
  it('publishes this box\'s local sessions into its owned shared-state file', async () => {
    seedLocalSession({ id: 'aaaaaaaa-0000-0000-0000-000000000001' });
    const root = getUserAgentsDir();
    const res = await mirror.publishSessionMirrorToSharedStore({ userAgentsDir: root });
    expect(res.published).toBe(true);
    expect(res.count).toBeGreaterThanOrEqual(1);

    const read = readFleetSharedDeviceStates(root);
    const mine = read.states.find((s) => s.device === self);
    expect(mine?.sessions?.rows?.length).toBeGreaterThanOrEqual(1);
    const row = mine!.sessions!.rows.find((r) => r.id === 'aaaaaaaa-0000-0000-0000-000000000001')!;
    expect(row.topic).toBe('do the thing');
    expect(row.firstUser).toContain('do the thing end to end');
    expect(row.machine).toBe(self);
  });

  it('folds a PEER\'s published digests into the local index as mirror rows and previews them inline', () => {
    const root = getUserAgentsDir();
    // A peer publishes a session that never existed on this box.
    updateFleetSharedDeviceState('yosemite-m5', {
      sessions: {
        rows: [{
          id: 'bbbbbbbb-0000-0000-0000-000000000002',
          shortId: 'bbbbbbbb',
          agent: 'claude',
          machine: 'yosemite-m5',
          topic: 'refactor the exec engine',
          firstUser: 'Refactor buildExecEnv so every dispatch path shares one env builder.',
          label: 'exec refactor',
          lastActivity: '2026-09-01T12:00:00.000Z',
          timestamp: '2026-09-01T11:00:00.000Z',
          ticketId: 'PHNX-9999',
          capturedAt: Date.now(),
        }],
      },
    }, root);

    const res = mirror.consumeSessionMirrorFromSharedStore({ userAgentsDir: root, device: self, role: 'personal' });
    expect(res.merged).toBe(1);
    expect(res.sources).toContain('yosemite-m5');

    const row = rawRow('bbbbbbbb-0000-0000-0000-000000000002');
    expect(row).toBeTruthy();
    expect(row.machine).toBe('yosemite-m5');
    expect(row.file_path).toBe('');
    expect(row.topic).toBe('refactor the exec engine');
    expect(row.label).toBe('exec refactor');
    expect(row.ticket_id).toBe('PHNX-9999');
    expect(row.mirror_synced_at).toBeGreaterThan(0);
    expect(row.mirror_source).toBe('yosemite-m5');
  });

  it('carries the peer\'s daemon-generated title both ways, so a remote row shows the SAME headline (PHNX-3797)', async () => {
    const root = getUserAgentsDir();
    const id = 'a1a1a1a1-0000-0000-0000-000000000011';
    seedLocalSession({ id, topic: 'wire the session titler' });
    db.setSessionGeneratedTitle(id, 'Daemon session titler', 'key-1');

    // Publish: this box's own title rides its shared-state file.
    await mirror.publishSessionMirrorToSharedStore({ userAgentsDir: root });
    const published = readFleetSharedDeviceStates(root).states
      .find((s) => s.device === self)!.sessions!.rows.find((r) => r.id === id)!;
    expect(published.title).toBe('Daemon session titler');

    // Consume: a peer's title lands on the mirror row this box renders.
    const peerId = 'b2b2b2b2-0000-0000-0000-000000000012';
    updateFleetSharedDeviceState('yosemite-m3', {
      sessions: {
        rows: [{
          id: peerId,
          shortId: 'b2b2b2b2',
          agent: 'claude',
          machine: 'yosemite-m3',
          topic: 'the fleet list headline is the agent last message',
          title: 'Session headline ladder fix',
          firstUser: 'Every row shows the agent latest message. Make it a real title.',
          lastActivity: '2026-09-01T13:00:00.000Z',
          timestamp: '2026-09-01T12:00:00.000Z',
          capturedAt: Date.now(),
        }],
      },
    }, root);
    mirror.consumeSessionMirrorFromSharedStore({ userAgentsDir: root, device: self, role: 'personal' });
    expect(rawRow(peerId).generated_title).toBe('Session headline ladder fix');
    expect(db.getSessionById(peerId)?.generatedTitle).toBe('Session headline ladder fix');
  });

  it('OVERWRITES a host-dispatch stub\'s [host/peer] placeholder label with the synced topic', () => {
    const root = getUserAgentsDir();
    // A local host-dispatch stub: peer machine, empty file, placeholder label, no topic.
    db.upsertSession({
      id: 'cccccccc-0000-0000-0000-000000000003',
      shortId: 'cccccccc',
      agent: 'claude',
      timestamp: '2026-09-01T09:00:00.000Z',
      filePath: '',
      machine: 'yosemite-m6',
      label: '[host/yosemite-m6]',
    } as any, '');

    updateFleetSharedDeviceState('yosemite-m6', {
      sessions: {
        rows: [{
          id: 'cccccccc-0000-0000-0000-000000000003',
          shortId: 'cccccccc',
          agent: 'claude',
          machine: 'yosemite-m6',
          topic: 'land the traces insight engine',
          firstUser: 'Ship the cross-session failure clustering.',
          lastActivity: '2026-09-01T09:30:00.000Z',
          timestamp: '2026-09-01T09:00:00.000Z',
          capturedAt: Date.now(),
        }],
      },
    }, root);

    mirror.consumeSessionMirrorFromSharedStore({ userAgentsDir: root, device: self, role: 'personal' });
    const row = rawRow('cccccccc-0000-0000-0000-000000000003');
    // The bare [host/peer] placeholder is gone; the list now renders the topic.
    expect(row.label).toBeNull();
    expect(row.topic).toBe('land the traces insight engine');
  });

  it('NEVER overwrites a genuine local transcript row', () => {
    const root = getUserAgentsDir();
    seedLocalSession({ id: 'dddddddd-0000-0000-0000-000000000004', topic: 'real local work' });
    // A peer claims the same id (shouldn't happen with UUIDs, but the guard must hold).
    const wrote = db.upsertMirrorSession(
      { id: 'dddddddd-0000-0000-0000-000000000004', shortId: 'dddddddd', agent: 'claude', machine: 'evil-peer', timestamp: '2026-09-01T00:00:00.000Z', topic: 'hijacked' },
      'evil-peer',
      Date.now(),
    );
    expect(wrote).toBe(false);
    const row = rawRow('dddddddd-0000-0000-0000-000000000004');
    expect(row.machine).toBe(self);
    expect(row.topic).toBe('real local work');
    expect(row.mirror_synced_at).toBeNull();
  });

  it('a worker skips the consume (the mirror feeds an interactive picker)', () => {
    const root = getUserAgentsDir();
    updateFleetSharedDeviceState('yosemite-s1', {
      sessions: { rows: [{ id: 'eeeeeeee-0000-0000-0000-000000000005', shortId: 'eeeeeeee', agent: 'claude', machine: 'yosemite-s1', topic: 'x', timestamp: '2026-09-01T00:00:00.000Z', capturedAt: Date.now() }] },
    }, root);
    const res = mirror.consumeSessionMirrorFromSharedStore({ userAgentsDir: root, device: self, role: 'worker' });
    expect(res.skipped).toMatch(/worker/);
    expect(res.merged).toBe(0);
    expect(rawRow('eeeeeeee-0000-0000-0000-000000000005')).toBeFalsy();
  });

  it('carries a session\'s daemon-computed summary through publish and consume (PHNX-3939)', () => {
    const root = getUserAgentsDir();
    const id = '99999999-0000-0000-0000-0000000000aa';
    seedLocalSession({ id, topic: 'add the summarizer' });
    db.writeSessionSummary({
      id,
      fileMtimeMs: 123,
      fileSize: 456,
      summary: {
        goal: 'Ship the per-session summarizer',
        checkpoints: [{ text: 'wrote the cache', at: '2026-09-05T00:00:00.000Z' }],
        summaryChecklist: [{ text: 'add the table', done: true }],
        summaryState: 'ready',
      },
    });

    // Publish: the local source query rides the summary alongside the digest.
    const source = db.queryLocalOriginSessionsForMirror(self, 200).find((s) => s.id === id)!;
    expect(source.summary?.goal).toBe('Ship the per-session summarizer');

    // A peer publishes the same digest+summary; consuming it lands the summary in
    // this box's session_summaries so the merge surfaces it with no transcript.
    updateFleetSharedDeviceState('yosemite-m2', {
      sessions: {
        rows: [{
          id: 'aaaaaaaa-0000-0000-0000-0000000000bb',
          shortId: 'aaaaaaaa',
          agent: 'claude',
          machine: 'yosemite-m2',
          topic: 'peer summary',
          timestamp: '2026-09-01T00:00:00.000Z',
          goal: 'Peer goal',
          checkpoints: [{ text: 'peer step', at: '2026-09-01T00:00:00.000Z' }],
          summaryChecklist: [{ text: 'peer item', done: false }],
          summaryState: 'ready',
          capturedAt: Date.now(),
        }],
      },
    }, root);
    const res = mirror.consumeSessionMirrorFromSharedStore({ userAgentsDir: root, device: self, role: 'personal' });
    // Other tests in this describe leave peer rows in the shared store, so assert
    // this session merged rather than an exact fleet-wide count.
    expect(res.merged).toBeGreaterThanOrEqual(1);
    const stored = db.readSessionSummaryAny('aaaaaaaa-0000-0000-0000-0000000000bb');
    expect(stored?.goal).toBe('Peer goal');
    expect(stored?.summaryState).toBe('ready');
    expect(stored?.summaryChecklist).toEqual([{ text: 'peer item', done: false }]);
  });

  it('bounds an oversized summary on publish exactly as consume caps it (PHNX-3939)', async () => {
    const root = getUserAgentsDir();
    const id = '99999999-0000-0000-0000-0000000000cc';
    seedLocalSession({ id, topic: 'bound the mirror' });
    db.writeSessionSummary({
      id,
      fileMtimeMs: 111,
      fileSize: 222,
      summary: {
        goal: 'Bound the publish side',
        // 70 > the 50 cap; 500-char text > the 400 cap; 47-char `at` > the 40 cap.
        checkpoints: Array.from({ length: 70 }, () => ({
          text: 'c'.repeat(500),
          at: '2026-09-05T00:00:00.000Z-overlongtimestampvalue',
        })),
        // 130 > the 100 cap; 500-char text > the 400 cap.
        summaryChecklist: Array.from({ length: 130 }, (_, i) => ({ text: 'k'.repeat(500), done: i % 2 === 0 })),
        summaryState: 'ready',
      },
    });

    const res = await mirror.publishSessionMirrorToSharedStore({ userAgentsDir: root });
    expect(res.published).toBe(true);

    const read = readFleetSharedDeviceStates(root);
    const row = read.states.find((s) => s.device === self)!.sessions!.rows.find((r) => r.id === id)!;
    // Item-count caps match toMirrorSummary's consume-side bounds (50 / 100).
    expect(row.checkpoints!.length).toBe(50);
    expect(row.summaryChecklist!.length).toBe(100);
    // Per-item length caps (text 400, `at` 40) — so a value that survives publish
    // is never re-truncated differently on consume.
    expect(row.checkpoints![0].text.length).toBe(400);
    expect(row.checkpoints![0].at.length).toBe(40);
    expect(row.summaryChecklist![0].text.length).toBe(400);
    expect(row.summaryChecklist![0].done).toBe(true);
  });

  it('carries the folded request/timeline/files through publish and consume (PHNX-3939)', async () => {
    const root = getUserAgentsDir();
    const id = '99999999-0000-0000-0000-0000000000dd';
    seedLocalSession({ id, topic: 'fold the timeline' });
    const { foldTimeline, projectSessionFiles, projectTimeline } = await import('./timeline.js');
    const at = (n: number) => new Date(Date.UTC(2026, 8, 6, 0, 0, n)).toISOString();
    const state = foldTimeline([
      { type: 'message', agent: 'claude', timestamp: at(0), role: 'user', content: 'Ship the sidebar timeline.' },
      { type: 'message', agent: 'claude', timestamp: at(1), role: 'assistant', content: 'Folding the transcript.' },
      { type: 'tool_use', agent: 'claude', timestamp: at(2), tool: 'Bash', callId: 'a', args: { command: 'gh pr create' }, command: 'gh pr create' },
      { type: 'file_change', agent: 'claude', timestamp: at(3), changes: [{ path: '/repo/src/timeline.ts', op: 'created' }] },
    ], undefined, { offset: 1024 });
    db.writeSessionTimeline({
      id, fileMtimeMs: 1, fileSize: 1024,
      timeline: {
        timeline: projectTimeline(state, 'working'),
        request: state.request!,
        files: projectSessionFiles(state)!,
        state,
      },
    });

    // Publish: the local source query rides the projection alongside the digest.
    const source = db.queryLocalOriginSessionsForMirror(self, 200).find((s) => s.id === id)!;
    expect(source.timeline?.request?.headline).toBe('Ship the sidebar timeline.');
    const res = await mirror.publishSessionMirrorToSharedStore({ userAgentsDir: root });
    expect(res.published).toBe(true);
    const published = readFleetSharedDeviceStates(root).states
      .find((st) => st.device === self)!.sessions!.rows.find((r) => r.id === id)!;
    expect(published.request?.headline).toBe('Ship the sidebar timeline.');
    expect(published.timeline?.steps.some((step) => step.marks?.includes('PR opened'))).toBe(true);
    expect(published.files?.changes[0].path).toBe('/repo/src/timeline.ts');
    // The per-verb breakdown the plan specifies the rendering in ("6 run ·
    // 2 blocked") and the live marker both ride the publish.
    const publishedLive = published.timeline!.steps.find((step) => step.live)!;
    expect(publishedLive.mix).toEqual({ git: 1 });

    // Consume: a peer's published projection lands in this box's cache.
    const peerId = 'bbbbbbbb-0000-0000-0000-0000000000dd';
    updateFleetSharedDeviceState('worker-9', {
      sessions: {
        rows: [{
          id: peerId, shortId: 'bbbbbbbb', agent: 'claude', machine: 'worker-9',
          topic: 'peer timeline', timestamp: '2026-09-01T00:00:00.000Z',
          request: published.request, timeline: published.timeline, files: published.files,
          capturedAt: Date.now(),
        }],
      },
    }, root);
    expect(mirror.consumeSessionMirrorFromSharedStore({ userAgentsDir: root, device: self, role: 'personal' }).merged)
      .toBeGreaterThanOrEqual(1);
    const stored = db.readSessionTimelineAny(peerId);
    expect(stored?.request?.headline).toBe('Ship the sidebar timeline.');
    expect(stored?.timeline.steps.length).toBe(published.timeline!.steps.length);
    expect(stored?.files?.changes[0].path).toBe('/repo/src/timeline.ts');
    // Consume must not silently drop what publish carried: a remote row that
    // loses `mix` renders no per-verb breakdown, and one that loses `live` while
    // keeping `now` makes the two halves disagree about what a live step is.
    const consumedLive = stored!.timeline.steps.find((step) => step.live)!;
    expect(consumedLive).toBeDefined();
    expect(consumedLive.mix).toEqual(publishedLive.mix);
    expect(consumedLive.now).toBe(publishedLive.now);
  });

  it('bounds an oversized or hostile timeline on BOTH publish and consume (PHNX-3939)', async () => {
    const root = getUserAgentsDir();
    const id = '99999999-0000-0000-0000-0000000000ee';
    seedLocalSession({ id, topic: 'bound the timeline' });
    const step = (i: number) => ({
      text: 's'.repeat(500), at: '2026-09-06T00:00:00.000Z', source: 'narration' as const,
      tools: i, failed: 0, blocked: 0, now: 'n'.repeat(500), marks: Array.from({ length: 9 }, () => 'm'.repeat(90)),
    });
    db.writeSessionTimeline({
      id, fileMtimeMs: 2, fileSize: 2048,
      timeline: {
        timeline: {
          steps: Array.from({ length: 25 }, (_, i) => step(i)),
          earlier: { steps: 3, tools: 4, failed: 1 },
          tools: 40, failed: 1, blocked: 2, spanMs: 900, state: 'ready',
        },
        request: {
          text: 'r'.repeat(5000), headline: 'h'.repeat(500), kind: 'text',
          attachments: Array.from({ length: 20 }, () => ({ kind: 'image' as const, name: 'a'.repeat(300) })),
          pastedLines: 3, turns: 2,
        },
        files: {
          changes: Array.from({ length: 30 }, (_, i) => ({ path: `/repo/f${i}.ts`, op: 'modified' as const, edits: 1, at: '2026-09-06T00:00:00.000Z' })),
          total: 30, source: 'tools',
        },
        state: (await import('./timeline.js')).emptyTimelineState(),
      },
    });

    expect((await mirror.publishSessionMirrorToSharedStore({ userAgentsDir: root })).published).toBe(true);
    const row = readFleetSharedDeviceStates(root).states
      .find((st) => st.device === self)!.sessions!.rows.find((r) => r.id === id)!;
    expect(row.timeline!.steps.length).toBe(mirror.SESSION_MIRROR_MAX_STEPS);
    expect(row.timeline!.steps[0].text.length).toBe(mirror.SESSION_MIRROR_STEP_TEXT_MAX);
    expect(row.timeline!.steps[0].marks!.length).toBe(4);
    expect(row.request!.text.length).toBe(mirror.SESSION_MIRROR_REQUEST_MAX);
    expect(row.request!.attachments.length).toBe(mirror.SESSION_MIRROR_MAX_FILES);
    expect(row.files!.changes.length).toBe(mirror.SESSION_MIRROR_MAX_FILES);
    // Counters are NEVER truncated — only text is.
    expect(row.timeline!.tools).toBe(40);
    expect(row.files!.total).toBe(30);

    // Consume applies the same caps to an untrusted peer, and drops a malformed
    // timeline whole rather than trusting half of it.
    const peerId = 'cccccccc-0000-0000-0000-0000000000ee';
    updateFleetSharedDeviceState('worker-8', {
      sessions: {
        rows: [{
          id: peerId, shortId: 'cccccccc', agent: 'claude', machine: 'worker-8',
          topic: 'hostile peer', timestamp: '2026-09-01T00:00:00.000Z',
          request: { headline: 'x'.repeat(900), text: 'y'.repeat(9000), kind: 'nonsense', attachments: 'not-an-array', pastedLines: -5, turns: 'lots' },
          timeline: { steps: Array.from({ length: 40 }, (_, i) => step(i)), earlier: null, tools: 'many', state: 'bogus' },
          files: { changes: 'nope', total: -1, source: 'elsewhere' },
          capturedAt: Date.now(),
        } as never],
      },
    }, root);
    mirror.consumeSessionMirrorFromSharedStore({ userAgentsDir: root, device: self, role: 'personal' });
    // `state: 'bogus'` is not a timeline, so nothing is stored for that peer.
    expect(db.readSessionTimelineAny(peerId)).toBeUndefined();
  });

  it('prunes only stale mirror rows, never a real or fresh one', () => {
    const now = Date.now();
    seedLocalSession({ id: 'ffffffff-0000-0000-0000-000000000006', topic: 'keep me local' });
    db.upsertMirrorSession({ id: '11111111-0000-0000-0000-000000000007', shortId: '11111111', agent: 'claude', machine: 'peer-a', timestamp: '2026-09-01T00:00:00.000Z', topic: 'stale' }, 'peer-a', now - mirror.SESSION_MIRROR_MAX_AGE_MS - 60_000);
    db.upsertMirrorSession({ id: '22222222-0000-0000-0000-000000000008', shortId: '22222222', agent: 'claude', machine: 'peer-a', timestamp: '2026-09-01T00:00:00.000Z', topic: 'fresh' }, 'peer-a', now);

    const pruned = db.pruneMirrorSessions(now - mirror.SESSION_MIRROR_MAX_AGE_MS);
    expect(pruned).toBe(1);
    expect(rawRow('11111111-0000-0000-0000-000000000007')).toBeFalsy();
    expect(rawRow('22222222-0000-0000-0000-000000000008')).toBeTruthy();
    expect(rawRow('ffffffff-0000-0000-0000-000000000006')).toBeTruthy();
  });

  it('keeps every session_text row at its session\'s rowid across local upsert, re-upsert, mirror fold and prune (PHNX-4154)', () => {
    // Every writer above ran in this suite: seedLocalSession (twice for one id
    // — a rescan must replace, not duplicate), the peer fold, the placeholder
    // overwrite, and the prune. The text row of each survivor must sit at its
    // session's rowid, and a pruned session must leave no text row behind —
    // a stray row is unreachable by rowid and would only ever be found by
    // the full scan this fix removed.
    seedLocalSession({ id: 'ffffffff-0000-0000-0000-000000000006', topic: 'keep me local, rescanned' });
    const d = new Database(path.join(getSessionsDir(), 'sessions.db'));
    try {
      expect(d.prepare(`
        SELECT t.session_id FROM session_text t
        LEFT JOIN sessions s ON s.rowid = t.rowid
        WHERE s.id IS NULL OR s.id <> t.session_id
      `).all()).toEqual([]);
      expect(d.prepare(`
        SELECT session_id FROM session_text GROUP BY session_id HAVING count(*) > 1
      `).all()).toEqual([]);
      expect(d.prepare(`SELECT count(*) AS n FROM session_text WHERE session_id = ?`)
        .get('11111111-0000-0000-0000-000000000007')).toEqual({ n: 0 });
    } finally {
      d.close();
    }
  });
});

describe('a mirror row reclaimed by a real local transcript (PHNX-3792 blocker fix)', () => {
  const ID = '33333333-0000-0000-0000-000000000009';

  it('clears the mirror stamp on a genuine local write, so prune cannot delete it and it re-publishes', () => {
    // 1. Seed the id as a peer mirror row (empty file_path, mirror_synced_at set).
    const staleSync = Date.now() - mirror.SESSION_MIRROR_MAX_AGE_MS - 60_000;
    db.upsertMirrorSession(
      { id: ID, shortId: '33333333', agent: 'claude', machine: 'peer-b', timestamp: '2026-09-01T00:00:00.000Z', topic: 'from peer' },
      'peer-b',
      staleSync,
    );
    const asMirror = rawRow(ID);
    expect(asMirror.mirror_synced_at).toBe(staleSync);
    expect(asMirror.file_path === '' || asMirror.file_path == null).toBe(true);

    // 2. The same id then gains a genuine LOCAL transcript via the ordinary scan path.
    seedLocalSession({ id: ID, topic: 'now local', firstUserMessage: 'real transcript content' });
    const asLocal = rawRow(ID);
    expect(asLocal.mirror_synced_at).toBeNull();   // stamp cleared by the real write
    expect(asLocal.mirror_source).toBeNull();
    expect(asLocal.file_path).toBeTruthy();

    // 3. (a) Prune with a cutoff PAST the original stale stamp — the reclaimed row
    // survives because its stamp is now NULL, not because it is fresh. (The prune
    // count is not asserted: this file shares one DB, so other tests' mirror rows
    // also fall in the cutoff — what matters is that THIS real local row is spared.)
    db.pruneMirrorSessions(Date.now());
    expect(rawRow(ID)).toBeTruthy();

    // 4. (b) It is re-publishable as a genuine local-origin row again.
    const publishable = db.queryLocalOriginSessionsForMirror(self, 200).map((r) => r.id);
    expect(publishable).toContain(ID);
  });
});
