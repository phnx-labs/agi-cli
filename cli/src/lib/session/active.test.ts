import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveCwds, enrichProvenance, LSOF_CONCURRENCY, agentKindFromComm, sessionAgentComms, activeStatusFromCloudStatus, resolveFallbackStatus, lifecycleStatus, ABANDONED_STALE_MS, resolvePaneIdentity, matchOriginDevice, annotateOrchestratorLabels, summarizeMission, deriveSessionRecap, foldRecap, isReapableOrphan, backfillActiveRowsFromMeta } from './active.js';
import type { ActiveSession } from './active.js';
import { SESSION_AGENTS } from './types.js';
import type { HookSessionIndex } from './hook-sessions.js';
import type { DeviceProfile, DeviceRegistry } from '../devices/registry.js';

describe('resolvePaneIdentity (per-pane attribution for the authoritative tmux source)', () => {
  const emptyHook = (): HookSessionIndex => ({ byLaunchId: new Map(), byTerminalId: new Map(), byPid: new Map() });
  const meta = (labels: Record<string, string>, extra: { source?: string; pane?: string } = {}) => ({ labels, source: extra.source ?? 'cli', pane: extra.pane });
  // These cases exercise the meta/registry/hook precedence in isolation, so they
  // pass a non-`ag-*` session name and an empty name map — the name-based tier is
  // covered separately in active.tmux-identity.test.ts.
  const NO_NAMES = new Map<string, string>();

  it('the per-pane launch registry WINS over the session meta label (a split into an existing session)', () => {
    // The session was originally a wrapped claude, but THIS pane hosts a gemini
    // bare-spawned into a split — it must be attributed to its own launch.
    const id = resolvePaneIdentity(
      '%2',
      'shell',
      meta({ agent: 'claude', sessionId: 'origin-id' }, { pane: '%1' }),
      { pid: 5, agent: 'gemini', sessionId: 'gem-id', startedAtMs: 1 },
      emptyHook,
      NO_NAMES,
    );
    expect(id).toEqual({ agent: 'gemini', sessionId: 'gem-id', pid: 5 });
  });

  it('a registry entry with no recorded id joins the SessionStart hook by launchId (non-Claude split)', () => {
    const idx: HookSessionIndex = {
      byLaunchId: new Map([['L1', { session_id: 'hook-id', agent: 'gemini', pid: 5 }]]),
      byTerminalId: new Map(),
      byPid: new Map(),
    };
    const id = resolvePaneIdentity('%2', 'shell', null, { pid: 5, agent: 'gemini', launchId: 'L1', startedAtMs: 1 }, () => idx, NO_NAMES);
    expect(id).toEqual({ agent: 'gemini', sessionId: 'hook-id', pid: 5 });
  });

  it('falls back to session-meta labels on the ORIGIN pane when it has no live launch entry (legacy)', () => {
    const id = resolvePaneIdentity('%1', 'shell', meta({ agent: 'claude', sessionId: 'meta-id' }, { pane: '%1' }), undefined, emptyHook, NO_NAMES);
    expect(id).toEqual({ agent: 'claude', sessionId: 'meta-id' });
  });

  it('does NOT mis-attribute the wrapped agent to a non-origin shell split pane (no name signal)', () => {
    // A split shell pane (%2) of a labeled session, no registry entry, and no
    // usable ag-* name: must be skipped so the origin pane (%1) is the only one
    // that emits the wrapped agent.
    const id = resolvePaneIdentity('%2', 'shell', meta({ agent: 'claude', sessionId: 'meta-id' }, { pane: '%1' }), undefined, emptyHook, NO_NAMES);
    expect(id).toBeUndefined();
  });

  it('accepts any labeled pane when meta.pane is unknown (attach-existing sessions)', () => {
    const id = resolvePaneIdentity('%9', 'shell', meta({ agent: 'claude', sessionId: 'meta-id' }), undefined, emptyHook, NO_NAMES);
    expect(id).toEqual({ agent: 'claude', sessionId: 'meta-id' });
  });

  it('skips a teams pane (teammates come from listTeamsActive, never double-counted here)', () => {
    const id = resolvePaneIdentity(
      '%1',
      'ag-claude-aaaaaaaa',
      meta({ agent: 'claude', sessionId: 'x' }, { source: 'teams' }),
      { pid: 5, agent: 'claude', sessionId: 'x', startedAtMs: 1 },
      emptyHook,
      NO_NAMES,
    );
    expect(id).toBeUndefined();
  });

  it('returns undefined for an unlabeled pane with no launch entry and no ag-* name (a plain shell split)', () => {
    expect(resolvePaneIdentity('%1', 'shell', null, undefined, emptyHook, NO_NAMES)).toBeUndefined();
    expect(resolvePaneIdentity('%1', 'shell', meta({}), undefined, emptyHook, NO_NAMES)).toBeUndefined();
  });
});

describe('resolveFallbackStatus (a LIVE process never resolves to unknown)', () => {
  const tmp: string[] = [];
  const mkfile = (ageMs: number): string => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agents-fallback-')), 'sess.jsonl');
    fs.writeFileSync(p, '{}\n');
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(p, when, when);
    tmp.push(p);
    return p;
  };
  const gonePath = (): string => {
    const p = path.join(os.tmpdir(), `agents-fallback-missing-${process.pid}-${tmp.length}.jsonl`);
    try { fs.unlinkSync(p); } catch { /* already absent */ }
    return p;
  };

  it('no transcript + a LIVE process ⇒ running (the honest live floor, never unknown)', () => {
    // The blanket `unknown` for a live gemini/droid/cursor/opencode is gone: the
    // process being alive is itself a positive signal — report `running`.
    expect(resolveFallbackStatus(undefined, true)).toBe('running');
  });

  it('a LIVE process is running regardless of transcript freshness — fresh, stale, or vanished', () => {
    // Never a fabricated `idle` for a live process, even when its (opaque) file is
    // stale or has vanished mid-read.
    expect(resolveFallbackStatus(mkfile(10_000), true)).toBe('running');
    expect(resolveFallbackStatus(mkfile(5 * 60_000), true)).toBe('running');
    expect(resolveFallbackStatus(gonePath(), true)).toBe('running');
  });

  it('a DEAD process with a fresh transcript ⇒ closed (not the old fabricated idle)', () => {
    // RUSH-2066: a dead pid used to report `idle` ("done, waiting for you"), a lie.
    // The process has exited — say so.
    expect(resolveFallbackStatus(mkfile(5 * 60_000), false)).toBe('closed');
  });

  it('a DEAD process with no transcript ⇒ closed (death is a definitive answer)', () => {
    expect(resolveFallbackStatus(undefined, false)).toBe('closed');
  });

  it('a DEAD process whose transcript vanished ⇒ closed (still definitively dead)', () => {
    // Previously `unknown`; the process being dead is knowable even when the file
    // is gone, so `closed` is the honest answer, not `unknown`.
    expect(resolveFallbackStatus(gonePath(), false)).toBe('closed');
  });

  it('a DEAD process whose transcript is days-stale ⇒ abandoned (outranks closed)', () => {
    expect(resolveFallbackStatus(mkfile(3 * 24 * 60 * 60_000), false)).toBe('abandoned');
  });

  it('a LIVE process whose transcript is days-stale ⇒ abandoned (hung / dangling)', () => {
    // The user's case: a session alive but making no progress for days. Even though
    // the pid is alive, no writes for ABANDONED_STALE_MS means it is dangling.
    expect(resolveFallbackStatus(mkfile(3 * 24 * 60 * 60_000), true)).toBe('abandoned');
  });

  afterAll(() => {
    for (const p of tmp) { try { fs.rmSync(path.dirname(p), { recursive: true, force: true }); } catch { /* best-effort */ } }
  });
});

describe('lifecycleStatus (framework-computed from PID + mtime, never self-reported)', () => {
  const now = 1_700_000_000_000;
  const DAY = 24 * 60 * 60_000;

  it('alive + fresh ⇒ undefined (defer to the activity engine)', () => {
    expect(lifecycleStatus(true, now - 30_000, now)).toBeUndefined();
    expect(lifecycleStatus(true, undefined, now)).toBeUndefined();
  });

  it('dead + fresh ⇒ closed', () => {
    expect(lifecycleStatus(false, now - 5 * 60_000, now)).toBe('closed');
  });

  it('dead + no mtime ⇒ closed', () => {
    expect(lifecycleStatus(false, undefined, now)).toBe('closed');
  });

  it('days-stale ⇒ abandoned, whether alive or dead (abandoned outranks closed)', () => {
    expect(lifecycleStatus(false, now - 3 * DAY, now)).toBe('abandoned');
    expect(lifecycleStatus(true, now - 3 * DAY, now)).toBe('abandoned');
  });

  it('exactly at the abandoned threshold ⇒ abandoned (>= boundary is inclusive)', () => {
    expect(lifecycleStatus(true, now - ABANDONED_STALE_MS, now)).toBe('abandoned');
    // one ms under the threshold: not yet abandoned (alive ⇒ defer)
    expect(lifecycleStatus(true, now - ABANDONED_STALE_MS + 1, now)).toBeUndefined();
  });
});

describe('agentKindFromComm', () => {
  it('matches a real agent CLI by basename (absolute path or bare name)', () => {
    expect(agentKindFromComm('/Users/u/.bun/bin/codex')).toBe('codex');
    expect(agentKindFromComm('claude')).toBe('claude');
    expect(agentKindFromComm('claude.exe')).toBe('claude');
  });

  it('does NOT match the Codex desktop app-server bundled inside Codex.app', () => {
    // The desktop app ships a binary literally named `codex`; without the bundle
    // guard its `app-server` (cwd '/') surfaces as a phantom agent session.
    expect(agentKindFromComm('/Applications/Codex.app/Contents/Resources/codex')).toBeUndefined();
  });

  it('does NOT match the Claude desktop app (named Claude, not the CLI claude)', () => {
    expect(agentKindFromComm('/Applications/Claude.app/Contents/MacOS/Claude')).toBeUndefined();
  });

  // Harness-parity regression guard (RUSH-2205): every SESSION_AGENTS member must
  // resolve from at least one process comm name, so a bare-headless run of any
  // discoverable harness (grok/kimi/antigravity/openclaw/hermes/rush) is never
  // silently dropped by the ps-scan. Asserted off the registry-derived source so
  // adding a SESSION_AGENT without a comm fails here instead of at runtime.
  it('resolves every SESSION_AGENTS member to its id via at least one comm', () => {
    for (const id of SESSION_AGENTS) {
      const comms = sessionAgentComms(id);
      expect(comms.length, `${id} has no process comm name`).toBeGreaterThan(0);
      for (const comm of comms) {
        expect(agentKindFromComm(comm), `${id} comm '${comm}' unresolved`).toBe(id);
      }
    }
  });

  it('recognizes the previously-dropped headless harnesses', () => {
    // These six were the AGENT_CLI_NAMES gap before RUSH-2205 — `if (!kind) continue`
    // silently dropped their headless processes from --orphan/--active.
    expect(agentKindFromComm('grok')).toBe('grok');
    expect(agentKindFromComm('kimi')).toBe('kimi');
    expect(agentKindFromComm('agy')).toBe('antigravity');
    expect(agentKindFromComm('openclaw')).toBe('openclaw');
    expect(agentKindFromComm('hermes')).toBe('hermes');
    expect(agentKindFromComm('rush')).toBe('rush');
  });
});

describe('activeStatusFromCloudStatus', () => {
  it('preserves resumable idle cloud tasks as idle sessions', () => {
    expect(activeStatusFromCloudStatus('idle')).toBe('idle');
  });

  it('maps cloud statuses into the active-session status vocabulary', () => {
    expect(activeStatusFromCloudStatus('running')).toBe('running');
    expect(activeStatusFromCloudStatus('input_required')).toBe('input_required');
    expect(activeStatusFromCloudStatus('queued')).toBe('queued');
    expect(activeStatusFromCloudStatus('allocating')).toBe('queued');
  });
});

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('resolveCwds', () => {
  it('bounds the lsof fan-out to LSOF_CONCURRENCY (no simultaneous burst)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const pids = Array.from({ length: 30 }, (_, i) => i + 1000);
    // Probe outlasts the stagger so windows overlap — this is what would let an
    // unbounded fan-out (Promise.all) pile all 30 up at once. The bound must cap it.
    const probe = async (pid: number): Promise<string | undefined> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(30);
      inFlight--;
      return `/cwd/${pid}`;
    };

    const cwds = await resolveCwds(pids, probe);

    // The whole point of the mitigation: never all-at-once (unbounded => 30).
    expect(maxInFlight).toBeLessThanOrEqual(LSOF_CONCURRENCY);
    expect(maxInFlight).toBeGreaterThan(1); // still concurrent within the bound, not serial
    // Contract preserved: one cwd per pid, in input order.
    expect(cwds).toEqual(pids.map(p => `/cwd/${p}`));
  });

  it('preserves per-pid alignment even when probes finish out of order', async () => {
    const pids = [5, 4, 3, 2, 1];
    const probe = async (pid: number): Promise<string | undefined> => {
      await delay(pid * 3); // pid 1 finishes last though it may start first
      return `cwd-${pid}`;
    };
    const cwds = await resolveCwds(pids, probe);
    expect(cwds).toEqual(['cwd-5', 'cwd-4', 'cwd-3', 'cwd-2', 'cwd-1']);
  });
});

describe('enrichProvenance', () => {
  it('bounds real provenance subprocesses to LSOF_CONCURRENCY', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const sessions = Array.from({ length: 30 }, (_, i) => ({ pid: i + 1000 })) as Parameters<typeof enrichProvenance>[0];
    const probe = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await promisify(execFile)(process.execPath, ['-e', 'setTimeout(() => {}, 20)']);
        return { host: 'test', transport: 'local' as const, reply: null };
      } finally {
        inFlight--;
      }
    };

    await enrichProvenance(sessions, probe);

    expect(maxInFlight).toBeLessThanOrEqual(LSOF_CONCURRENCY);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(sessions.every(s => s.provenance?.host === 'test')).toBe(true);
  });
});

describe('matchOriginDevice (resolve an ssh client IP to the initiating device)', () => {
  const device = (name: string, over: Partial<DeviceProfile> = {}): DeviceProfile => ({
    name,
    platform: 'macos',
    shell: 'posix',
    address: { via: 'tailscale', ip: '100.0.0.1', dnsName: `${name}.tailnet.ts.net` },
    auth: { method: 'key' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  const reg: DeviceRegistry = {
    zion: device('zion', { user: 'muqsit', address: { via: 'tailscale', ip: '100.126.152.114', dnsName: 'zion.tailnet.ts.net' } }),
    'yosemite-s0': device('yosemite-s0', { address: { via: 'tailscale', ip: '100.125.135.113' } }),
    // A manually-added device with no resolvable IP must never match.
    'no-ip': device('no-ip', { address: { via: 'manual' } }),
  };

  it('resolves a client IP to its device + ssh login user', () => {
    expect(matchOriginDevice('100.126.152.114', reg)).toEqual({ device: 'zion', user: 'muqsit' });
  });

  it('omits user when the device has none', () => {
    expect(matchOriginDevice('100.125.135.113', reg)).toEqual({ device: 'yosemite-s0' });
  });

  it('returns undefined for an IP that matches no device', () => {
    expect(matchOriginDevice('10.0.0.99', reg)).toBeUndefined();
  });

  it('skips a device that has no IP address', () => {
    // '' would falsely match a device whose address.ip is undefined if the guard
    // were missing; assert the no-ip device is never returned.
    expect(matchOriginDevice('', reg)).toBeUndefined();
  });
});

describe('annotateOrchestratorLabels (team lineage — which session spun up a team)', () => {
  const row = (over: Partial<import('./active.js').ActiveSession>) =>
    ({ context: 'teams', kind: 'claude', status: 'working', ...over }) as any;

  it('resolves a teammate\'s orchestrator label from the orchestrator\'s own row', () => {
    const orchestrator = row({ sessionId: 'orch-1234', context: 'terminal', label: 'refactor auth' });
    const teammate = row({ sessionId: 'mate-abcd', teamName: 'my-feature', orchestratorSessionId: 'orch-1234' });
    annotateOrchestratorLabels([orchestrator, teammate]);
    expect(teammate.orchestratorLabel).toBe('refactor auth');
  });

  it('falls back to the orchestrator topic when it has no label', () => {
    const orchestrator = row({ sessionId: 'orch-1234', context: 'terminal', topic: 'ship the CLI' });
    const teammate = row({ sessionId: 'mate-abcd', teamName: 't', orchestratorSessionId: 'orch-1234' });
    annotateOrchestratorLabels([orchestrator, teammate]);
    expect(teammate.orchestratorLabel).toBe('ship the CLI');
  });

  it('leaves orchestratorLabel unset when the orchestrator is not in the active set', () => {
    const teammate = row({ sessionId: 'mate-abcd', teamName: 't', orchestratorSessionId: 'gone-9999' });
    annotateOrchestratorLabels([teammate]);
    expect(teammate.orchestratorLabel).toBeUndefined();
  });

  it('does nothing for a non-team row with no orchestrator link', () => {
    const solo = row({ sessionId: 's1', context: 'terminal', label: 'x' });
    annotateOrchestratorLabels([solo]);
    expect(solo.orchestratorLabel).toBeUndefined();
  });
});

describe('deriveSessionRecap (recap ladder — show what the agent DID, not the first prompt)', () => {
  it('prefers a /rename label over everything', () => {
    const r = deriveSessionRecap({ label: 'ship the auth fix', topic: 'first prompt', tail: ['agent last line'] });
    expect(r).toMatchObject({ title: 'ship the auth fix', recapSource: 'label' });
  });

  it('uses the last agent line when there is no label (the always-current fix)', () => {
    const r = deriveSessionRecap({ topic: 'add a widget', tail: ['opened PR #123', 'now fixing CI'] });
    expect(r).toMatchObject({ title: 'now fixing CI', recapSource: 'last', lastAgentLine: 'now fixing CI' });
  });

  it('falls back to the first-prompt topic only as a last resort', () => {
    const r = deriveSessionRecap({ topic: 'add a widget' });
    expect(r).toMatchObject({ title: 'add a widget', recapSource: 'prompt' });
  });

  it('cleans an image-path first prompt into the userPrompt fields', () => {
    const r = deriveSessionRecap({ topic: '/Users/muqsit/Screenshots/CleanShot 2026-08-20 at 1.png' });
    expect(r).toMatchObject({ userPromptClean: '[image]', userPromptKind: 'image' });
  });

  it('foldRecap writes the fields onto every row', () => {
    const rows: ActiveSession[] = [{ context: 'terminal', kind: 'claude', status: 'running', tail: ['did the thing'] }];
    foldRecap(rows);
    expect(rows[0]).toMatchObject({ title: 'did the thing', recapSource: 'last' });
  });

  // PHNX-3939: the prompt rung used to classify the already-collapsed `topic`,
  // which `extractSessionTopic` filled from scaffolding the turn cleaner rejects.
  it('classifies the raw LATEST genuine turn, not the collapsed topic', () => {
    const r = deriveSessionRecap({
      topic: 'Set model to `Fable 5.1` and saved as your default',
      firstUserMessage: 'Start the migration.',
      lastUserMessage: 'Actually, revert it and open a PR instead.',
    });
    expect(r.request?.headline).toBe('Actually, revert it and open a PR instead.');
    expect(r.userPromptClean).toBe('Actually, revert it and open a PR instead.');
    expect(r.title).toBe('Actually, revert it and open a PR instead.');
  });

  it('falls back to the first turn when only that is known', () => {
    const r = deriveSessionRecap({ firstUserMessage: 'Build the parser.', topic: 'Build the parser' });
    expect(r.request?.headline).toBe('Build the parser.');
  });

  it('sees the row attachments, so an image-only turn reads as [image] with a chip', () => {
    const r = deriveSessionRecap({
      lastUserMessage: '/Users/dev/Screenshots/CleanShot 2026-08-20 at 1.png',
      attachments: [{ name: 'CleanShot 2026-08-20 at 1.png', mediaType: 'image/png' }],
    });
    expect(r.userPromptKind).toBe('image');
    expect(r.request?.attachments).toEqual([{ kind: 'image', name: 'CleanShot 2026-08-20 at 1.png' }]);
  });

  it('uses an already-merged daemon-folded request rather than re-deriving one', () => {
    const request = {
      text: 'Fix the watcher.', headline: 'Fix the watcher.', kind: 'text' as const,
      attachments: [], pastedLines: 0, turns: 4,
    };

    const r = deriveSessionRecap({ request, lastUserMessage: 'something else entirely' });
    expect(r.request).toBe(request);
    expect(r.userPromptClean).toBe('Fix the watcher.');
  });

  it('keeps the legacy topic classifier when there is no genuine turn at all', () => {
    const r = deriveSessionRecap({ topic: '$ bun run build' });
    expect(r).toMatchObject({ userPromptClean: '$ bun run build', userPromptKind: 'command' });
    expect(r.request).toBeUndefined();
  });

  it('foldRecap puts the tidied request on the row', () => {
    const rows: ActiveSession[] = [{
      context: 'terminal', kind: 'claude', status: 'running',
      lastUserMessage: 'Ship the release. Then tell me.',
    }];
    foldRecap(rows);
    expect(rows[0].request?.headline).toBe('Ship the release.');
    expect(rows[0].request?.text).toBe('Ship the release. Then tell me.');
  });
});

describe('isReapableOrphan (dead + stale crash-orphan folds out of reconnectable)', () => {
  it('reaps a dead pid that is days-stale (abandoned)', () => {
    expect(isReapableOrphan({ status: 'abandoned', pidAlive: false })).toBe(true);
  });

  it('never reaps a live pid, even when stale/stuck (idle-but-unfinished = keep)', () => {
    expect(isReapableOrphan({ status: 'abandoned', pidAlive: true })).toBe(false);
  });

  it('never reaps a recently-closed or crashed session (still resumable)', () => {
    expect(isReapableOrphan({ status: 'closed', pidAlive: false })).toBe(false);
    expect(isReapableOrphan({ status: 'crashed', pidAlive: false })).toBe(false);
  });

  it('never reaps a row whose death cannot be proven (no pidAlive)', () => {
    expect(isReapableOrphan({ status: 'abandoned', pidAlive: undefined })).toBe(false);
  });
});

describe('summarizeMission (team task/target from the spawn prompt)', () => {
  it('takes the first line and strips a MISSION: label', () => {
    expect(summarizeMission('MISSION: Fix the session mapping bug\n\nDetails...')).toBe('Fix the session mapping bug');
  });
  it('strips CONTEXT:/TASK:/GOAL: labels too', () => {
    expect(summarizeMission('CONTEXT: improve the docs site')).toBe('improve the docs site');
    expect(summarizeMission('TASK - ship the CLI')).toBe('ship the CLI');
  });
  it('truncates a long mission with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const out = summarizeMission(long)!;
    expect(out.length).toBe(80);
    expect(out.endsWith('…')).toBe(true);
  });
  it('returns undefined for empty/whitespace prompt', () => {
    expect(summarizeMission('')).toBeUndefined();
    expect(summarizeMission('   \n  ')).toBeUndefined();
    expect(summarizeMission(null)).toBeUndefined();
  });
});

describe('backfillActiveRowsFromMeta (firstUserMessage rides live rows, PHNX-3621)', () => {
  it('backfills firstUserMessage from the indexed meta a running process cannot report', () => {
    const rows: ActiveSession[] = [
      { context: 'terminal', kind: 'claude', sessionId: 's1', status: 'running' },
    ];
    backfillActiveRowsFromMeta(rows, new Map([
      ['s1', { firstUserMessage: 'the full originating request', version: '2.1.207', accountKey: 'claude:org=second' }],
    ]));
    expect(rows[0].firstUserMessage).toBe('the full originating request');
    expect(rows[0].version).toBe('2.1.207');
    expect(rows[0].accountKey).toBe('claude:org=second');
  });

  it('never clobbers a firstUserMessage the row already carries', () => {
    const rows: ActiveSession[] = [
      { context: 'terminal', kind: 'claude', sessionId: 's1', status: 'running', firstUserMessage: 'live value' },
    ];
    backfillActiveRowsFromMeta(rows, new Map([['s1', { firstUserMessage: 'index value' }]]));
    expect(rows[0].firstUserMessage).toBe('live value');
  });
});
