import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// End-to-end parity for the live Codex scan (B-3): the incremental DB row equals a from-scratch
// reparse even when PR/ticket signals straddle two scans; truncation forces a full reparse. No
// mocks. Ground truth is the same content under a different session id (no ledger row, FULL path).

const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-codex-e2e-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

type Discover = typeof import('../discover.js');
type DB = typeof import('../db.js');

let discover: Discover;
let db: DB;

const SESSIONS = path.join(tmpHome, '.codex', 'sessions');

function line(obj: object): string {
  return JSON.stringify(obj);
}

/** Path of a rollout file for a given session id under the live sessions dir. */
function rolloutFile(id: string): string {
  return path.join(SESSIONS, `rollout-${id}.jsonl`);
}

function writeRollout(id: string, events: object[]): string {
  fs.mkdirSync(SESSIONS, { recursive: true });
  const fp = rolloutFile(id);
  fs.writeFileSync(fp, events.map(line).join('\n') + '\n', 'utf-8');
  bumpMtimeToNow(fp, 0);
  return fp;
}

function appendRollout(id: string, events: object[]): void {
  fs.appendFileSync(rolloutFile(id), events.map(line).join('\n') + '\n', 'utf-8');
}

/** Push a file's mtime forward so an append isn't seen as a clock-rewind and the ledger stamp changes. */
function bumpMtimeToNow(fp: string, plusSeconds: number): void {
  const t = Math.floor(Date.now() / 1000) + plusSeconds;
  fs.utimesSync(fp, t, t);
}

/** Age every ledger row past the 5s active-append debounce so a grown file re-scans this tick. */
function agePriorScans(): void {
  db.getDB().prepare('UPDATE scan_ledger SET scanned_at = ?').run(Date.now() - 60_000);
}

async function runScan(): Promise<void> {
  agePriorScans();
  await discover.discoverSessions({ agent: 'codex', all: true });
}

// `timestamp` and `lastActivity` are excluded: Codex's timestamp is max(session_meta.timestamp,
// file.mtime), so two separate files have different mtimes. Every other field must match exactly.
const PARITY_FIELDS = [
  'agent', 'project', 'cwd', 'gitBranch', 'version',
  'topic', 'messageCount', 'tokenCount', 'outputTokens', 'costUsd', 'durationMs',
  'prUrl', 'prNumber', 'worktreeSlug', 'ticketId', 'createdTickets', 'spawnedTeam',
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

let groundTruthCounter = 0;
/** Compute the from-scratch ground truth: write the events to a new rollout file with a fresh
 * session_meta id (full parse). Returns the session id, which is the DB row key, not the file
 * name. */
async function groundTruth(events: object[], sessionId: string): Promise<string> {
  const fileId = `ground-truth-${groundTruthCounter++}`;
  writeRollout(fileId, events);
  await runScan();
  return sessionId;
}

beforeAll(async () => {
  db = await import('../db.js');
  discover = await import('../discover.js');
  db.getDB();
});

beforeEach(() => {
  discover.__resetCodexScanBranchCountsForTest();
});

afterAll(() => {
  // Close before removing the tree: Windows refuses to unlink an open file, so
  // a leaked connection (plus its WAL sidecars) fails the whole suite there.
  db.closeDB();
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  if (REAL_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_USERPROFILE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** Field-rich base events. `sessionId` only sets session_meta.id (the row key); user text is stable
 * so topic/contentText parity holds across ids. */
function baseEvents(sessionId: string): object[] {
  return [
    { type: 'session_meta', timestamp: '2026-06-28T00:00:00.000Z', payload: { id: sessionId, timestamp: '2026-06-28T00:00:00.000Z', cwd: '/home/u/repo', git: { branch: 'RUSH-42-fix' }, cli_version: '0.9.0', model: 'gpt-5-codex' } },
    { type: 'response_item', timestamp: '2026-06-28T00:00:30.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'investigate the flaky exec test' }] } },
    { type: 'event_msg', timestamp: '2026-06-28T00:01:05.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 4 } } } },
  ];
}

function appendedEvents(): object[] {
  return [
    { type: 'response_item', timestamp: '2026-06-28T00:03:00.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
    { type: 'event_msg', timestamp: '2026-06-28T00:03:05.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 400, output_tokens: 80, reasoning_output_tokens: 10 } } } },
  ];
}

describe('B-3 live incremental Codex scan parity', () => {
  it('CORE: an appended rollout, re-scanned incrementally, equals a from-scratch full reparse for every field', async () => {
    const id = 'core-session';

    writeRollout(id, baseEvents(id));
    await runScan();
    expect(discover.__codexScanBranchCountsForTest().full).toBeGreaterThanOrEqual(1);

    discover.__resetCodexScanBranchCountsForTest();
    appendRollout(id, appendedEvents());
    bumpMtimeToNow(rolloutFile(id), 1);
    await runScan();
    expect(discover.__codexScanBranchCountsForTest().incremental, 'incremental branch exercised on 2nd scan').toBeGreaterThanOrEqual(1);

    // Ground truth: the FINAL content parsed from scratch under a fresh session id.
    const gtBase = baseEvents('gt-core');
    const gtId = await groundTruth([...gtBase, ...appendedEvents()], 'gt-core');
    assertRowParity(id, gtId);

    const inc = db.getSessionById(id)!;
    // LAST-WINS token snapshot from the append: 400 + 80 + 10 = 490.
    expect(inc.tokenCount).toBe(490);
    expect(inc.outputTokens).toBe(90);
    expect(inc.messageCount).toBe(2);
  });

  it('STRADDLED PR: gh pr create in the first write, its URL in the append → correct prUrl/prNumber', async () => {
    const id = 'straddle-pr';
    writeRollout(id, [
      { type: 'session_meta', timestamp: '2026-06-28T01:00:00.000Z', payload: { id, cwd: '/home/u/repo' } },
      { type: 'response_item', timestamp: '2026-06-28T01:01:00.000Z', payload: { type: 'function_call', name: 'shell', call_id: 't1', arguments: JSON.stringify({ command: 'gh pr create --title x --body y' }) } },
    ]);
    await runScan();
    expect(db.getSessionById(id)!.prUrl ?? null).toBeNull();

    appendRollout(id, [
      { type: 'response_item', timestamp: '2026-06-28T01:02:00.000Z', payload: { type: 'function_call_output', call_id: 't1', output: 'https://github.com/acme/repo/pull/4242' } },
    ]);
    bumpMtimeToNow(rolloutFile(id), 1);
    await runScan();
    expect(discover.__codexScanBranchCountsForTest().incremental).toBeGreaterThanOrEqual(1);

    const inc = db.getSessionById(id)!;
    expect(inc.prUrl).toBe('https://github.com/acme/repo/pull/4242');
    expect(inc.prNumber).toBe(4242);
    expect(db.getDB().prepare(`
      SELECT source_call_id, outcome, output FROM tool_calls WHERE session_id = ?
    `).get(id)).toEqual({
      source_call_id: 't1',
      outcome: 'unknown',
      output: 'https://github.com/acme/repo/pull/4242',
    });
  });

  it('STRADDLED ticket: gh issue create first, its ref in the append → correct createdTickets', async () => {
    const id = 'straddle-ticket';
    writeRollout(id, [
      { type: 'session_meta', timestamp: '2026-06-28T02:00:00.000Z', payload: { id, cwd: '/home/u/repo' } },
      { type: 'response_item', timestamp: '2026-06-28T02:01:00.000Z', payload: { type: 'function_call', name: 'shell', call_id: 't1', arguments: JSON.stringify({ command: 'gh issue create --title bug' }) } },
    ]);
    await runScan();

    appendRollout(id, [
      { type: 'response_item', timestamp: '2026-06-28T02:02:00.000Z', payload: { type: 'function_call_output', call_id: 't1', output: 'https://github.com/acme/repo/issues/77' } },
    ]);
    bumpMtimeToNow(rolloutFile(id), 1);
    await runScan();
    expect(discover.__codexScanBranchCountsForTest().incremental).toBeGreaterThanOrEqual(1);

    const gtId = await groundTruth([
      { type: 'session_meta', timestamp: '2026-06-28T02:00:00.000Z', payload: { id: 'gt-ticket', cwd: '/home/u/repo' } },
      { type: 'response_item', timestamp: '2026-06-28T02:01:00.000Z', payload: { type: 'function_call', name: 'shell', call_id: 't1', arguments: JSON.stringify({ command: 'gh issue create --title bug' }) } },
      { type: 'response_item', timestamp: '2026-06-28T02:02:00.000Z', payload: { type: 'function_call_output', call_id: 't1', output: 'https://github.com/acme/repo/issues/77' } },
    ], 'gt-ticket');
    // createdTickets is derived by the scan (asserted at function level in the
    // parity harness) but not a persisted DB column, so row parity is the check
    // here: the incremental row must not diverge from the full reparse row.
    assertRowParity(id, gtId);
  });

  it('TRUNCATION: rewriting the rollout smaller forces a FULL reparse with no stale/doubled counters', async () => {
    const id = 'truncation';
    writeRollout(id, [...baseEvents(id), ...appendedEvents()]);
    await runScan();
    expect(db.getSessionById(id)!.messageCount).toBe(2);

    discover.__resetCodexScanBranchCountsForTest();
    const rewritten = [
      { type: 'session_meta', timestamp: '2026-06-29T00:00:00.000Z', payload: { id, cwd: '/home/u/repo' } },
      { type: 'response_item', timestamp: '2026-06-29T00:00:30.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fresh short session' }] } },
    ];
    fs.writeFileSync(rolloutFile(id), rewritten.map(line).join('\n') + '\n', 'utf-8');
    bumpMtimeToNow(rolloutFile(id), 2);
    await runScan();
    const counts = discover.__codexScanBranchCountsForTest();
    expect(counts.full, 'truncation forces a full reparse').toBeGreaterThanOrEqual(1);
    expect(counts.incremental, 'truncation must NOT go incremental').toBe(0);

    const short = db.getSessionById(id)!;
    expect(short.messageCount).toBe(1);
    expect(short.tokenCount ?? null).toBeNull();
    expect(short.topic).toBe('fresh short session');
  });

  it('IN-PLACE REWRITE: replacing the path with a DIFFERENT, LARGER session forces FULL (no cross-session corruption)', async () => {
    // The metadata-only guard (size grew + mtime forward) cannot tell an append from an in-place
    // rewrite putting a different, larger rollout at the same path. The session_meta-id re-check
    // (codexSessionIdentityAt) must force FULL. Mirrors the Claude test in commit 1c8ff457.
    const idA = 'sess-inplace-A';
    const fp = writeRollout('inplace-rewrite', baseEvents(idA));
    await runScan();
    const priorOffset = JSON.parse(db.getParserStatesForPaths([fp]).get(fp)!.parserState!).offset as number;
    expect(db.getSessionById(idA), 'session A indexed on first scan').not.toBeNull();

    // Replace the path in place with a different session (new id and first timestamp), larger than
    // the stored offset with a later mtime: the shape metadata cannot tell from an append.
    discover.__resetCodexScanBranchCountsForTest();
    const idB = 'sess-inplace-B';
    const sessionB = [
      { type: 'session_meta', timestamp: '2026-07-01T09:00:00.000Z', payload: { id: idB, timestamp: '2026-07-01T09:00:00.000Z', cwd: '/home/u/other', git: { branch: 'PROJ-7' }, cli_version: '1.0.0', model: 'gpt-5-codex' } },
      { type: 'response_item', timestamp: '2026-07-01T09:00:30.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `restored different session ${'x'.repeat(400)}` }] } },
      { type: 'response_item', timestamp: '2026-07-01T09:01:00.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `restored reply ${'y'.repeat(200)}` }] } },
      { type: 'event_msg', timestamp: '2026-07-01T09:01:05.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 200, output_tokens: 60, reasoning_output_tokens: 10 } } } },
    ];
    fs.writeFileSync(fp, sessionB.map(line).join('\n') + '\n', 'utf-8');
    bumpMtimeToNow(fp, 3);

    // Precondition — the trap: the new file is LARGER than the stored offset, so
    // the size gate the metadata-only logic relied on does NOT fire.
    expect(fs.statSync(fp).size, 'rewritten file must exceed the prior offset to exercise the guard').toBeGreaterThan(priorOffset);

    await runScan();
    const counts = discover.__codexScanBranchCountsForTest();
    expect(counts.full, 'in-place rewrite to a different session must force FULL').toBeGreaterThanOrEqual(1);
    expect(counts.incremental, 'must NOT resume incrementally across a session boundary').toBe(0);

    // No cross-session corruption: the row (now under session B's id — the path's
    // ledger row was rewritten) equals a from-scratch parse of session B, and
    // carries B's counters, not A's continuation folded into B.
    const row = db.getSessionById(idB)!;
    expect(row, 'session B row exists after the rewrite').not.toBeNull();
    expect(row.messageCount).toBe(2);
    // LAST-WINS token snapshot from B: 200 + 60 + 10 = 270.
    expect(row.tokenCount).toBe(270);

    // Ground truth: session B's identical content under a DIFFERENT session_meta
    // id (so it lands in its own row, not idB's), parsed from scratch. Text is
    // stable so topic/counts/tokens parity holds.
    const gtSessionId = 'sess-inplace-gt';
    const gtId = await groundTruth(
      sessionB.map((e: any) =>
        e.type === 'session_meta'
          ? { ...e, payload: { ...e.payload, id: gtSessionId } }
          : e,
      ),
      gtSessionId,
    );
    assertRowParity(idB, gtId);
  });

  it('streams past an oversized appended JSONL record and resumes at the next record', async () => {
    const id = 'oversized-append';
    const fp = writeRollout(id, baseEvents(id));
    await runScan();

    fs.appendFileSync(fp, 'x'.repeat(1024 * 1024 + 1));
    bumpMtimeToNow(fp, 1);
    await runScan();
    let state = JSON.parse(db.getParserStatesForPaths([fp]).get(fp)!.parserState!);
    expect(state.offset).toBe(fs.statSync(fp).size);
    expect(state.jsonlDroppingOversizedLine).toBe(true);
    expect(db.getSessionById(id)?.messageCount).toBe(1);

    fs.appendFileSync(fp, 'y'.repeat(64 * 1024));
    bumpMtimeToNow(fp, 2);
    await runScan();
    state = JSON.parse(db.getParserStatesForPaths([fp]).get(fp)!.parserState!);
    expect(state.offset).toBe(fs.statSync(fp).size);
    expect(state.jsonlDroppingOversizedLine).toBe(true);

    fs.appendFileSync(fp, `\n${line({
      type: 'response_item', timestamp: '2026-06-28T00:03:00.000Z',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'after oversized record' }] },
    })}\n`);
    bumpMtimeToNow(fp, 3);
    await runScan();

    expect(discover.__codexScanBranchCountsForTest().incremental).toBeGreaterThanOrEqual(1);
    expect(db.getSessionById(id)?.messageCount).toBe(2);
    state = JSON.parse(db.getParserStatesForPaths([fp]).get(fp)!.parserState!);
    expect(state.offset).toBe(fs.statSync(fp).size);
    expect(state.jsonlDroppingOversizedLine).toBeUndefined();
  });

  it('UPGRADE: a pre-tool-call continuation forces one full parse without overwriting ordinal zero', async () => {
    const id = 'legacy-continuation-tool-calls';
    const fp = writeRollout(id, [
      ...baseEvents(id),
      { type: 'response_item', timestamp: '2026-06-28T06:01:00.000Z', payload: {
        type: 'function_call', name: 'exec_command', call_id: 'legacy-call', arguments: JSON.stringify({ cmd: 'git status' }),
      } },
    ]);
    await runScan();

    const legacyState = JSON.parse(db.getParserStatesForPaths([fp]).get(fp)!.parserState!);
    legacyState.v = 1;
    delete legacyState.toolCalls;
    db.getDB().prepare('UPDATE scan_ledger SET parser_state = ? WHERE file_path = ?')
      .run(JSON.stringify(legacyState), fs.realpathSync(fp));

    discover.__resetCodexScanBranchCountsForTest();
    appendRollout(id, [
      { type: 'response_item', timestamp: '2026-06-28T06:02:00.000Z', payload: {
        type: 'function_call', name: 'exec_command', call_id: 'new-call', arguments: JSON.stringify({ cmd: 'gh pr view' }),
      } },
    ]);
    bumpMtimeToNow(fp, 1);
    await runScan();

    expect(discover.__codexScanBranchCountsForTest().incremental).toBe(0);
    expect(discover.__codexScanBranchCountsForTest().full).toBeGreaterThanOrEqual(1);
    expect(db.getDB().prepare(`
      SELECT ordinal, source_call_id FROM tool_calls WHERE session_id = ? ORDER BY ordinal
    `).all(id)).toEqual([
      { ordinal: 0, source_call_id: 'legacy-call' },
      { ordinal: 1, source_call_id: 'new-call' },
    ]);
  });

  it('LEDGER: parser_state is persisted after a scan, and its offset advances on append', async () => {
    const id = 'ledger-persist';
    const fp = writeRollout(id, baseEvents(id));
    await runScan();

    const row = db.getParserStatesForPaths([fp]).get(fp);
    expect(row, 'ledger row exists').toBeDefined();
    expect(row!.parserState, 'parser_state persisted').not.toBeNull();
    const parsed = JSON.parse(row!.parserState!);
    expect(parsed.v).toBe(4); // v4: persists firstUserMessage (PHNX-3621)
    expect(typeof parsed.offset).toBe('number');
    const offsetAfterFirst = parsed.offset;

    appendRollout(id, appendedEvents());
    bumpMtimeToNow(fp, 1);
    await runScan();
    const afterAppend = JSON.parse(db.getParserStatesForPaths([fp]).get(fp)!.parserState!);
    expect(afterAppend.offset).toBeGreaterThan(offsetAfterFirst);
  });
});
