import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';

import { Command } from 'commander';
import {
  metaFromActive,
  selectFallback,
  mergeFocusHosts,
  focusHeader,
  tmuxAttachScript,
  planFocusSurface,
  openFocusTabs,
  isAttachableLiveSession,
  inheritFocusOptions,
  focusTargetForResolved,
  looksLikeTmuxAlias,
  resolveTmuxAliasState,
  shouldAttachLocalTmuxAliasBeforeFleet,
  dedupeSessionsByLogicalId,
  focusResolvedSession,
  resumeInTab,
} from './focus.js';
import { refuseFallback } from './go.js';
import { ackFailure } from '../lib/terminal/engine.js';
import { machineId } from '../lib/session/sync/config.js';
import { readDetachRecord, writeDetachRecord } from '../lib/session/detached.js';
import { upsertDevice } from '../lib/devices/registry.js';
import type { ActiveSession } from '../lib/session/active.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import type { SurfaceItem, LaunchResult } from '../lib/terminal/index.js';

function hasTmux(): boolean {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
}

describe('focusTargetForResolved — an id resolves fleet-wide, no --device needed', () => {
  const resolved: SessionMeta = {
    id: '019fd0c8-b3e9-77a2-a1a4-444698c4d897',
    shortId: '019fd0c8', agent: 'codex', version: '0.146.0', mode: 'edit',
    machine: 'yosemite-s0', timestamp: '2026-08-10T00:00:00Z', filePath: '/s/a.jsonl',
  };
  it('focuses the fleet-resolved session when it is outside the display pool', () => {
    expect(focusTargetForResolved(undefined, resolved)).toBe(resolved);
  });
  it('prefers the pool row when present (it carries already-gathered live status)', () => {
    const poolRow: SessionMeta = { ...resolved, _remote: true } as SessionMeta;
    expect(focusTargetForResolved(poolRow, resolved)).toBe(poolRow);
  });
});

function s(over: Partial<ActiveSession>): ActiveSession {
  return { context: 'terminal', kind: 'claude', status: 'running', ...over } as ActiveSession;
}

describe('inheritFocusOptions — parent sessions flags reach focus', () => {
  it('inherits explicit overlapping flags without replacing child defaults', () => {
    const parent = new Command('sessions')
      .option('--device <target...>')
      .option('--active')
      .option('--orphan')
      .option('--limit <n>', '', '50')
      .option('--sort <field>');
    parent.parseOptions(['--device', 'yosemite-s0', '--active', '--orphan']);
    expect(inheritFocusOptions({ attachOnly: true, limit: '500', sort: 'recent' }, parent)).toMatchObject({
      attachOnly: true,
      device: ['yosemite-s0'],
      active: true,
      orphan: true,
      limit: '500',
      sort: 'recent',
    });
  });

  it('lets an explicitly provided parent limit override the child default', () => {
    const parent = new Command('sessions').option('--limit <n>', '', '50');
    parent.parseOptions(['--limit', '25']);
    expect(inheritFocusOptions({ limit: '500' }, parent).limit).toBe('25');
  });
});

const localResume = (sess: ActiveSession): string[] => [
  'agents', 'run', 'auto', '--resume', sess.sessionId ?? '', '--interactive',
];

describe('selectFallback — --attach-only (old `go`) vs default resume', () => {
  it('--attach-only picks refuseFallback (attach or refuse, never fork)', () => {
    expect(selectFallback(true)).toBe(refuseFallback);
  });

  it('default (undefined/false) picks resume-in-new-tab, not refuseFallback', () => {
    expect(selectFallback(undefined)).not.toBe(refuseFallback);
    expect(selectFallback(false)).not.toBe(refuseFallback);
  });

  it('strict remote fallback refuses instead of opening a login shell', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previous = process.exitCode;
    process.exitCode = undefined;
    await refuseFallback(s({ sessionId: 'dead1234', machine: 'yosemite-s0' }), 'yosemite-s0');
    expect(log.mock.calls.flat().join('\n')).toContain('no living tmux pane');
    expect(process.exitCode).toBe(1);
    process.exitCode = previous;
    log.mockRestore();
  });

  it('local fallback refuses with a recovery hint', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previous = process.exitCode;
    process.exitCode = undefined;
    await refuseFallback(s({ sessionId: 'dead1234', machine: os.hostname(), host: 'ghostty' }), undefined);
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('no attach rail');
    expect(output).toContain('agents run auto --resume dead1234');
    expect(output).toContain('tmux');
    expect(process.exitCode).toBe(1);
    process.exitCode = previous;
    log.mockRestore();
  });
});

describe('focusResolvedSession --attach-only Path D (PHNX-3356)', () => {
  const id = 'ffffffff-1111-2222-3333-444444444444';
  const meta: SessionMeta = {
    id, shortId: 'ffffffff', agent: 'codex', version: '0.1.0', mode: 'edit',
    machine: 'self-host', timestamp: '2026-08-27T00:00:00Z', filePath: '/s/a.jsonl',
  };

  it('prints resume <real-id> when the live IDE row has no sessionId', async () => {
    const live = s({
      machine: 'self-host', host: 'codium', pid: 4242, pidAlive: true,
      status: 'running', sessionId: undefined,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previous = process.exitCode;
    process.exitCode = undefined;
    await focusResolvedSession(meta, new Map([[id, live]]), 'self-host', refuseFallback, true);
    const out = log.mock.calls.flat().join('\n');
    expect(out).toContain('no attach rail');
    expect(out).toContain('agents run auto --resume ffffffff');
    expect(out).not.toContain('resume <id>');
    expect(out).not.toContain('opening a new');
    expect(out).not.toContain('resuming it there');
    expect(process.exitCode).toBe(1);
    process.exitCode = previous;
    log.mockRestore();
  });
});

describe('metaFromActive — the resume fallback input', () => {
  it('carries id, short id, agent, and cwd through', () => {
    const m = metaFromActive(s({ sessionId: '019e30a2-cd76-7702', kind: 'codex', cwd: '/tmp/x' }));
    expect(m.id).toBe('019e30a2-cd76-7702');
    expect(m.shortId).toBe('019e30a2');
    expect(m.agent).toBe('codex');
    expect(m.cwd).toBe('/tmp/x');
  });

  it('missing session id degrades to "-" short id, empty id', () => {
    const m = metaFromActive(s({}));
    expect(m.shortId).toBe('-');
    expect(m.id).toBe('');
  });
});

describe('focus resume-in-a-tab command', () => {
  it('delegates every harness to centralized run --resume recovery', () => {
    for (const kind of ['claude', 'codex', 'opencode', 'grok', 'kimi']) {
      expect(localResume(s({ sessionId: 'abc12345', kind }))).toEqual([
        'agents', 'run', 'auto', '--resume', 'abc12345', '--interactive',
      ]);
    }
  });
});

describe('isAttachableLiveSession', () => {
  it('rejects retained panes whose process exited', () => {
    expect(isAttachableLiveSession(s({ machine: 'zion', pid: 111, pidAlive: false, status: 'closed' }))).toBe(false);
    expect(isAttachableLiveSession(s({ machine: 'zion', pid: 111, pidAlive: false, status: 'crashed' }))).toBe(false);
  });

  it('accepts a running live pane', () => {
    expect(isAttachableLiveSession(s({ machine: 'zion', pid: 111, pidAlive: true, status: 'running' }))).toBe(true);
  });

  it('rejects a pane whose liveness was never positively verified', () => {
    expect(isAttachableLiveSession(s({ machine: 'zion', pid: 111, status: 'running' }))).toBe(false);
    expect(isAttachableLiveSession(s({ pid: 111, pidAlive: true, status: 'running' }))).toBe(false);
  });
});

describe('mergeFocusHosts — --device selects the fleet scope, repeatable', () => {
  it('collects repeated --device values into one list', () => {
    expect(mergeFocusHosts({ device: ['a', 'b', 'c'] })).toEqual(['a', 'b', 'c']);
  });
  it('empty when neither is set (bare focus)', () => {
    expect(mergeFocusHosts({})).toEqual([]);
  });
});

describe('focusHeader — reflects the filter + device', () => {
  it('status + device → "Focus orphaned sessions on <host>:"', () => {
    expect(focusHeader(['orphaned'], ['yosemite-s0'])).toBe('Focus orphaned sessions on yosemite-s0:');
  });
  it('status only', () => {
    expect(focusHeader(['working'], [])).toBe('Focus working sessions:');
  });
  it('no filter, no device → the original bare header', () => {
    expect(focusHeader([], [])).toBe('Focus a live session:');
  });
});

describe('tmuxAttachScript — resolve pane → attach (join, no fork)', () => {
  it('attaches the pane, defaulting to the pane id if the session lookup is empty', () => {
    const script = tmuxAttachScript({ pane: '%3' });
    expect(script).toContain('attach-session');
    expect(script).toContain('%3');
    expect(script).toContain('#{pane_dead}');
  });
  it('threads the socket flag when the pane lives on a non-default socket', () => {
    expect(tmuxAttachScript({ socket: '/tmp/tmux-1/agents', pane: '%9' })).toContain('-S');
  });
});

describe('planFocusSurface — attach a live pane, or resume a copy (never a silent drop)', () => {
  const self = 'zion';

  it('local tmux → sh -c that attaches the live pane (a second client, no fork)', () => {
    const plan = planFocusSurface(s({ machine: self, provenance: { mux: { kind: 'tmux', pane: '%3' } } as never }), self, localResume);
    expect(plan.kind).toBe('attach');
    if (plan.kind !== 'attach') return;
    expect(plan.command[0]).toBe('sh');
    expect(plan.command.join(' ')).toContain('attach-session');
    expect(plan.note).toContain('%3');
  });

  it('remote tmux → ssh -tt <host> attaching the peer pane over SSH', () => {
    const plan = planFocusSurface(s({ machine: 'yosemite-s0', provenance: { mux: { kind: 'tmux', pane: '%117' } } as never }), self, localResume);
    expect(plan.kind).toBe('attach');
    if (plan.kind !== 'attach') return;
    expect(plan.command.slice(0, 3)).toEqual(['ssh', '-tt', 'yosemite-s0']);
    expect(plan.note).toContain('yosemite-s0');
  });

  it('local rail-less (Ghostty, no tmux) → centralized recovery in the tab', () => {
    const plan = planFocusSurface(s({ machine: self, host: 'ghostty', sessionId: 'abc12345', kind: 'claude' }), self, localResume);
    expect(plan.kind).toBe('resume');
    if (plan.kind !== 'resume') return;
    expect(plan.command).toEqual(['agents', 'run', 'auto', '--resume', 'abc12345', '--interactive']);
    expect(plan.note).toContain('resume a copy');
  });

  it('remote rail-less → canonical resume resolves the owning peer', () => {
    const plan = planFocusSurface(s({ machine: 'yosemite-s0', sessionId: 'def67890', kind: 'claude' }), self, localResume);
    expect(plan.kind).toBe('resume');
    if (plan.kind !== 'resume') return;
    expect(plan.command.slice(0, 3)).toEqual(['ssh', '-tt', 'yosemite-s0']);
    expect(plan.command.join(' ')).toContain('run auto --resume def67890');
  });

  it('an indexed Grok session recovers through the universal /continue path', () => {
    const plan = planFocusSurface(s({ machine: self, host: 'terminal', sessionId: 'z1234567', kind: 'grok' }), self, localResume);
    expect(plan.kind).toBe('resume');
    if (plan.kind !== 'resume') return;
    expect(plan.command.join(' ')).toContain('run auto --resume z1234567');
  });

  it('a retained dead pane recovers instead of attaching', () => {
    const plan = planFocusSurface(
      s({ machine: self, sessionId: 'dead1234', provenance: { mux: { kind: 'tmux', pane: '%9' } } as never }),
      self,
      localResume,
      { state: 'dead', exitStatus: 0 },
    );
    expect(plan.kind).toBe('resume');
    if (plan.kind !== 'resume') return;
    expect(plan.command.join(' ')).toContain('--resume dead1234');
  });

  it('an id-less rail-less row is reported and skipped', () => {
    const plan = planFocusSurface(s({ machine: self, host: 'terminal', kind: 'grok' }), self, () => null);
    expect(plan.kind).toBe('skip');
    if (plan.kind !== 'skip') return;
    expect(plan.note).toContain('grok');
  });
});

describe('openFocusTabs — N selected sessions → N tab requests through the engine', () => {
  function recorder() {
    const calls: Array<{ items: SurfaceItem[]; opts: { backend: string; host?: string; packing?: string } }> = [];
    const open = vi.fn(async (items: SurfaceItem[], opts: never): Promise<LaunchResult[]> => {
      calls.push({ items, opts: opts as { backend: string; host?: string; packing?: string } });
      return items.map((it) => ({ ok: true, request: { backend: 'tmux', layout: 'tab', cwd: it.cwd, command: it.command } })) as LaunchResult[];
    });
    return { calls, open };
  }

  it('opens each selected session as its own tab (layout+host asserted)', async () => {
    const { calls, open } = recorder();
    const targets = [
      s({ machine: 'zion', sessionId: 'aaaa1111', kind: 'claude', cwd: '/tmp' }),
      s({ machine: 'zion', sessionId: 'bbbb2222', kind: 'claude', cwd: '/tmp' }),
    ];
    await openFocusTabs(targets, 'zion', {
      open,
      backend: 'tmux',
      metas: targets.map(metaFromActive),
      probe: async () => ({ state: 'missing' }),
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(calls[0].items).toHaveLength(2);
    expect(calls[0].opts.packing).toBe('tabs');
    expect(calls[0].opts.host).toBeUndefined();
    for (const command of calls[0].items.map((i) => i.command)) {
      expect(command.join(' ')).toContain('run auto --resume');
    }
  });

  it('remote tmux selections attach over SSH in each tab (the mockup path)', async () => {
    const { calls, open } = recorder();
    const targets = [
      s({ machine: 'yosemite-s0', sessionId: 'r1', provenance: { mux: { kind: 'tmux', pane: '%1' } } as never }),
      s({ machine: 'yosemite-s0', sessionId: 'r2', provenance: { mux: { kind: 'tmux', pane: '%2' } } as never }),
    ];
    await openFocusTabs(targets, 'zion', {
      open,
      backend: 'tmux',
      metas: targets.map(metaFromActive),
      probe: async () => ({ state: 'alive' }),
    });
    expect(calls[0].items).toHaveLength(2);
    for (const it of calls[0].items) expect(it.command.slice(0, 3)).toEqual(['ssh', '-tt', 'yosemite-s0']);
  });

  it('rail-less Claude and Grok sessions both enter centralized recovery', async () => {
    const { calls, open } = recorder();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const targets = [
      s({ machine: 'zion', host: 'terminal', sessionId: 'ok123456', kind: 'claude', cwd: '/tmp' }),
      s({ machine: 'zion', host: 'terminal', sessionId: 'no123456', kind: 'grok' }),
    ];
    await openFocusTabs(targets, 'zion', {
      open,
      backend: 'tmux',
      metas: targets.map(metaFromActive),
      probe: async () => ({ state: 'missing' }),
    });
    expect(calls[0].items).toHaveLength(2);
    expect(calls[0].items[0].command.join(' ')).toContain('--resume ok123456');
    expect(calls[0].items[1].command.join(' ')).toContain('--resume no123456');
    log.mockRestore();
  });

  it('--attach-only skips dead and missing panes instead of recovering them', async () => {
    const { calls, open } = recorder();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const targets = [
      s({ machine: 'zion', sessionId: 'dead1234', provenance: { mux: { kind: 'tmux', pane: '%9' } } as never }),
      s({ machine: 'zion', sessionId: 'gone1234', host: 'terminal' }),
    ];
    await openFocusTabs(targets, 'zion', {
      open,
      backend: 'tmux',
      metas: targets.map(metaFromActive),
      attachOnly: true,
      probe: async (target) => target.sessionId === 'dead1234'
        ? { state: 'dead', exitStatus: 0 }
        : { state: 'missing' },
    });
    expect(calls).toHaveLength(0);
    expect(log.mock.calls.flat().join('\n')).toContain('Nothing to open');
    log.mockRestore();
  });
});

describe('shouldAttachLocalTmuxAliasBeforeFleet — local pane, no SSH', () => {
  it('is true for a tmux alias with no --device scope', () => {
    expect(shouldAttachLocalTmuxAliasBeforeFleet('ag-claude-0145ab8f', [])).toBe(true);
    expect(shouldAttachLocalTmuxAliasBeforeFleet('ag-kimi-632c1fbc', [])).toBe(true);
  });

  it('is false for a UUID/prefix (those still need index/fleet resolution)', () => {
    expect(shouldAttachLocalTmuxAliasBeforeFleet('0145ab8f', [])).toBe(false);
    expect(shouldAttachLocalTmuxAliasBeforeFleet('87e2bc83-d1e8-499b-9f54-d8cf98abe51b', [])).toBe(false);
  });

  it('is false when --device scoped the lookup to another machine', () => {
    expect(shouldAttachLocalTmuxAliasBeforeFleet('ag-claude-0145ab8f', ['zion'])).toBe(false);
  });
});

describe('resolveTmuxAliasState — a tmux alias is classified against the REAL server', () => {
  it('rejects selectors that are not alias-shaped', () => {
    expect(looksLikeTmuxAlias('87e2bc83')).toBe(false);
    expect(looksLikeTmuxAlias('87e2bc83-d1e8-499b-9f54-d8cf98abe51b')).toBe(false);
    expect(looksLikeTmuxAlias('some topic')).toBe(false);
    expect(looksLikeTmuxAlias('ag-kimi-632c1fbc')).toBe(true);
    expect(looksLikeTmuxAlias('ag-claude-87e2bc83')).toBe(true);
  });

  it('reports not-an-alias without touching tmux', async () => {
    expect(await resolveTmuxAliasState('87e2bc83')).toBe('not-an-alias');
  });

  it('reports absent for an alias with no such session on the server', async () => {
    const sock = path.join(os.tmpdir(), `agents-alias-${process.pid}-${Date.now()}.sock`);
    expect(await resolveTmuxAliasState('ag-claude-deadbeef', sock)).toBe('no-server');
  });

  it.skipIf(!hasTmux())('distinguishes a live pane from a dead one on a real server', async () => {
    const sock = path.join(os.tmpdir(), `agents-alias-live-${process.pid}-${Date.now()}.sock`);
    const live = 'ag-claude-aa11bb22';
    const dead = 'ag-claude-cc33dd44';
    try {
      execFileSync('tmux', ['-S', sock, 'set-option', '-g', 'remain-on-exit', 'on', ';',
        'new-session', '-d', '-s', live, 'sleep 300']);
      execFileSync('tmux', ['-S', sock, 'new-session', '-d', '-s', dead, 'true']);
      await new Promise(r => setTimeout(r, 700));

      expect(await resolveTmuxAliasState(live, sock)).toBe('live');
      expect(await resolveTmuxAliasState(dead, sock)).toBe('dead');
      expect(await resolveTmuxAliasState('ag-claude-99999999', sock)).toBe('absent');
    } finally {
      try { execFileSync('tmux', ['-S', sock, 'kill-server']); } catch {  }
    }
  });
});

describe('dedupeSessionsByLogicalId — synced copies are ONE session (SES-IF-2a)', () => {
  const base = {
    shortId: '87e2bc83', agent: 'claude' as const, version: '2.1.207', mode: 'edit',
    timestamp: '2026-08-10T00:00:00Z',
  };
  const id = '87e2bc83-d1e8-499b-9f54-d8cf98abe51b';

  it('collapses the same full id seen on two machines', () => {
    const rows = [
      { ...base, id, machine: 'yosemite-s0', filePath: '/s/a.jsonl' },
      { ...base, id, machine: 'zion', filePath: '/s/a.jsonl', _remote: true },
    ] as SessionMeta[];
    expect(dedupeSessionsByLogicalId(rows, 'yosemite-s0')).toHaveLength(1);
  });

  it('prefers a real transcript over a phantom index entry with no file', () => {
    const phantom = { ...base, id, machine: 'zion', filePath: '' } as SessionMeta;
    const real = { ...base, id, machine: 'yosemite-s0', filePath: '/s/a.jsonl' } as SessionMeta;
    expect(dedupeSessionsByLogicalId([phantom, real], undefined)[0]).toBe(real);
    expect(dedupeSessionsByLogicalId([real, phantom], undefined)[0]).toBe(real);
  });

  it('prefers this machine over a peer mirror — resuming is machine-bound', () => {
    const peer = { ...base, id, machine: 'zion', filePath: '/s/a.jsonl', _remote: true } as SessionMeta;
    const here = { ...base, id, machine: 'yosemite-s0', filePath: '/s/a.jsonl' } as SessionMeta;
    expect(dedupeSessionsByLogicalId([peer, here], 'yosemite-s0')[0]).toBe(here);
  });

  it('keeps genuinely distinct sessions apart — a real prefix collision still reports both', () => {
    const other = { ...base, id: '87e2bc83-aaaa-4bbb-8ccc-dddddddddddd', machine: 'zion', filePath: '/s/b.jsonl' } as SessionMeta;
    const here = { ...base, id, machine: 'yosemite-s0', filePath: '/s/a.jsonl' } as SessionMeta;
    expect(dedupeSessionsByLogicalId([here, other], 'yosemite-s0')).toHaveLength(2);
  });
});

describe('resumeInTab — a live headless run is stopped before its tab opens (PHNX-4344)', () => {
  const vscodium = { backend: 'vscodium-agent', source: 'active-session', host: 'codium' } as const;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  type Opened = { items: SurfaceItem[]; backend: string; headlessAlive?: boolean };

  function opener(pid?: number, result: Partial<LaunchResult> = { ok: true }) {
    const opened: Opened[] = [];
    const open = async (items: SurfaceItem[], opts: { backend: string }): Promise<LaunchResult[]> => {
      opened.push({ items, backend: opts.backend, headlessAlive: pid === undefined ? undefined : alive(pid) });
      return items.map((it) => ({ request: { backend: opts.backend, layout: 'tab', cwd: it.cwd, command: it.command }, ...result })) as LaunchResult[];
    };
    return { opened, open: open as never };
  }

  function metaFor(id: string, cwd: string): SessionMeta {
    return { id, shortId: id.slice(0, 8), agent: 'claude', timestamp: new Date().toISOString(), filePath: '', cwd };
  }

  it('SIGTERMs the local headless process, clears its detach record, then opens one VSCodium tab', async () => {
    const id = 'f0c05e11-4344-4000-8000-000000004344';
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-repo-'));
    const child = spawn('sleep', ['300'], { stdio: 'ignore' });
    const pid = child.pid!;
    writeDetachRecord({ sessionId: id, agent: 'claude', cwd: repo, headlessPid: pid, headlessStartTime: null, detachedAtMs: Date.now() });
    const { opened, open } = opener(pid);
    try {
      await resumeInTab(
        { context: 'headless', kind: 'claude', sessionId: id, pid, pidAlive: true, status: 'running', machine: machineId(), cwd: repo },
        undefined,
        { open, choice: vscodium, interactive: false, meta: metaFor(id, repo) },
      );
      expect(opened).toHaveLength(1);
      expect(opened[0].headlessAlive).toBe(false);
      expect(opened[0].backend).toBe('vscodium-agent');
      expect(opened[0].items[0]).toMatchObject({ cwd: repo, project: repo, sessionId: id, agent: 'claude' });
      expect(opened[0].items[0].command.join(' ')).toContain(`run auto --resume ${id} --interactive`);
      expect(readDetachRecord(id)).toBeUndefined();
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(repo, { recursive: true, force: true });
      process.exitCode = undefined;
    }
  });

  it('leaves a live interactive session running (only headless runs are stopped)', async () => {
    const id = 'f0c05e11-4344-4000-8000-000000004345';
    const child = spawn('sleep', ['300'], { stdio: 'ignore' });
    const pid = child.pid!;
    const { opened, open } = opener(pid);
    try {
      await resumeInTab(
        { context: 'terminal', kind: 'claude', sessionId: id, pid, pidAlive: true, status: 'running', machine: machineId(), cwd: os.tmpdir() },
        undefined,
        { open, choice: vscodium, interactive: false, meta: metaFor(id, os.tmpdir()) },
      );
      expect(opened[0].headlessAlive).toBe(true);
    } finally {
      child.kill('SIGKILL');
      process.exitCode = undefined;
    }
  });

  it('a GUI caller reopens a peer session in a LOCAL tab running the portable command, in the localized project folder', async () => {
    const id = 'f0c05e11-4344-4000-8000-000000004346';
    const home = process.env.HOME!;
    const repo = path.join(home, 'src', 'github.com', 'me', 'agents');
    fs.mkdirSync(repo, { recursive: true });
    const { opened, open } = opener();
    try {
      await resumeInTab(
        { context: 'terminal', kind: 'claude', sessionId: id, status: 'idle', machine: 'peer-box' },
        'peer-box',
        { open, choice: vscodium, interactive: false, meta: metaFor(id, `/home/${path.basename(home)}/src/github.com/me/agents/.agents/worktrees/fix`) },
      );
      expect(opened).toHaveLength(1);
      expect(opened[0].items[0].command).toEqual(['agents', 'run', 'auto', '--resume', id, '--interactive', '--quiet']);
      expect(opened[0].items[0]).toMatchObject({ cwd: repo, project: repo });
    } finally {
      fs.rmSync(path.join(home, 'src'), { recursive: true, force: true });
      process.exitCode = undefined;
    }
  });

  it('refuses to open a second copy when the headless run\'s device cannot be reached to stop it', async () => {
    const id = 'f0c05e11-4344-4000-8000-000000004347';
    const { opened, open } = opener();
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    try {
      await resumeInTab(
        { context: 'headless', kind: 'claude', sessionId: id, pid: 4242, pidAlive: true, status: 'running', machine: 'unregistered-peer' },
        'unregistered-peer',
        { open, choice: vscodium, interactive: false, meta: metaFor(id, '/tmp') },
      );
      expect(opened).toHaveLength(0);
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toMatch(/Can't reach unregistered-peer to stop the headless/);
    } finally {
      spy.mockRestore();
      process.exitCode = undefined;
    }
  });

  function fakeSsh(exitCode: number): { argsFile: string; restore: () => void } {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ssh-'));
    const argsFile = path.join(bin, 'args');
    fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${argsFile}'\nexit ${exitCode}\n`, { mode: 0o755 });
    const prev = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${prev}`;
    return { argsFile, restore: () => { process.env.PATH = prev; fs.rmSync(bin, { recursive: true, force: true }); } };
  }

  it.skipIf(process.platform === 'win32')('opens nothing when the peer\'s `ps stop` exits 1, and opens the tab once it exits 0', async () => {
    await upsertDevice('stop-peer', { platform: 'linux', user: 'test', address: { via: 'manual', dnsName: 'stop-peer.example.ts.net' } });
    const id = 'f0c05e11-4344-4000-8000-000000004349';
    const row: ActiveSession = { context: 'headless', kind: 'claude', sessionId: id, pid: 4242, pidAlive: true, status: 'running', machine: 'stop-peer' };
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    const failing = fakeSsh(1);
    try {
      const { opened, open } = opener();
      await resumeInTab(row, 'stop-peer', { open, choice: vscodium, interactive: false, meta: metaFor(id, '/tmp') });
      expect(fs.readFileSync(failing.argsFile, 'utf8')).toMatch(/ps.*stop.*f0c05e11-4344-4000-8000-000000004349.*--local/s);
      expect(opened).toHaveLength(0);
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toMatch(/ps stop f0c05e11 --local failed on stop-peer/);
    } finally {
      failing.restore();
      process.exitCode = undefined;
    }
    const passing = fakeSsh(0);
    try {
      const { opened, open } = opener();
      await resumeInTab(row, 'stop-peer', { open, choice: vscodium, interactive: false, meta: metaFor(id, '/tmp') });
      expect(opened).toHaveLength(1);
      expect(opened[0].items[0].command).toEqual(['agents', 'run', 'auto', '--resume', id, '--interactive', '--quiet']);
    } finally {
      passing.restore();
      spy.mockRestore();
      process.exitCode = undefined;
    }
  });

  it('says the headless run was stopped when its tab is then not confirmed', async () => {
    const id = 'f0c05e11-4344-4000-8000-00000000434a';
    const child = spawn('sleep', ['300'], { stdio: 'ignore' });
    const reason = ackFailure(undefined, { backend: 'vscodium-agent', layout: 'tab', cwd: '/d', command: [], project: '/d' }, 15_000)!;
    const { open } = opener(undefined, { ok: false, error: reason });
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    try {
      await resumeInTab(
        { context: 'headless', kind: 'claude', sessionId: id, pid: child.pid, pidAlive: true, status: 'running', machine: machineId(), cwd: os.tmpdir() },
        undefined,
        { open, choice: vscodium, interactive: false, meta: metaFor(id, os.tmpdir()) },
      );
      expect(process.exitCode).toBe(1);
      expect(errors[0]).toContain(reason);
      expect(errors[0]).toContain(`The headless run was stopped; resume it with agents run auto --resume ${id}`);
    } finally {
      child.kill('SIGKILL');
      spy.mockRestore();
      process.exitCode = undefined;
    }
  });

  it('fails loud with the tab backend\'s reason when the tab is not confirmed', async () => {
    const id = 'f0c05e11-4344-4000-8000-000000004348';
    const reason = ackFailure(undefined, { backend: 'vscodium-agent', layout: 'tab', cwd: '/d', command: [], project: '/d' }, 15_000)!;
    const { open } = opener(undefined, { ok: false, error: reason });
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    try {
      await resumeInTab(
        { context: 'terminal', kind: 'claude', sessionId: id, status: 'idle', machine: machineId(), cwd: os.tmpdir() },
        undefined,
        { open, choice: vscodium, interactive: false, meta: metaFor(id, os.tmpdir()) },
      );
      expect(process.exitCode).toBe(1);
      expect(errors[0]).toContain(reason);
    } finally {
      spy.mockRestore();
      process.exitCode = undefined;
    }
  });
});

describe('openFocusTabs — a selected live headless session is stopped before its tab opens (SES-40a)', () => {
  it('stops the headless pid before opening, and leaves an interactive one running', async () => {
    const self = machineId();
    const headless = spawn('sleep', ['300'], { stdio: 'ignore' });
    const interactive = spawn('sleep', ['300'], { stdio: 'ignore' });
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const seen: Array<{ headless: boolean; interactive: boolean }> = [];
    const open = vi.fn(async (items: SurfaceItem[]): Promise<LaunchResult[]> => {
      seen.push({ headless: alive(headless.pid!), interactive: alive(interactive.pid!) });
      return items.map((it) => ({ ok: true, request: { backend: 'tmux', layout: 'tab', cwd: it.cwd, command: it.command } })) as LaunchResult[];
    });
    const targets: ActiveSession[] = [
      { context: 'headless', kind: 'claude', sessionId: 'f0c05e11-4344-4000-8000-00000000434b', pid: headless.pid, pidAlive: true, status: 'running', machine: self, cwd: os.tmpdir() },
      { context: 'terminal', kind: 'claude', sessionId: 'f0c05e11-4344-4000-8000-00000000434c', pid: interactive.pid, pidAlive: true, status: 'running', machine: self, cwd: os.tmpdir() },
    ];
    try {
      await openFocusTabs(targets, self, { open: open as never, backend: 'tmux', metas: targets.map(metaFromActive), probe: async () => ({ state: 'missing' }) });
      expect(open).toHaveBeenCalledTimes(1);
      expect((open.mock.calls[0][0] as SurfaceItem[])).toHaveLength(2);
      expect(seen[0]).toEqual({ headless: false, interactive: true });
    } finally {
      headless.kill('SIGKILL');
      interactive.kill('SIGKILL');
      process.exitCode = undefined;
    }
  });
});

describe('focusResolvedSession — an ended session from a caller with no TTY (AGI Menu)', () => {
  const vscodium = { backend: 'vscodium-agent', source: 'active-session', host: 'codium' } as const;
  function recorder(result: Partial<LaunchResult> = { ok: true }) {
    const opened: Array<{ items: SurfaceItem[]; backend: string }> = [];
    const open = async (items: SurfaceItem[], opts: { backend: string }): Promise<LaunchResult[]> => {
      opened.push({ items, backend: opts.backend });
      return items.map((it) => ({ request: { backend: opts.backend, layout: 'tab', cwd: it.cwd, command: it.command }, ...result })) as LaunchResult[];
    };
    return { opened, open: open as never };
  }
  const ended = (id: string, machine?: string): SessionMeta =>
    ({ id, shortId: id.slice(0, 8), agent: 'claude', timestamp: new Date().toISOString(), filePath: '', cwd: os.tmpdir(), machine });

  it('opens a tab running the recovery command instead of resuming in place', async () => {
    const id = 'f0c05e11-4344-4000-8000-00000000434d';
    const { opened, open } = recorder();
    try {
      await focusResolvedSession(ended(id), new Map(), machineId(), refuseFallback, false, false, { open, choice: vscodium, interactive: false });
      expect(opened).toHaveLength(1);
      expect(opened[0].backend).toBe('vscodium-agent');
      expect(opened[0].items[0].command.join(' ')).toContain(`run auto --resume ${id} --interactive --quiet`);
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      process.exitCode = undefined;
    }
  });

  it('a peer-owned ended session opens a local tab with the portable command, not an SSH TTY hop', async () => {
    const id = 'f0c05e11-4344-4000-8000-00000000434e';
    const { opened, open } = recorder();
    try {
      await focusResolvedSession(ended(id, 'peer-box'), new Map(), machineId(), refuseFallback, false, false, { open, choice: vscodium, interactive: false });
      expect(opened[0].items[0].command).toEqual(['agents', 'run', 'auto', '--resume', id, '--interactive', '--quiet']);
    } finally {
      process.exitCode = undefined;
    }
  });

  it('fails loud with no terminal backend, and when the tab is not confirmed', async () => {
    const id = 'f0c05e11-4344-4000-8000-00000000434f';
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    try {
      const none = recorder();
      await focusResolvedSession(ended(id), new Map(), machineId(), refuseFallback, false, false, { open: none.open, choice: null, interactive: false });
      expect(none.opened).toHaveLength(0);
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toMatch(/No terminal this machine can drive/);
      process.exitCode = undefined;
      const reason = ackFailure(undefined, { backend: 'vscodium-agent', layout: 'tab', cwd: '/d', command: [], project: '/d' }, 15_000)!;
      const unconfirmed = recorder({ ok: false, error: reason });
      await focusResolvedSession(ended(id), new Map(), machineId(), refuseFallback, false, false, { open: unconfirmed.open, choice: vscodium, interactive: false });
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain(reason);
    } finally {
      spy.mockRestore();
      process.exitCode = undefined;
    }
  });
});
