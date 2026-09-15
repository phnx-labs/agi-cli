/**
 * Tests for the ticket/PR column helper (Feature 3). The ref used to jam
 * against a truncated topic inside the badge blob; ticketLabel pulls it into a
 * dedicated column, and its precedence (ticket over PR) is the bit worth
 * pinning so a session tied to both doesn't flip between them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ActiveSession } from '../../lib/session/active.js';
import chalk from 'chalk';
import { stripVTControlCharacters } from 'node:util';
import {
  ticketLabel,
  machineLabeler,
  formatPickerLabel,
  formatPickerTip,
  pickerColumnsFor,
  flatSessionRow,
  linkTicketCell,
  linkCwdCell,
} from '../sessions.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { stringWidth } from '../../lib/session/width.js';

const strip = (s: string) => s.replace(/\[[0-9;]*m/g, '');

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'abcdef01-2345-6789-abcd-ef0123456789',
    shortId: 'abcdef01',
    agent: 'claude',
    timestamp: '2026-06-30T12:00:00.000Z',
    filePath: '/home/x/.claude/projects/foo/sess.jsonl',
    project: 'agents-cli',
    topic: 'do a thing',
    ...over,
  };
}

describe('ticketLabel', () => {
  it('returns the tracker ticket id when present', () => {
    expect(ticketLabel({ ticketId: 'RUSH-1332', prNumber: undefined })).toBe('RUSH-1332');
  });

  it('falls back to PR#<n> when there is no ticket', () => {
    expect(ticketLabel({ ticketId: undefined, prNumber: 565 })).toBe('PR#565');
  });

  it('prefers the ticket over the PR when both are set', () => {
    expect(ticketLabel({ ticketId: 'RUSH-1332', prNumber: 565 })).toBe('RUSH-1332');
  });

  it('returns empty string when neither is set', () => {
    expect(ticketLabel({ ticketId: undefined, prNumber: undefined })).toBe('');
  });
});

describe('machineLabeler', () => {
  it('strips the shared dash-delimited prefix (yosemite-s0/s1 -> s0/s1)', () => {
    const label = machineLabeler(['yosemite-s0', 'yosemite-s1']);
    expect(label('yosemite-s0')).toBe('s0');
    expect(label('yosemite-s1')).toBe('s1');
  });

  it('leaves ids whole when there is no shared prefix', () => {
    const label = machineLabeler(['zion', 'mac-mini']);
    expect(label('zion')).toBe('zion');
    expect(label('mac-mini')).toBe('mac-mini');
  });

  it('is identity for a single machine', () => {
    const label = machineLabeler(['yosemite-s0']);
    expect(label('yosemite-s0')).toBe('yosemite-s0');
  });

  it('never strips away the whole id', () => {
    const label = machineLabeler(['prod-1', 'prod']);
    expect(label('prod')).toBe('prod');
  });
});

describe('formatPickerLabel', () => {
  it('shows the PR ref and worktree badge when enabled', () => {
    const row = strip(formatPickerLabel(meta({ prNumber: 569, worktreeSlug: 'responsive-list' }), '', { showTicket: true }));
    expect(row).toContain('PR#569');
    expect(row).toContain('wt:responsive-list');
  });

  it('omits the ticket column when no row carries a ref', () => {
    const row = strip(formatPickerLabel(meta(), '', { showTicket: false }));
    expect(row).not.toContain('PR#');
  });

  it('renders the compact machine label only when the machine column is on', () => {
    const cols = { showMachine: true, machineLabel: machineLabeler(['yosemite-s0', 'yosemite-s1']) };
    const on = strip(formatPickerLabel(meta({ machine: 'yosemite-s0' }), '', cols));
    expect(on).toContain('s0');
    expect(on).not.toContain('yosemite-s0');

    const off = strip(formatPickerLabel(meta({ machine: 'yosemite-s0' }), '', { showMachine: false }));
    expect(off).not.toContain('s0');
  });

  it('tags the row with ssh←<device> when the live session was launched over ssh', () => {
    const row = strip(formatPickerLabel(meta(), '', {}, { device: 'zion' }));
    expect(row).toContain('ssh←zion');
  });

  it('renders the ssh←<device> tag in red, not folded into the whitened topic', () => {
    // Regression: the tag used to be concatenated into the topic string, which
    // renderTopicCell strips of ANSI and re-wraps in white — silently dropping
    // the red. Force colour on so the assertion is deterministic across CI/TTY.
    const prev = chalk.level;
    chalk.level = Math.max(prev, 1) as 0 | 1 | 2 | 3;
    try {
      const raw = formatPickerLabel(meta(), '', {}, { device: 'zion' });
      // chalk.red opens with \x1b[31m; it must sit immediately on the tag text,
      // not be replaced by the topic cell's white (\x1b[37m).
      expect(raw).toContain('\x1b[31mssh←zion');
      expect(strip(raw)).toContain('ssh←zion');
    } finally {
      chalk.level = prev;
    }
  });

  it('shows a bare ssh tag when the origin IP did not match a registered device', () => {
    const row = strip(formatPickerLabel(meta(), '', {}, {}));
    expect(row).toContain('ssh');
    expect(row).not.toContain('ssh←');
  });

  it('adds no ssh tag for a local (non-ssh) session', () => {
    const row = strip(formatPickerLabel(meta(), '', {}));
    expect(row).not.toContain('ssh');
  });

  // The browser rendered transcript metadata only, which carries no host — so a
  // running session never said whether it was a Ghostty tab, a VS Code panel, or
  // a detached tmux pane. The live scan knows; this is the column that shows it.
  it('renders the host program when the host column is on', () => {
    const row = strip(formatPickerLabel(meta(), '', { showHost: true }, undefined, 'tmux\u2192ghostty'));
    expect(row).toContain('tmux\u2192ghostty');
  });

  it('holds the column with a placeholder for a row whose host is unknown', () => {
    const row = strip(formatPickerLabel(meta(), '', { showHost: true }, undefined, ''));
    expect(row).toContain('-');
  });

  it('keeps the id column aligned when a live row is named by a long pid', () => {
    // A 7-digit Linux pid overflowed the 10-wide id column and pushed every
    // later column right, so the whole table lost its alignment.
    const row = strip(formatPickerLabel(meta({ shortId: 'pid:2813139' }), '', {}));
    expect(row.slice(0, 10)).toHaveLength(10);
    expect(row.startsWith('pid:2813\u2026')).toBe(true);
  });

  it('omits the host column entirely when it is off', () => {
    const row = strip(formatPickerLabel(meta(), '', { showHost: false }, undefined, 'ghostty'));
    expect(row).not.toContain('ghostty');
  });

  // The browser showed which terminal a session ran in but never WHAT it was
  // doing, so a session that had lost its host looked exactly like a healthy
  // one in the row list — the whole point of the new statuses is that you can
  // see them where you are already looking.
  it('renders the live status word when the status column is on', () => {
    const live = { context: 'terminal', kind: 'claude', status: 'orphaned' } as ActiveSession;
    const row = strip(formatPickerLabel(meta(), '', { showStatus: true }, undefined, '', false, live));
    expect(row).toContain('orphan');
  });

  it('renders `crashed` for a session whose host went down with it', () => {
    const live = { context: 'terminal', kind: 'claude', status: 'crashed' } as ActiveSession;
    const row = strip(formatPickerLabel(meta(), '', { showStatus: true }, undefined, '', false, live));
    expect(row).toContain('crashed');
  });

  it('holds the status column width for a row with no live match, so nothing jogs', () => {
    const live = { context: 'terminal', kind: 'claude', status: 'running' } as ActiveSession;
    const withLive = strip(formatPickerLabel(meta(), '', { showStatus: true }, undefined, '', false, live));
    const withoutLive = strip(formatPickerLabel(meta(), '', { showStatus: true }, undefined, '', false, undefined));
    // The topic must start at the same column in both, or the list is ragged on
    // exactly the rows that are not running.
    const at = (row: string) => row.indexOf('do a thing');
    expect(at(withLive)).toBeGreaterThan(0);
    expect(at(withoutLive)).toBe(at(withLive));
    // And the live row really did render its status, so this is not vacuous.
    expect(withLive).toContain('working');
    expect(withoutLive).not.toContain('working');
  });

  it('omits the status column entirely when it is off', () => {
    const live = { context: 'terminal', kind: 'claude', status: 'orphaned' } as ActiveSession;
    const row = strip(formatPickerLabel(meta(), '', { showStatus: false }, undefined, '', false, live));
    expect(row).not.toContain('orphan');
  });
});

describe('static flat-list columns', () => {
  it('shows a pool-sized model column only when the pool has model metadata', () => {
    const withModel = [
      meta({ model: 'claude-sonnet-4-20250514' }),
      meta({ id: 'other', shortId: 'other', model: undefined }),
    ];
    const cols = pickerColumnsFor(withModel);
    expect(cols.showModel).toBe(true);
    expect(cols.modelWidth).toBe(9);
    expect(stripVTControlCharacters(flatSessionRow(withModel[0], undefined, false, cols))).toContain('sonnet-4');

    const withoutModel = [meta({ topic: 'Show codex versions in the session list' })];
    const noModelCols = pickerColumnsFor(withoutModel);
    expect(noModelCols.showModel).toBe(false);
    expect(stripVTControlCharacters(flatSessionRow(withoutModel[0], undefined, false, noModelCols)))
      .toContain('Show codex versions in the session list');
  });

  it('keeps a modeled row within an 80-column terminal', () => {
    const original = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const originalColumnsEnv = process.env.COLUMNS;
    delete process.env.COLUMNS;
    Object.defineProperty(process.stdout, 'columns', { configurable: true, writable: true, value: 80 });
    try {
      const session = meta({
        timestamp: new Date().toISOString(),
        model: 'claude-sonnet-4-20250514',
        ticketId: 'RUSH-1992',
        topic: 'A topic that must shrink without wrapping the row',
      });
      const row = stripVTControlCharacters(flatSessionRow(session, undefined, true, pickerColumnsFor([session])));
      expect(stringWidth(row)).toBeLessThanOrEqual(80);
      expect(row).not.toContain('sonnet-4');
    } finally {
      if (originalColumnsEnv === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = originalColumnsEnv;
      if (original) Object.defineProperty(process.stdout, 'columns', original);
      else delete (process.stdout as { columns?: number }).columns;
    }
  });

  it('links local ticket and cwd labels while remote cwd stays plain', () => {
    const ticket = linkTicketCell(meta({ ticketId: 'RUSH-1991' }), 'RUSH-1991');
    const cwd = linkCwdCell(meta({ cwd: '/repo/agents-cli' }), 'agents-cli');
    expect(stripVTControlCharacters(ticket)).toBe('RUSH-1991');
    expect(stripVTControlCharacters(cwd)).toBe('agents-cli');
    if (ticket.includes('\x1b]8;;')) expect(ticket).toContain('/issue/RUSH-1991');
    if (cwd.includes('\x1b]8;;')) expect(cwd).toContain('file:///repo/agents-cli');
    expect(linkCwdCell(meta({ cwd: '/remote/repo', _remote: true }), 'remote')).toBe('remote');
  });
});

describe('formatPickerLabel width fits the gutter (no wrap)', () => {
  // Wide enough that the topic cell isn't pinned to its 16-col floor, so the
  // test isolates gutter accounting rather than the narrow-terminal floor.
  const WIDTH = 120;
  function rowFits(gutter: number): boolean {
    const orig = process.stdout.columns;
    try {
      (process.stdout as any).columns = WIDTH;
      const cols = { showTicket: true, gutter };
      // Long topic forces the topic cell to the binding width so the row fills the line.
      const row = strip(formatPickerLabel(meta({ prNumber: 569, worktreeSlug: 'responsive-list', topic: 'x'.repeat(300) }), '', cols));
      return row.length + gutter <= WIDTH;
    } finally {
      (process.stdout as any).columns = orig;
    }
  }

  it('single-select rows fit with the 2-cell cursor gutter', () => {
    expect(rowFits(2)).toBe(true);
  });

  it('multi-select rows fit with the 6-cell cursor+checkbox gutter', () => {
    // Regression: the resume picker prepends "> [x] " (6 cells). If the width
    // calc reserved only 2, the row would overflow by 4 and wrap every line.
    expect(rowFits(6)).toBe(true);
  });
});

describe('formatPickerTip', () => {
  it('returns a tip and is stable for a given pool size', () => {
    const pool = [meta(), meta()];
    const a = strip(formatPickerTip(pool));
    expect(a).toContain('Tip:');
    expect(strip(formatPickerTip(pool))).toBe(a);
  });
});

describe('team badge — the orchestrator end of the lineage', () => {
  it('renders team:<name> on a session that spawned a team', () => {
    const row = strip(formatPickerLabel(meta({ spawnedTeam: 'redesign' }), '', {}));
    expect(row).toContain('team:redesign');
  });

  it('renders nothing for a session that spawned no team', () => {
    expect(strip(formatPickerLabel(meta(), '', {}))).not.toContain('team:');
  });

  it('renders the badge in green, not folded into the whitened topic', () => {
    // Same regression the ssh tag hit: concatenating it into the topic string
    // means renderTopicCell strips the ANSI and re-wraps every slice in white.
    const prev = chalk.level;
    chalk.level = Math.max(prev, 1) as 0 | 1 | 2 | 3;
    try {
      const raw = formatPickerLabel(meta({ spawnedTeam: 'redesign' }), '', {});
      expect(raw).toContain('\x1b[32mteam:redesign');
    } finally {
      chalk.level = prev;
    }
  });

  it('truncates a long team name so it cannot devour the topic column', () => {
    const row = strip(formatPickerLabel(meta({ spawnedTeam: 'a-very-long-team-name-indeed' }), '', {}));
    expect(row).toContain('team:');
    expect(row).not.toContain('a-very-long-team-name-indeed');
  });

  it('takes its width out of the topic, not out of the row', () => {
    // The badge is a segment, not a column: adding it must shrink the topic cell
    // rather than widen the row, or every fixed-width column after it misaligns.
    // (At the Math.max(16, ...) topic floor there is nothing left to give back,
    // which is why this asserts against a width with slack in it.)
    const prev = process.env.COLUMNS;
    process.env.COLUMNS = '160';
    try {
      const common = { machine: 'yosemite-s0', ticketId: 'RUSH-2076', topic: 'x'.repeat(400) };
      const without = strip(formatPickerLabel(meta(common), '', { showTicket: true }));
      const withBadge = strip(formatPickerLabel(meta({ ...common, spawnedTeam: 'redesign' }), '', { showTicket: true }));

      expect(withBadge).toContain('team:redesign');
      expect(stringWidth(withBadge)).toBe(stringWidth(without));
    } finally {
      if (prev === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = prev;
    }
  });

  it('marks a teammate row with [team/handle] and drops the mode', () => {
    // The mode survives in the preview pane; in the row it would eat characters
    // the prompt needs, against a 16-column topic floor.
    const row = strip(
      formatPickerLabel(meta({ teamOrigin: { handle: 'resume-picker', mode: 'edit', team: 'redesign' } }), '', {})
    );
    expect(row).toContain('[redesign/resume-picker]');
    expect(row).not.toContain('edit');
  });

  it('falls back to the bare handle when the record predates team-name capture', () => {
    const row = strip(formatPickerLabel(meta({ teamOrigin: { handle: 'abcd1234' } }), '', {}));
    expect(row).toContain('[abcd1234]');
  });

  it('shows the badge in the flat listing too', () => {
    expect(strip(flatSessionRow(meta({ spawnedTeam: 'redesign' })))).toContain('team:redesign');
  });
});

describe('the time cell reports creation and last activity, not just one', () => {
  // A listing sorted by last activity cannot answer "which of these is the
  // session I started last Tuesday" — the row has to carry both ends.
  afterEach(() => {
    vi.useRealTimers();
    if (savedColumns === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = savedColumns;
  });

  let savedColumns: string | undefined;
  beforeEach(() => {
    savedColumns = process.env.COLUMNS;
    process.env.COLUMNS = '200';
    vi.setSystemTime(new Date('2026-07-04T12:00:00.000Z'));
  });

  const ranForDays = meta({
    timestamp: '2026-07-01T12:00:00.000Z',
    lastActivity: '2026-07-04T11:00:00.000Z',
  });

  it('renders both fields in the picker row', () => {
    expect(strip(formatPickerLabel(ranForDays, '', {}))).toContain('3d → 1 hour ago');
  });

  it('renders both fields in the flat listing row', () => {
    expect(strip(flatSessionRow(ranForDays))).toContain('3d → 1 hour ago');
  });

  it('shows one field for a session that never spanned a minute', () => {
    const oneShot = meta({
      timestamp: '2026-07-04T09:00:00.000Z',
      lastActivity: '2026-07-04T09:00:20.000Z',
    });
    const row = strip(formatPickerLabel(oneShot, '', {}));
    expect(row).toContain('2 hours ago');
    expect(row).not.toContain('→');
  });

  it('takes the extra width out of the topic, not out of the row', () => {
    // Same invariant as the team badge: a wider time cell must shrink the topic
    // rather than push the row past the terminal edge and wrap it.
    const long = { topic: 'x'.repeat(400) };
    const oneField = strip(flatSessionRow(meta({ ...long, timestamp: '2026-07-04T11:00:00.000Z' })));
    const twoFields = strip(flatSessionRow(meta({ ...long, ...ranForDays })));

    expect(twoFields).toContain('3d → 1 hour ago');
    expect(stringWidth(twoFields)).toBe(stringWidth(oneField));
  });

  it('gives up the creation field before it squeezes the topic past its floor', () => {
    // A narrow terminal keeps the row intact and the topic readable; the
    // creation age is the part that yields.
    process.env.COLUMNS = '70';
    const row = strip(flatSessionRow(meta({ ...ranForDays, topic: 'x'.repeat(400) })));
    expect(row).toContain('1 hour ago');
    expect(row).not.toContain('→');
    expect(stringWidth(row)).toBeLessThanOrEqual(70);
  });
});
