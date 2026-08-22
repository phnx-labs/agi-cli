import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// End-to-end parity for the LIVE Claude scan path (B-2). Proves that wiring
// scanClaudeSessionIncremental into discoverSessions produces a DB row that is
// IDENTICAL, field for field, to a from-scratch FULL reparse — even when PR /
// ticket / title signals STRADDLE two scans, and that a truncation forces a full
// reparse. Real fs, real sqlite, real discovery under a throwaway HOME. No mocks.
//
// The from-scratch ground truth is computed inside the SAME DB by writing the
// final file content to a DIFFERENT session id (no prior ledger row → the code
// takes the FULL path for it) and comparing its row to the incrementally-scanned
// session's row. Every field except the id/short-id/filePath must match.

const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-inc-e2e-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

type Discover = typeof import('../discover.js');
type DB = typeof import('../db.js');

let discover: Discover;
let db: DB;

// The live Claude root — the only tree Claude appends to in place, so every file
// under it is treated as hot and an in-place append is always re-detected.
const LIVE_PROJECTS = path.join(tmpHome, '.claude', 'projects');
const PROJECT_DIR = path.join(LIVE_PROJECTS, '-home-u-repo');

function line(obj: object): string {
  return JSON.stringify(obj);
}

/** Path of a session's transcript file under the live project dir. */
function sessionFile(id: string): string {
  return path.join(PROJECT_DIR, `${id}.jsonl`);
}

/** Write a whole transcript (array of events) as newline-terminated JSONL. */
function writeTranscript(id: string, events: object[]): string {
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  const fp = sessionFile(id);
  fs.writeFileSync(fp, events.map(line).join('\n') + '\n', 'utf-8');
  bumpMtimeToNow(fp, 0);
  return fp;
}

/** Append more events (newline-terminated) to an existing transcript. */
function appendTranscript(id: string, events: object[]): void {
  fs.appendFileSync(sessionFile(id), events.map(line).join('\n') + '\n', 'utf-8');
}

/**
 * Push a file's mtime forward by `plusSeconds` past now so an append is never
 * seen as a clock-rewind, and so the ledger stamp actually changes (a second
 * write inside the same wall-clock second can leave mtime identical, which the
 * ledger reads as "unchanged" and skips).
 */
function bumpMtimeToNow(fp: string, plusSeconds: number): void {
  const t = Math.floor(Date.now() / 1000) + plusSeconds;
  fs.utimesSync(fp, t, t);
}

/**
 * Push every ledger row's scanned_at back past the 5s active-append debounce so a
 * grown file re-scanned in the same test tick is NOT deferred by
 * shouldDeferRecentAppend. Real appends arrive seconds apart; the test compresses
 * that by aging the stamp instead of sleeping. Run before every scan — harmless
 * on a cold ledger (no rows to age).
 */
function agePriorScans(): void {
  db.getDB().prepare('UPDATE scan_ledger SET scanned_at = ?').run(Date.now() - 60_000);
}

async function runScan(): Promise<void> {
  agePriorScans();
  await discover.discoverSessions({ agent: 'claude', all: true });
}

/** The set of session-row fields that MUST match between incremental + full. */
const PARITY_FIELDS = [
  'agent', 'timestamp', 'lastActivity', 'project', 'cwd', 'gitBranch', 'version',
  'topic', 'messageCount', 'tokenCount', 'outputTokens', 'costUsd', 'durationMs',
  'isTeamOrigin', 'prUrl', 'prNumber', 'worktreeSlug', 'ticketId', 'createdTickets',
  'spawnedTeam', 'plan',
] as const;

function assertRowParity(incId: string, fullId: string): void {
  const inc = db.getSessionById(incId);
  const full = db.getSessionById(fullId);
  expect(inc, `incremental row ${incId} exists`).not.toBeNull();
  expect(full, `full-reparse row ${fullId} exists`).not.toBeNull();
  for (const f of PARITY_FIELDS) {
    expect((inc as any)[f], `field ${f}`).toEqual((full as any)[f]);
  }
}

/**
 * Compute the from-scratch ground truth for a set of events: write them to a
 * brand-new id (no prior ledger continuation → FULL parse), scan, and return
 * that id so its row can be compared field-for-field.
 */
let groundTruthCounter = 0;
async function groundTruth(events: object[]): Promise<string> {
  const id = `ground-truth-${groundTruthCounter++}`;
  writeTranscript(id, events);
  await runScan();
  return id;
}

beforeAll(async () => {
  db = await import('../db.js');
  discover = await import('../discover.js');
  db.getDB(); // create schema
});

beforeEach(() => {
  discover.__resetClaudeScanBranchCountsForTest();
});

afterAll(() => {
  // Close before removing the tree: Windows refuses to unlink an open file, so
  // a leaked connection (plus its WAL sidecars) fails the whole suite there.
  db.closeDB();
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  if (REAL_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_USERPROFILE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// A field-rich first chunk: a user turn, assistant events with usage/cost, a plan.
function baseEvents(id: string): object[] {
  return [
    { type: 'user', timestamp: '2026-06-28T00:00:00.000Z', cwd: '/home/u/repo', gitBranch: 'RUSH-42-fix', version: '2.1.0', entrypoint: 'cli', message: { role: 'user', content: `investigate flaky exec test for ${id}` } },
    { type: 'assistant', timestamp: '2026-06-28T00:01:00.000Z', uuid: `${id}-a1`, message: { id: `${id}-msg1`, model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'looking' }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 } } },
    { type: 'assistant', timestamp: '2026-06-28T00:02:00.000Z', uuid: `${id}-a2`, message: { id: `${id}-msg2`, model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: `${id}-plan1`, name: 'ExitPlanMode', input: { plan: '# Plan\n- step one' } }], usage: { input_tokens: 50, output_tokens: 10 } } },
  ];
}

// The appended chunk: a second user turn, a title, more assistant tokens.
function appendedEvents(id: string): object[] {
  return [
    { type: 'user', timestamp: '2026-06-28T00:03:00.000Z', message: { role: 'user', content: 'yes go ahead and ship it' } },
    { type: 'ai-title', aiTitle: 'Flaky exec test fix', sessionId: id },
    { type: 'assistant', timestamp: '2026-06-28T00:04:00.000Z', uuid: `${id}-a3`, message: { id: `${id}-msg3`, model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 30, output_tokens: 40 } } },
  ];
}

describe('B-2 live incremental scan parity', () => {
  it('CORE: an appended session, re-scanned incrementally, equals a from-scratch full reparse for every field', async () => {
    const id = 'core-session';

    // First scan: cold → FULL parse of the seed.
    writeTranscript(id, baseEvents(id));
    await runScan();
    expect(discover.__claudeScanBranchCountsForTest().full).toBeGreaterThanOrEqual(1);

    // Append + re-scan → INCREMENTAL branch must be taken for this file.
    discover.__resetClaudeScanBranchCountsForTest();
    appendTranscript(id, appendedEvents(id));
    bumpMtimeToNow(sessionFile(id), 1);
    await runScan();
    const counts = discover.__claudeScanBranchCountsForTest();
    expect(counts.incremental, 'incremental branch exercised on 2nd scan').toBeGreaterThanOrEqual(1);

    // Ground truth: the FINAL content parsed from scratch under a fresh id.
    const gtId = await groundTruth([...baseEvents(id), ...appendedEvents(id)]);

    assertRowParity(id, gtId);

    // Spot-check the incrementally-scanned row carries the appended-chunk signals.
    const inc = db.getSessionById(id)!;
    expect(inc.topic).toBe('investigate flaky exec test for core-session');
    expect(inc.label).toBe('Flaky exec test fix'); // ai-title came in the append
    expect(inc.messageCount).toBe(5);
    // outputTokens = 20 + 10 + 40 across all three assistant events.
    expect(inc.outputTokens).toBe(70);
  });

  it('STRADDLED PR: gh pr create tool_use in the first write, its URL in the append → correct prUrl/prNumber', async () => {
    const id = 'straddle-pr';
    writeTranscript(id, [
      { type: 'user', timestamp: '2026-06-28T01:00:00.000Z', cwd: '/home/u/repo', message: { role: 'user', content: 'open a pr' } },
      { type: 'assistant', timestamp: '2026-06-28T01:01:00.000Z', uuid: `${id}-a1`, message: { id: `${id}-m1`, model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: `${id}-t1`, name: 'Bash', input: { command: 'gh pr create --title x --body y' } }], usage: { input_tokens: 10, output_tokens: 5 } } },
    ]);
    await runScan();
    // No URL yet.
    expect(db.getSessionById(id)!.prUrl ?? null).toBeNull();

    // The tool_result URL lands in the appended chunk.
    appendTranscript(id, [
      { type: 'user', timestamp: '2026-06-28T01:02:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${id}-t1`, content: 'https://github.com/acme/repo/pull/4242' }] } },
    ]);
    bumpMtimeToNow(sessionFile(id), 1);
    await runScan();
    expect(discover.__claudeScanBranchCountsForTest().incremental).toBeGreaterThanOrEqual(1);

    const inc = db.getSessionById(id)!;
    expect(inc.prUrl).toBe('https://github.com/acme/repo/pull/4242');
    expect(inc.prNumber).toBe(4242);
    expect(db.getDB().prepare(`
      SELECT source_call_id, outcome, output FROM tool_calls WHERE session_id = ?
    `).get(id)).toEqual({
      source_call_id: `${id}-t1`,
      outcome: 'ok',
      output: 'https://github.com/acme/repo/pull/4242',
    });

    // Full-reparse parity.
    const gtId = await groundTruth([
      { type: 'user', timestamp: '2026-06-28T01:00:00.000Z', cwd: '/home/u/repo', message: { role: 'user', content: 'open a pr' } },
      { type: 'assistant', timestamp: '2026-06-28T01:01:00.000Z', uuid: `${id}-a1`, message: { id: `${id}-m1`, model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: `${id}-t1`, name: 'Bash', input: { command: 'gh pr create --title x --body y' } }], usage: { input_tokens: 10, output_tokens: 5 } } },
      { type: 'user', timestamp: '2026-06-28T01:02:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${id}-t1`, content: 'https://github.com/acme/repo/pull/4242' }] } },
    ]);
    assertRowParity(id, gtId);
  });

  it('STRADDLED ticket: create_issue tool_use first, its ref in the append → correct createdTickets', async () => {
    const id = 'straddle-ticket';
    writeTranscript(id, [
      { type: 'user', timestamp: '2026-06-28T02:00:00.000Z', cwd: '/home/u/repo', message: { role: 'user', content: 'file a ticket' } },
      { type: 'assistant', timestamp: '2026-06-28T02:01:00.000Z', uuid: `${id}-a1`, message: { id: `${id}-m1`, model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: `${id}-t1`, name: 'Bash', input: { command: 'gh issue create --title bug' } }], usage: { input_tokens: 8, output_tokens: 4 } } },
    ]);
    await runScan();

    appendTranscript(id, [
      { type: 'user', timestamp: '2026-06-28T02:02:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${id}-t1`, content: 'https://github.com/acme/repo/issues/77' }] } },
    ]);
    bumpMtimeToNow(sessionFile(id), 1);
    await runScan();
    expect(discover.__claudeScanBranchCountsForTest().incremental).toBeGreaterThanOrEqual(1);

    const gtId = await groundTruth([
      { type: 'user', timestamp: '2026-06-28T02:00:00.000Z', cwd: '/home/u/repo', message: { role: 'user', content: 'file a ticket' } },
      { type: 'assistant', timestamp: '2026-06-28T02:01:00.000Z', uuid: `${id}-a1`, message: { id: `${id}-m1`, model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: `${id}-t1`, name: 'Bash', input: { command: 'gh issue create --title bug' } }], usage: { input_tokens: 8, output_tokens: 4 } } },
      { type: 'user', timestamp: '2026-06-28T02:02:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${id}-t1`, content: 'https://github.com/acme/repo/issues/77' }] } },
    ]);
    assertRowParity(id, gtId);
  });

  it('STRADDLED title: a title in the appended chunk refines label without replacing topic', async () => {
    const id = 'straddle-title';
    writeTranscript(id, [
      { type: 'user', timestamp: '2026-06-28T03:00:00.000Z', cwd: '/home/u/repo', message: { role: 'user', content: 'do the thing please' } },
    ]);
    await runScan();
    // Topic is the first prompt; label is absent before the title arrives.
    const before = db.getSessionById(id)!;
    expect(before.topic).toBe('do the thing please');
    expect(before.label).toBeUndefined();

    appendTranscript(id, [
      { type: 'custom-title', customTitle: 'Rename me later', sessionId: id },
      { type: 'user', timestamp: '2026-06-28T03:01:00.000Z', message: { role: 'user', content: 'thanks' } },
    ]);
    bumpMtimeToNow(sessionFile(id), 1);
    await runScan();
    expect(discover.__claudeScanBranchCountsForTest().incremental).toBeGreaterThanOrEqual(1);
    expect(db.getSessionById(id)!.topic).toBe('do the thing please');
    expect(db.getSessionById(id)!.label).toBe('Rename me later');

    const gtId = await groundTruth([
      { type: 'user', timestamp: '2026-06-28T03:00:00.000Z', cwd: '/home/u/repo', message: { role: 'user', content: 'do the thing please' } },
      { type: 'custom-title', customTitle: 'Rename me later', sessionId: id },
      { type: 'user', timestamp: '2026-06-28T03:01:00.000Z', message: { role: 'user', content: 'thanks' } },
    ]);
    assertRowParity(id, gtId);
  });

  it('FALLBACK-ID: assistant events sharing a timestamp with no id, split across scans, keep messageCount parity', async () => {
    const id = 'fallback-id';
    const ts = '2026-06-28T04:00:00.000Z';
    // No message.id / uuid → logical id falls back to `${ts}:${seenSize}`, which
    // depends on the hydrated set's exact size across the scan boundary.
    writeTranscript(id, [
      { type: 'user', timestamp: '2026-06-28T03:59:00.000Z', cwd: '/home/u/repo', message: { role: 'user', content: 'start' } },
      { type: 'assistant', timestamp: ts, message: { model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'one' }], usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'assistant', timestamp: ts, message: { model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'two' }], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    await runScan();

    appendTranscript(id, [
      { type: 'assistant', timestamp: ts, message: { model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'three' }], usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'assistant', timestamp: ts, message: { model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'four' }], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    bumpMtimeToNow(sessionFile(id), 1);
    await runScan();
    expect(discover.__claudeScanBranchCountsForTest().incremental).toBeGreaterThanOrEqual(1);

    const gtId = await groundTruth([
      { type: 'user', timestamp: '2026-06-28T03:59:00.000Z', cwd: '/home/u/repo', message: { role: 'user', content: 'start' } },
      { type: 'assistant', timestamp: ts, message: { model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'one' }], usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'assistant', timestamp: ts, message: { model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'two' }], usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'assistant', timestamp: ts, message: { model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'three' }], usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'assistant', timestamp: ts, message: { model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'four' }], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    // 1 user + 4 distinct assistant events → 5 messages (no double-count).
    expect(db.getSessionById(id)!.messageCount).toBe(5);
    assertRowParity(id, gtId);
  });

  it('TRUNCATION: rewriting the file smaller forces a FULL reparse with no stale/doubled counters', async () => {
    const id = 'truncation';
    writeTranscript(id, [...baseEvents(id), ...appendedEvents(id)]);
    await runScan();
    const long = db.getSessionById(id)!;
    expect(long.messageCount).toBe(5);

    // Rewrite the file with LESS content (a different, shorter session). Its size
    // shrinks below the persisted offset → the decision must fall back to FULL.
    discover.__resetClaudeScanBranchCountsForTest();
    const rewritten = [
      { type: 'user', timestamp: '2026-06-29T00:00:00.000Z', cwd: '/home/u/repo', message: { role: 'user', content: 'fresh short session' } },
    ];
    fs.writeFileSync(sessionFile(id), rewritten.map(line).join('\n') + '\n', 'utf-8');
    bumpMtimeToNow(sessionFile(id), 2);
    await runScan();
    const counts = discover.__claudeScanBranchCountsForTest();
    expect(counts.full, 'truncation forces a full reparse').toBeGreaterThanOrEqual(1);
    expect(counts.incremental, 'truncation must NOT go incremental').toBe(0);

    const short = db.getSessionById(id)!;
    // No stale/doubled counters: exactly the one message of the rewritten file.
    expect(short.messageCount).toBe(1);
    expect(short.tokenCount ?? null).toBeNull();
    expect(short.topic).toBe('fresh short session');

    const gtId = await groundTruth(rewritten);
    assertRowParity(id, gtId);
  });

  it('IN-PLACE REWRITE: replacing the path with a DIFFERENT, LARGER session forces FULL (no cross-session corruption)', async () => {
    const id = 'inplace-rewrite';

    // Seed + scan session A → FULL, persisting a continuation whose offset is A's
    // byte length.
    const fp = writeTranscript(id, baseEvents(id));
    await runScan();
    const priorOffset = JSON.parse(db.getParserStatesForPaths([fp]).get(fp)!.parserState!).offset as number;

    // Replace the path IN PLACE with a DIFFERENT session (distinct first
    // timestamp) whose byte length is LARGER than the stored offset and whose
    // mtime moves forward — the exact shape metadata cannot tell from an append.
    // Size-grew + mtime-forward alone would wrongly resume from priorOffset and
    // fold session B's bytes into session A's hydrated accumulator; the identity
    // re-check must catch the session change and force FULL.
    discover.__resetClaudeScanBranchCountsForTest();
    const sessionB = [
      { type: 'user', timestamp: '2026-07-01T09:00:00.000Z', cwd: '/home/u/other', gitBranch: 'PROJ-7', version: '2.2.0', message: { role: 'user', content: `restored different session ${'x'.repeat(400)}` } },
      { type: 'assistant', timestamp: '2026-07-01T09:01:00.000Z', uuid: `${id}-b1`, message: { id: `${id}-bmsg1`, model: 'claude-sonnet-4-5', content: [{ type: 'text', text: `restored reply ${'y'.repeat(200)}` }], usage: { input_tokens: 200, output_tokens: 60 } } },
      { type: 'assistant', timestamp: '2026-07-01T09:02:00.000Z', uuid: `${id}-b2`, message: { id: `${id}-bmsg2`, model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'more restored content' }], usage: { input_tokens: 90, output_tokens: 30 } } },
    ];
    fs.writeFileSync(fp, sessionB.map(line).join('\n') + '\n', 'utf-8');
    bumpMtimeToNow(fp, 3);

    // Precondition — this is the trap: the new file is LARGER than the stored
    // offset, so the size gate that the old logic relied on does NOT fire.
    expect(fs.statSync(fp).size, 'rewritten file must exceed the prior offset to exercise the guard').toBeGreaterThan(priorOffset);

    await runScan();
    const counts = discover.__claudeScanBranchCountsForTest();
    expect(counts.full, 'in-place rewrite to a different session must force FULL').toBeGreaterThanOrEqual(1);
    expect(counts.incremental, 'must NOT resume incrementally across a session boundary').toBe(0);

    // No cross-session corruption: the row equals a from-scratch parse of session B.
    const row = db.getSessionById(id)!;
    expect(row.messageCount).toBe(3);
    expect(row.timestamp).toBe('2026-07-01T09:00:00.000Z');
    const gtId = await groundTruth(sessionB);
    assertRowParity(id, gtId);
  });

  it('FTS: a content search finds the session by a term that appears only in the appended chunk', async () => {
    const id = 'fts-append';
    writeTranscript(id, [
      { type: 'user', timestamp: '2026-06-28T05:00:00.000Z', cwd: '/home/u/repo', message: { role: 'user', content: 'initial prompt about apples' } },
    ]);
    await runScan();
    // The distinctive term is NOT present yet.
    expect(db.ftsSearch('zorptastic').some(h => h.sessionId === id)).toBe(false);

    appendTranscript(id, [
      { type: 'user', timestamp: '2026-06-28T05:01:00.000Z', message: { role: 'user', content: 'now a message with the zorptastic keyword' } },
    ]);
    bumpMtimeToNow(sessionFile(id), 1);
    await runScan();
    expect(discover.__claudeScanBranchCountsForTest().incremental).toBeGreaterThanOrEqual(1);

    const hits = db.ftsSearch('zorptastic');
    expect(hits.some(h => h.sessionId === id), 'FTS finds appended-only text').toBe(true);
  });

  it('streams past an oversized appended JSONL record and resumes at the next record', async () => {
    const id = 'oversized-append';
    const fp = writeTranscript(id, [
      { type: 'user', timestamp: '2026-06-28T05:00:00.000Z', message: { role: 'user', content: 'before oversized record' } },
    ]);
    await runScan();

    fs.appendFileSync(fp, 'x'.repeat(1024 * 1024 + 1));
    bumpMtimeToNow(fp, 1);
    await runScan();
    let state = JSON.parse(db.getParserStatesForPaths([fp]).get(fp)!.parserState!);
    expect(state.offset).toBe(fs.statSync(fp).size);
    expect(state.jsonlDroppingOversizedLine).toBe(true);
    expect(db.getSessionById(id)?.messageCount).toBe(1);
    const { ensureToolIndex } = await import('../tool-index.js');
    const limitedCoverage = await ensureToolIndex([db.getSessionById(id)!]);
    expect(limitedCoverage).toMatchObject({ limitedFiles: 1, complete: false });
    expect(db.getDB().prepare(`SELECT tool FROM tool_calls WHERE session_id = ?`).all(id))
      .toEqual([{ tool: 'index_limit' }]);

    fs.appendFileSync(fp, 'y'.repeat(64 * 1024));
    bumpMtimeToNow(fp, 2);
    await runScan();
    state = JSON.parse(db.getParserStatesForPaths([fp]).get(fp)!.parserState!);
    expect(state.offset).toBe(fs.statSync(fp).size);
    expect(state.jsonlDroppingOversizedLine).toBe(true);

    fs.appendFileSync(fp, `\n${line({
      type: 'user', timestamp: '2026-06-28T05:01:00.000Z',
      message: { role: 'user', content: 'after oversized record' },
    })}\n`);
    bumpMtimeToNow(fp, 3);
    await runScan();

    expect(discover.__claudeScanBranchCountsForTest().incremental).toBeGreaterThanOrEqual(1);
    expect(db.getSessionById(id)?.messageCount).toBe(2);
    state = JSON.parse(db.getParserStatesForPaths([fp]).get(fp)!.parserState!);
    expect(state.offset).toBe(fs.statSync(fp).size);
    expect(state.jsonlDroppingOversizedLine).toBeUndefined();
  });

  it('purges indexed tool evidence when a transcript disappears from a changed directory', async () => {
    const id = 'deleted-tool-evidence';
    const fp = writeTranscript(id, [
      { type: 'assistant', timestamp: '2026-06-28T05:00:00.000Z', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'deleted-call', name: 'Bash', input: { command: 'git status' } },
      ] } },
    ]);
    await runScan();
    const session = db.getSessionById(id)!;
    const { ensureToolIndex } = await import('../tool-index.js');
    await ensureToolIndex([session]);
    expect(db.getDB().prepare('SELECT count(*) AS n FROM tool_calls WHERE session_id = ?').get(id)).toEqual({ n: 1 });

    fs.unlinkSync(fp);
    bumpMtimeToNow(PROJECT_DIR, 1);
    await runScan();
    expect(db.getDB().prepare('SELECT count(*) AS n FROM tool_calls WHERE session_id = ?').get(id)).toEqual({ n: 0 });
  });

  it('UPGRADE: a pre-tool-call continuation forces one full parse without overwriting ordinal zero', async () => {
    const id = 'legacy-continuation-tool-calls';
    const fp = writeTranscript(id, [
      { type: 'user', timestamp: '2026-06-28T06:00:00.000Z', cwd: '/home/u/repo', message: { role: 'user', content: 'run both checks' } },
      { type: 'assistant', timestamp: '2026-06-28T06:01:00.000Z', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'legacy-call', name: 'Bash', input: { command: 'git status' } },
      ] } },
    ]);
    await runScan();

    const legacyState = JSON.parse(db.getParserStatesForPaths([fp]).get(fp)!.parserState!);
    legacyState.v = 1;
    delete legacyState.toolCalls;
    db.getDB().prepare('UPDATE scan_ledger SET parser_state = ? WHERE file_path = ?')
      .run(JSON.stringify(legacyState), fs.realpathSync(fp));

    discover.__resetClaudeScanBranchCountsForTest();
    appendTranscript(id, [
      { type: 'assistant', timestamp: '2026-06-28T06:02:00.000Z', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'new-call', name: 'Bash', input: { command: 'gh pr view' } },
      ] } },
    ]);
    bumpMtimeToNow(fp, 1);
    await runScan();

    expect(discover.__claudeScanBranchCountsForTest().incremental).toBe(0);
    expect(discover.__claudeScanBranchCountsForTest().full).toBeGreaterThanOrEqual(1);
    expect(db.getDB().prepare(`
      SELECT ordinal, source_call_id FROM tool_calls WHERE session_id = ? ORDER BY ordinal
    `).all(id)).toEqual([
      { ordinal: 0, source_call_id: 'legacy-call' },
      { ordinal: 1, source_call_id: 'new-call' },
    ]);
  });

  it('LEDGER: parser_state + content_text are persisted after a scan, and rewritten after truncation', async () => {
    const id = 'ledger-persist';
    const fp = writeTranscript(id, baseEvents(id));
    await runScan();

    const states = db.getParserStatesForPaths([fp]);
    const row = states.get(fp);
    expect(row, 'ledger row exists for the scanned file').toBeDefined();
    expect(row!.parserState, 'parser_state persisted').not.toBeNull();
    expect(row!.contentText, 'content_text persisted').not.toBeNull();
    const parsed = JSON.parse(row!.parserState!);
    expect(parsed.v).toBe(3);
    expect(typeof parsed.offset).toBe('number');
    const offsetAfterFirst = parsed.offset;

    // Append → offset must advance (state rewritten).
    appendTranscript(id, appendedEvents(id));
    bumpMtimeToNow(fp, 1);
    await runScan();
    const afterAppend = JSON.parse(db.getParserStatesForPaths([fp]).get(fp)!.parserState!);
    expect(afterAppend.offset).toBeGreaterThan(offsetAfterFirst);

    // Truncate → offset must reset to the (smaller) rewritten file's byte length.
    fs.writeFileSync(fp, line({ type: 'user', timestamp: '2026-06-30T00:00:00.000Z', cwd: '/home/u/repo', message: { role: 'user', content: 'tiny' } }) + '\n', 'utf-8');
    bumpMtimeToNow(fp, 2);
    await runScan();
    const afterTrunc = JSON.parse(db.getParserStatesForPaths([fp]).get(fp)!.parserState!);
    expect(afterTrunc.offset).toBeLessThan(afterAppend.offset);
    expect(afterTrunc.offset).toBe(fs.statSync(fp).size);
  });
});
