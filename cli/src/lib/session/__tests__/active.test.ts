import { describe, it, expect } from 'vitest';
import { parseWin32ProcessCsv, foldSubordinateAgents, readAncestorSessionEntry, type AgentCandidate } from '../active.js';
import type { PidSessionEntry } from '../pid-registry.js';

describe('parseWin32ProcessCsv', () => {
  const csv = [
    '"ProcessId","ParentProcessId","Name"',
    '"0","0","System Idle Process"',
    '"38080","21480","claude.exe"',
    '"27808","38080","claude.exe"',
    '"5220","30844","node.exe"',
    '"9912","4180","codex.exe"',
    '"7212","1234","CLAUDE.EXE"',
    '',
  ].join('\r\n');

  it('parses pid/ppid/comm rows and skips the header', () => {
    const rows = parseWin32ProcessCsv(csv);
    expect(rows.map(r => r.pid)).toEqual([0, 38080, 27808, 5220, 9912, 7212]);
    expect(rows[1]).toEqual({ pid: 38080, ppid: 21480, comm: 'claude.exe', kind: 'claude' });
  });

  it('strips the .exe suffix case-insensitively when resolving agent kind', () => {
    const rows = parseWin32ProcessCsv(csv);
    const byPid = new Map(rows.map(r => [r.pid, r]));
    expect(byPid.get(38080)?.kind).toBe('claude');
    expect(byPid.get(9912)?.kind).toBe('codex');
    expect(byPid.get(7212)?.kind).toBe('claude');
    expect(byPid.get(5220)?.kind).toBeUndefined();
  });

  it('unescapes doubled quotes in image names', () => {
    const rows = parseWin32ProcessCsv('"10","1","we""ird.exe"');
    expect(rows[0].comm).toBe('we"ird.exe');
  });
});

describe('foldSubordinateAgents', () => {
  const noRegistry = () => undefined;
  const noLiveId = () => false;
  const entryFor = (pid: number, agent = 'claude'): PidSessionEntry => ({ pid, agent, startedAtMs: 1 });

  it('folds same-kind descendants onto the topmost root, transitively', () => {
    const candidates: AgentCandidate[] = [
      { pid: 100, kind: 'claude' },
      { pid: 200, kind: 'claude' },
      { pid: 300, kind: 'claude' },
      { pid: 900, kind: 'claude' },
    ];
    const ppid = new Map([[100, 1], [200, 100], [250, 200], [300, 250], [900, 7]]);
    const { kept, foldedByRoot } = foldSubordinateAgents(candidates, ppid, noRegistry, noLiveId);
    expect(kept.map(c => c.pid)).toEqual([100, 900]);
    expect(foldedByRoot.get(100)).toBe(2);
  });

  it('keeps a descendant with its own registry session and folds its children to it', () => {
    const candidates: AgentCandidate[] = [
      { pid: 100, kind: 'claude' },
      { pid: 200, kind: 'claude' },
      { pid: 300, kind: 'claude' },
    ];
    const ppid = new Map([[100, 1], [200, 100], [300, 200]]);
    const { kept, foldedByRoot } = foldSubordinateAgents(candidates, ppid, p => p === 200 ? entryFor(200) : undefined, noLiveId);
    expect(kept.map(c => c.pid)).toEqual([100, 200]);
    expect(foldedByRoot.get(200)).toBe(1);
    expect(foldedByRoot.has(100)).toBe(false);
  });

  it('keeps a descendant whose registry entry sits on a wrapper below the fold target', () => {
    const candidates: AgentCandidate[] = [
      { pid: 100, kind: 'claude' },
      { pid: 300, kind: 'claude' },
    ];
    const ppid = new Map([[100, 1], [250, 100], [300, 250]]);
    const { kept, foldedByRoot } = foldSubordinateAgents(candidates, ppid, p => p === 250 ? entryFor(250) : undefined, noLiveId);
    expect(kept.map(c => c.pid)).toEqual([100, 300]);
    expect(foldedByRoot.size).toBe(0);
  });

  it('ignores a wrapper entry of a different agent kind', () => {
    const candidates: AgentCandidate[] = [
      { pid: 100, kind: 'claude' },
      { pid: 300, kind: 'claude' },
    ];
    const ppid = new Map([[100, 1], [250, 100], [300, 250]]);
    const { kept, foldedByRoot } = foldSubordinateAgents(candidates, ppid, p => p === 250 ? entryFor(250, 'codex') : undefined, noLiveId);
    expect(kept.map(c => c.pid)).toEqual([100]);
    expect(foldedByRoot.get(100)).toBe(1);
  });

  it('does not fold across agent kinds', () => {
    const candidates: AgentCandidate[] = [
      { pid: 100, kind: 'claude' },
      { pid: 200, kind: 'codex' },
    ];
    const ppid = new Map([[100, 1], [200, 100]]);
    const { kept, foldedByRoot } = foldSubordinateAgents(candidates, ppid, noRegistry, noLiveId);
    expect(kept.map(c => c.pid)).toEqual([100, 200]);
    expect(foldedByRoot.size).toBe(0);
  });

  it('keeps a descendant with live --session-id even when the by-pid registry is empty (RUSH-2384)', () => {
    const candidates: AgentCandidate[] = [
      { pid: 100, kind: 'claude' },
      { pid: 200, kind: 'claude' },
    ];
    const ppid = new Map([[100, 1], [200, 100]]);
    const liveIds = new Set([200]);
    const { kept, foldedByRoot } = foldSubordinateAgents(
      candidates,
      ppid,
      noRegistry,
      (pid) => liveIds.has(pid),
    );
    expect(kept.map(c => c.pid).sort((a, b) => a - b)).toEqual([100, 200]);
    expect(foldedByRoot.size).toBe(0);
  });

  it('finds a wrapper entry one or more ancestors up (Windows cmd.exe shim path)', () => {
    const ppid = new Map([[300, 200], [200, 100], [100, 1]]);
    const entries = new Map<number, PidSessionEntry>([
      [100, { pid: 100, agent: 'claude', sessionId: 'uuid-1', cwd: 'C:\\repo', startedAtMs: 1 }],
    ]);
    const got = readAncestorSessionEntry(300, ppid, 'claude', p => entries.get(p));
    expect(got?.sessionId).toBe('uuid-1');
    expect(got?.cwd).toBe('C:\\repo');
  });

  it('does not hand a wrapper entry to a different agent kind', () => {
    const ppid = new Map([[300, 200], [200, 1]]);
    const entries = new Map<number, PidSessionEntry>([
      [200, { pid: 200, agent: 'claude', cwd: 'C:\\repo', startedAtMs: 1 }],
    ]);
    expect(readAncestorSessionEntry(300, ppid, 'codex', p => entries.get(p))).toBeUndefined();
    expect(readAncestorSessionEntry(300, ppid, 'claude', p => entries.get(p))).toBeDefined();
  });

  it('returns undefined with no entries and survives ppid cycles', () => {
    const ppid = new Map([[300, 200], [200, 300]]);
    expect(readAncestorSessionEntry(300, ppid, 'claude', () => undefined)).toBeUndefined();
  });

  it('survives a ppid cycle without dropping rows', () => {
    const candidates: AgentCandidate[] = [
      { pid: 100, kind: 'claude' },
      { pid: 200, kind: 'claude' },
    ];
    const ppid = new Map([[100, 200], [200, 100]]);
    const { kept, foldedByRoot } = foldSubordinateAgents(candidates, ppid, noRegistry);
    expect(kept.map(c => c.pid).sort()).toEqual([100, 200]);
    expect(foldedByRoot.size).toBe(0);
  });
});
