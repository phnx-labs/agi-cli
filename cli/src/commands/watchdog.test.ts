/**
 * Tests for the `agents watchdog` command surface (RUSH-1415).
 *
 * Focus: `watchdog status --json` — the read the Swift menu-bar helper decodes to
 * drive its auto-nudge toggle. The parent `watchdog` command ALSO declares --json
 * and greedily parses it before dispatching to `status`, so the flag lands on the
 * parent, not the subcommand. The action reads it via optsWithGlobals(); if that
 * regressed to plain opts.json, `status --json` would silently emit human text and
 * the Swift JSONDecoder would get nothing. These tests lock that behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { formatWatchdogTickLines, registerWatchdogCommand } from './watchdog.js';
import type { WatchdogTickResult } from '../lib/watchdog/runner.js';

/** Run `agents watchdog <args...>`, capturing stdout lines the action prints. */
async function runWatchdog(args: string[]): Promise<string[]> {
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit on parse errors
  registerWatchdogCommand(program);

  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try {
    await program.parseAsync(['node', 'agents', 'watchdog', ...args]);
  } finally {
    console.log = orig;
  }
  return lines;
}

describe('watchdog status --json', () => {
  let origLog: typeof console.log;
  beforeEach(() => { origLog = console.log; });
  afterEach(() => { console.log = origLog; });

  it('emits a single JSON object with a boolean `enabled` and a `stateDir`', async () => {
    const lines = await runWatchdog(['status', '--json']);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as { enabled: unknown; stateDir: unknown };
    expect(typeof parsed.enabled).toBe('boolean');
    expect(typeof parsed.stateDir).toBe('string');
    expect((parsed.stateDir as string).length).toBeGreaterThan(0);
  });

  it('without --json prints human text, not JSON', async () => {
    const lines = await runWatchdog(['status']);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    // The human path is two lines starting with the enable-state label.
    expect(lines[0]).toContain('always-on watchdog');
    expect(() => JSON.parse(lines[0])).toThrow();
  });
});

describe('watchdog history', () => {
  it('rejects an invalid duration instead of silently returning no history', async () => {
    await expect(runWatchdog(['history', '--since', 'eventually']))
      .rejects.toThrow('--since must be a positive duration');
  });
});

describe('watchdog tick output', () => {
  const atMs = Date.parse('2026-08-08T05:18:15.000Z');
  const result: WatchdogTickResult = {
    atMs,
    didNudge: false,
    counts: { total: 2, stalled: 1, nudged: 0, unaddressable: 0, skipped: 2, rotating: 0 },
    presence: { connected: 2, disconnected: 0, transitions: [] },
    outcomes: [
      {
        sessionId: '0881d5b8-full', kind: 'claude', host: 'codium', machine: 'zion',
        cwd: '/Users/muqsit/src/agents-cli', project: 'agents-cli', label: 'Code Reviewer',
        preview: 'Checking the latest diff', activity: 'idle', status: 'idle', policy: 'keep',
        stall: 'stalled', stalledForMs: 1_200_000, decision: 'nudge',
        reason: 'would nudge via inject (dry)', startedAtMs: atMs - 7_200_000,
        lastActivityMs: atMs - 1_200_000, rail: 'vscodium',
      },
      {
        sessionId: 'healthy-full', kind: 'claude', host: 'tmux', machine: 'zion',
        cwd: '/repo', project: 'repo', activity: 'working', status: 'working', policy: 'keep',
        stall: 'active', decision: 'skip', reason: 'active', lastActivityMs: atMs - 10_000,
      },
    ],
  };

  it('renders timestamp, identity, location, age, preview, and omission summary', () => {
    const text = formatWatchdogTickLines(result, false).join('\n');
    expect(text).toContain('checked');
    expect(text).toMatch(/2026/);
    expect(text).toContain('0881d5b8 · Code Reviewer');
    expect(text).toContain('claude · codium · zion · agents-cli · idle');
    expect(text).toContain('started 2 hours ago · activity 20 minutes ago');
    expect(text).toContain('cwd /Users/muqsit/src/agents-cli');
    expect(text).toContain('latest Checking the latest diff');
    expect(text).toContain('1 healthy/non-actionable session omitted · use --verbose or --json');
    expect(text).not.toContain('healthy-full');
  });

  it('headlines a session by its generated title, not the raw first prompt (PHNX-3797)', () => {
    // Regression: the first fix here called sessionHeadline() on a SessionOutcome
    // that never carried `generatedTitle`, so it silently collapsed back to
    // `label || topic` and the report kept showing the raw prompt. The call site
    // read correctly — only the projection was wrong.
    const withTitle: WatchdogTickResult = {
      ...result,
      outcomes: [{
        sessionId: 'gen-title-full', kind: 'claude', host: 'tmux', machine: 'zion',
        topic: 'the sessions list headline shows the agent latest message, fix it',
        generatedTitle: 'Session headline ladder fix',
        activity: 'idle', status: 'idle', policy: 'keep', stall: 'stalled',
        stalledForMs: 1_200_000, decision: 'nudge', reason: 'would nudge (dry)',
        lastActivityMs: atMs - 1_200_000,
      }],
    };
    const text = formatWatchdogTickLines(withTitle, false).join('\n');
    expect(text).toContain('gen-titl · Session headline ladder fix');
    expect(text).not.toContain('the sessions list headline shows the agent latest message');
  });

  it('shows every session with verbose output', () => {
    expect(formatWatchdogTickLines(result, false, true).join('\n')).toContain('healthy-');
  });

  it('keeps sessions with missing identity or activity visible by default', () => {
    const diagnosticResult: WatchdogTickResult = {
      ...result,
      counts: { ...result.counts, total: 2, stalled: 0 },
      outcomes: [
        {
          kind: 'claude', host: 'tmux', policy: 'keep', stall: 'active', decision: 'skip',
          reason: 'no session id (cannot address or track)',
        },
        {
          sessionId: 'missing-activity', kind: 'codex', host: 'tmux', policy: 'keep',
          stall: 'active', decision: 'skip',
          reason: 'no activity timestamp (no transcript / start time)',
        },
      ],
    };

    const text = formatWatchdogTickLines(diagnosticResult, false).join('\n');
    expect(text).toContain('no session id (cannot address or track)');
    expect(text).toContain('skip        missing-');
    expect(text).toContain('no activity timestamp (no transcript / start time)');
    expect(text).not.toContain('healthy/non-actionable');
  });
});

describe('watchdog enable/disable verbs (PHNX-3949)', () => {
  function watchdogSub(name: string) {
    const program = new Command();
    registerWatchdogCommand(program);
    const watchdog = program.commands.find((c) => c.name() === 'watchdog');
    return watchdog?.commands.find((c) => c.name() === name);
  }

  it('enable/disable are the primary VISIBLE verbs', () => {
    const enable = watchdogSub('enable');
    const disable = watchdogSub('disable');
    expect(enable).toBeDefined();
    expect(disable).toBeDefined();
    // Regression guard: they must not be hidden the way the old enable/disable aliases were.
    expect((enable as unknown as { _hidden?: boolean })._hidden).toBeFalsy();
    expect((disable as unknown as { _hidden?: boolean })._hidden).toBeFalsy();
  });

  it('on/off remain as back-compat aliases (no separate command)', () => {
    expect(watchdogSub('enable')?.aliases()).toContain('on');
    expect(watchdogSub('disable')?.aliases()).toContain('off');
    // on/off must NOT be their own top-level watchdog subcommands anymore.
    expect(watchdogSub('on')).toBeUndefined();
    expect(watchdogSub('off')).toBeUndefined();
  });
});
