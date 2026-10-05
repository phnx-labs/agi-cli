/** Tests for `agents mailboxes` (RUSH-1737), real behavior only: boxes seeded via the real
 * `enqueue` writer in a temp HOME, views driven through real Commander parsing, and --watch
 * stopped via the SIGINT handler the action installs. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mailboxes-cmd-test-'));
process.env.HOME = TEST_HOME;

const { Command } = await import('commander');
const { registerMailboxesCommand } = await import('./mailboxes.js');
const { enqueue, mailboxDir } = await import('../lib/mailbox.js');

const MAILBOX_ROOT = path.join(TEST_HOME, '.agents', '.history', 'mailbox');
const OLD_TS = '2026-01-01T00:00:00.000Z';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface RunResult {
  lines: string[];
  errs: string[];
  exitCode: number | null;
}

interface RunHandle {
  /** Filled live as the action prints — readable while --watch is still running. */
  lines: string[];
  errs: string[];
  done: Promise<RunResult>;
}

/** Start `agents mailboxes <args...>`, capturing output and intercepting die()'s process.exit. */
function startMailboxes(args: string[]): RunHandle {
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit on parse errors
  registerMailboxesCommand(program);

  const lines: string[] = [];
  const errs: string[] = [];
  let exitCode: number | null = null;
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.map(String).join(' ')); });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${exitCode})`);
  }) as typeof process.exit);

  const done = (async (): Promise<RunResult> => {
    try {
      await program.parseAsync(['node', 'agents', 'mailboxes', ...args]);
    } catch {
      // die() (intercepted exit) or a commander parse error — asserted via errs/exitCode.
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
    return { lines, errs, exitCode };
  })();
  return { lines, errs, done };
}

async function runMailboxes(args: string[]): Promise<RunResult> {
  return startMailboxes(args).done;
}

/** Backdate a queued message by rewriting its on-disk record (same trick as lib/mailbox.test.ts). */
function backdate(boxDir: string, msgId: string, iso: string): void {
  const file = path.join(boxDir, 'inbox', `${msgId}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf-8'));
  record.ts = iso;
  fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf-8');
}

type SigintListener = (...args: never[]) => void;

/** Snapshot SIGINT listeners so the test can find the one the watch action adds. */
function sigintBaseline(): Set<SigintListener> {
  return new Set(process.listeners('SIGINT') as SigintListener[]);
}

/** Invoke the SIGINT handler the watch action installed (what ⌃C does), leaving vitest's own listeners alone. */
function sendSigint(before: Set<SigintListener>): void {
  const handler = (process.listeners('SIGINT') as SigintListener[]).find((l) => !before.has(l));
  expect(handler, 'watch should have installed a SIGINT handler').toBeTruthy();
  handler!();
}

describe('agents mailboxes', () => {
  const savedMailboxEnv = process.env.AGENTS_MAILBOX_DIR;
  beforeAll(() => {
    // Deterministic "you" resolution: unset unless a test sets it explicitly.
    delete process.env.AGENTS_MAILBOX_DIR;
  });
  afterAll(() => {
    if (savedMailboxEnv === undefined) delete process.env.AGENTS_MAILBOX_DIR;
    else process.env.AGENTS_MAILBOX_DIR = savedMailboxEnv;
    try {
      fs.rmSync(TEST_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) {
      // Windows CI: a just-released handle on the spool (aborted watch poll, Defender) can outlive
      // the rm retries and EPERM the suite. Cleanup is hygiene, not an assertion, so tolerate it
      // there; stay strict on posix.
      if (process.platform !== 'win32') throw err;
    }
  });

  it('renders the masthead + sparkline overview and the preserved --json box shape', async () => {
    const box = mailboxDir('overvw01', MAILBOX_ROOT);
    enqueue(box, { to: 'overvw01', from: 'claude/alpha', text: 'overview body' });

    const text = await runMailboxes([]);
    const out = text.lines.join('\n');
    expect(out).toContain('fleet comms');
    expect(out).toContain('awaiting delivery');
    expect(out).toContain('24h');
    expect(out).toContain('overvw01');
    expect(out).toContain('overview body');
    expect(text.exitCode).toBeNull();

    const json = await runMailboxes(['--json']);
    const boxes = JSON.parse(json.lines.join('\n')) as Array<Record<string, unknown>>;
    const mine = boxes.find((b) => b.id === 'overvw01');
    expect(mine).toBeTruthy();
    expect(mine).toMatchObject({ id: 'overvw01', pending: 1, total: 1 });
    expect(Array.isArray(mine!.messages)).toBe(true);
  });

  it('--from / --to / --since filter the overview recency log', async () => {
    const dstA = mailboxDir('flt-dsta', MAILBOX_ROOT);
    const dstB = mailboxDir('flt-dstb', MAILBOX_ROOT);
    enqueue(dstA, { to: 'flt-dsta', from: 'claude/keepme', text: 'keep this line' });
    enqueue(dstB, { to: 'flt-dstb', from: 'claude/dropme', text: 'drop this line' });
    const oldId = enqueue(dstA, { to: 'flt-dsta', from: 'claude/ancient', text: 'ancient history' });
    backdate(dstA, oldId, OLD_TS);

    const bySender = (await runMailboxes(['--from', 'keepme'])).lines.join('\n');
    expect(bySender).toContain('keep this line');
    expect(bySender).not.toContain('drop this line');

    const byTarget = (await runMailboxes(['--to', 'flt-dstb'])).lines.join('\n');
    expect(byTarget).toContain('drop this line');
    expect(byTarget).not.toContain('keep this line');

    const byRecency = (await runMailboxes(['--since', '1h'])).lines.join('\n');
    expect(byRecency).toContain('keep this line');
    expect(byRecency).not.toContain('ancient history');

    const bad = await runMailboxes(['--since', 'whenever']);
    expect(bad.exitCode).toBe(1);
    expect(bad.errs.join('\n')).toContain('Invalid --since');
  });

  it('--between reads one relationship chronologically in both directions', async () => {
    const a = mailboxDir('alpha-a01', MAILBOX_ROOT);
    const b = mailboxDir('bravo-b01', MAILBOX_ROOT);
    const m1 = enqueue(b, { to: 'bravo-b01', from: 'alpha-a01', text: 'a to b first' });
    const m2 = enqueue(a, { to: 'alpha-a01', from: 'bravo-b01', text: 'b to a second' });
    const m3 = enqueue(b, { to: 'bravo-b01', from: 'alpha-a01', text: 'a to b third' });
    backdate(b, m1, '2026-01-02T10:00:00.000Z');
    backdate(a, m2, '2026-01-02T11:00:00.000Z');
    backdate(b, m3, '2026-01-02T12:00:00.000Z');

    const { lines } = await runMailboxes(['--between', 'alpha-a01', 'bravo-b01', '--json']);
    const thread = JSON.parse(lines.join('\n')) as {
      a: { id: string }; b: { id: string }; count: number;
      messages: Array<{ to: string; text: string; ts: string }>;
    };
    expect(thread.a).toMatchObject({ id: 'alpha-a01' });
    expect(thread.b).toMatchObject({ id: 'bravo-b01' });
    expect(thread.count).toBe(3);
    // Chronological across both directions: a->b, b->a, a->b.
    expect(thread.messages.map((m) => m.text)).toEqual(['a to b first', 'b to a second', 'a to b third']);
    expect(thread.messages.map((m) => m.to)).toEqual(['bravo-b01', 'alpha-a01', 'bravo-b01']);

    const text = await runMailboxes(['--between', 'alpha-a01', 'bravo-b01']);
    expect(text.lines.join('\n')).toContain('3 messages');
  });

  it('--between rejects a single box, unknown ids, and the same box twice', async () => {
    const one = await runMailboxes(['--between', 'alpha-a01']);
    expect(one.exitCode).toBe(1);
    expect(one.errs.join('\n')).toContain('exactly two boxes');

    const missing = await runMailboxes(['--between', 'alpha-a01', 'no-such-box-xyz']);
    expect(missing.exitCode).toBe(1);
    expect(missing.errs.join('\n')).toContain('No mailbox matching');

    const same = await runMailboxes(['--between', 'alpha-a01', 'alpha-a01']);
    expect(same.exitCode).toBe(1);
    expect(same.errs.join('\n')).toContain('two different boxes');
  });

  it('rejects mutually exclusive view combinations instead of dropping a flag', async () => {
    const watchGraph = await runMailboxes(['--watch', '--graph']);
    expect(watchGraph.exitCode).toBe(1);
    expect(watchGraph.errs.join('\n')).toContain('combines with no other view');

    const betweenGraph = await runMailboxes(['--between', 'alpha-a01', 'bravo-b01', '--graph']);
    expect(betweenGraph.exitCode).toBe(1);
    expect(betweenGraph.errs.join('\n')).toContain('Pick one view');

    const idGraph = await runMailboxes(['alpha-a01', '--graph']);
    expect(idGraph.exitCode).toBe(1);
    expect(idGraph.errs.join('\n')).toContain('Pick one view');
  });

  it('--graph aggregates who-talks-to-whom edges, busiest first', async () => {
    const dst = mailboxDir('graphds1', MAILBOX_ROOT);
    enqueue(dst, { to: 'graphds1', from: 'claude/talker', text: 'one' });
    enqueue(dst, { to: 'graphds1', from: 'claude/talker', text: 'two' });
    enqueue(dst, { to: 'graphds1', from: 'claude/talker', text: 'three' });
    const other = mailboxDir('graphds2', MAILBOX_ROOT);
    enqueue(other, { to: 'graphds2', from: 'claude/talker', text: 'side' });

    const { lines } = await runMailboxes(['--graph', '--json']);
    const edges = JSON.parse(lines.join('\n')) as Array<{ from: string; to: string; count: number }>;
    expect(edges).toContainEqual({ from: 'claude/talker', to: 'graphds1', count: 3 });
    expect(edges).toContainEqual({ from: 'claude/talker', to: 'graphds2', count: 1 });

    const text = await runMailboxes(['--graph']);
    const out = text.lines.join('\n');
    expect(out).toContain('└─▶');
    expect(out).toContain('claude/talker');
  });

  it('--watch streams new mail as NDJSON and stops cleanly on SIGINT', async () => {
    const box = mailboxDir('watchbx1', MAILBOX_ROOT);
    enqueue(box, { to: 'watchbx1', from: 'claude/old', text: 'historical-backlog' });

    const before = sigintBaseline();
    const run = startMailboxes(['--watch', '--json']);
    // The watcher baselines existing mail on its first poll; keep enqueueing
    // until the live tail picks one up (collectBoxes scan time varies).
    let n = 0;
    const started = Date.now();
    while (run.lines.length === 0 && Date.now() - started < 10_000) {
      enqueue(box, { to: 'watchbx1', from: 'claude/new', text: `fresh-live-${n++}` });
      await sleep(700);
    }
    expect(run.lines.length).toBeGreaterThan(0);
    sendSigint(before);
    const result = await run.done;
    const events = result.lines.map((l) => JSON.parse(l)) as Array<{ text: string; from: string }>;
    expect(events.some((e) => e.text.startsWith('fresh-live-'))).toBe(true);
    expect(events.some((e) => e.text === 'historical-backlog')).toBe(false);
    expect(events.every((e) => e.from === 'claude/new')).toBe(true);
  }, 20_000);

  it('--watch --since backfills only the requested window', async () => {
    const box = mailboxDir('watchbx2', MAILBOX_ROOT);
    const oldId = enqueue(box, { to: 'watchbx2', from: 'claude/win', text: 'outside the window' });
    backdate(box, oldId, OLD_TS);
    enqueue(box, { to: 'watchbx2', from: 'claude/win', text: 'inside the window' });

    const before = sigintBaseline();
    const run = startMailboxes(['--watch', '--since', '1h', '--json']);
    const started = Date.now();
    while (run.lines.length === 0 && Date.now() - started < 10_000) {
      await sleep(300);
    }
    // Let any further first-poll lines flush, then stop and inspect.
    await sleep(600);
    sendSigint(before);
    const result = await run.done;
    const events = result.lines.map((l) => JSON.parse(l)) as Array<{ text: string }>;
    expect(events.some((e) => e.text === 'inside the window')).toBe(true);
    expect(events.some((e) => e.text === 'outside the window')).toBe(false);
  }, 20_000);

  it('--watch marks mail addressed to the watching agent with ▲ you', async () => {
    const youDir = mailboxDir('youbx0001', MAILBOX_ROOT);
    enqueue(youDir, { to: 'youbx0001', from: 'claude/pal', text: 'reply for the orchestrator' });
    process.env.AGENTS_MAILBOX_DIR = youDir;
    try {
      const before = sigintBaseline();
      const run = startMailboxes(['--watch', '--since', '1h']);
      const started = Date.now();
      while (run.lines.length <= 1 && Date.now() - started < 10_000) {
        await sleep(300);
      }
      sendSigint(before);
      const result = await run.done;
      const out = result.lines.join('\n');
      expect(out).toContain('▲ you');
      expect(out).toContain('reply for the orchestrator');
    } finally {
      delete process.env.AGENTS_MAILBOX_DIR;
    }
  }, 20_000);

  it('keeps the <id> detail view', async () => {
    const box = mailboxDir('detail01', MAILBOX_ROOT);
    enqueue(box, { to: 'detail01', from: 'claude/solo', text: 'detail body' });

    const { lines } = await runMailboxes(['detail01', '--json']);
    const parsed = JSON.parse(lines.join('\n')) as { id: string; messages: Array<{ text: string }> };
    expect(parsed.id).toBe('detail01');
    expect(parsed.messages.map((m) => m.text)).toContain('detail body');
  });
});
