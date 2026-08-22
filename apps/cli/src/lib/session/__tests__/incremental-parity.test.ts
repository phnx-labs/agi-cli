import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  scanClaudeSession,
  scanClaudeSessionIncremental,
  initClaudeParseState,
  serializeClaudeParserState,
  type ClaudeParserState,
} from '../discover.js';

// Differential parity harness (B-1). Proves that resuming a Claude parse from a
// persisted continuation and folding in appended lines is BYTE-FOR-BYTE
// identical to a full parse of the whole file, for EVERY field of
// ClaudeSessionScan. Real temp files, real fs, real sqlite-free path — no mocks.
//
// The invariant: full(all lines) === hydrate(state@k) + apply(k+1..n), because
// applyClaudeLine is the single shared fold. Equality holds iff serialize /
// hydrate round-trips the accumulator faithfully.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-inc-parity-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Serialize an array of JSON objects into JSONL lines (no trailing newline). */
function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

/**
 * Write the first chunk, full-scan it to establish an offset + continuation,
 * then for each subsequent chunk APPEND it to the same file and resume with
 * scanClaudeSessionIncremental from the persisted offset. Return both the final
 * incremental scan and the ground-truth full scan of the final file, so callers
 * can assert deep equality (and per-field equality).
 *
 * `chunks[i]` is a complete-lines string (its own trailing '\n' is added here);
 * the raw-partial test appends bytes directly and does not use this helper.
 */
async function replay(
  chunks: string[],
): Promise<{ inc: Awaited<ReturnType<typeof scanClaudeSession>>; full: Awaited<ReturnType<typeof scanClaudeSession>>; offsets: number[] }> {
  const fp = path.join(dir, 'session.jsonl');
  expect(chunks.length).toBeGreaterThan(0);

  // Seed the file with chunk 0, then bootstrap a continuation from a full parse.
  fs.writeFileSync(fp, chunks[0] + '\n');
  // Bootstrap offset: the whole seed file is committed lines, so the initial
  // resume offset is the file size (ends on a '\n'). Bootstrap the continuation
  // by running the incremental fn once from offset 0 over an empty prior.
  let prior: ClaudeParserState = serializeClaudeParserState(initClaudeParseState(), 0);
  let step = await scanClaudeSessionIncremental(fp, 0, prior);
  let inc = step.scan;
  prior = step.newState;
  const offsets: number[] = [step.newOffset];

  for (let i = 1; i < chunks.length; i++) {
    fs.appendFileSync(fp, chunks[i] + '\n');
    step = await scanClaudeSessionIncremental(fp, prior.offset, prior);
    inc = step.scan;
    prior = step.newState;
    offsets.push(step.newOffset);
  }

  const full = await scanClaudeSession(fp);
  return { inc, full, offsets };
}

/** Assert two ClaudeSessionScan objects are equal on every field. */
function expectScanParity(inc: any, full: any) {
  expect(inc).toEqual(full);
  // Belt-and-suspenders: name each field so a failure points at the culprit.
  const fields = [
    'timestamp', 'cwd', 'gitBranch', 'version', 'topic', 'label', 'entrypoint',
    'messageCount', 'tokenCount', 'outputTokens', 'costUsd', 'durationMs',
    'lastActivity', 'contentText', 'prUrl', 'prNumber', 'worktreeSlug',
    'ticketId', 'createdTickets', 'spawnedTeam', 'plan', 'todos', 'recentDirectoriesTouched',
  ];
  for (const f of fields) {
    expect(inc[f], `field ${f}`).toEqual(full[f]);
  }
}

// A representative, field-rich transcript. Two user turns, several assistant
// events (some sharing a timestamp, some with usage/cost), a title, a plan.
function richLines(): object[] {
  return [
    { type: 'user', timestamp: '2026-06-28T00:00:00.000Z', cwd: '/home/u/repo', gitBranch: 'RUSH-42-fix', version: '2.1.0', entrypoint: 'cli', message: { role: 'user', content: 'investigate the flaky exec test' } },
    { type: 'assistant', timestamp: '2026-06-28T00:01:00.000Z', uuid: 'a-1', message: { id: 'msg_1', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'looking' }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 } } },
    { type: 'assistant', timestamp: '2026-06-28T00:02:00.000Z', uuid: 'a-2', message: { id: 'msg_2', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'plan-1', name: 'ExitPlanMode', input: { plan: '# Plan\n- step one' } }], usage: { input_tokens: 50, output_tokens: 10 } } },
    { type: 'assistant', timestamp: '2026-06-28T00:02:10.000Z', uuid: 'task-1', message: { id: 'task-msg-1', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'tc-1', name: 'TaskCreate', input: { subject: 'Inspect', activeForm: 'Inspecting' } }, { type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: '/home/u/repo/src/config.ts' } }], usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'assistant', timestamp: '2026-06-28T00:02:20.000Z', uuid: 'task-2', message: { id: 'task-msg-2', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'tu-1', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }], usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'user', timestamp: '2026-06-28T00:03:00.000Z', message: { role: 'user', content: 'yes go ahead' } },
    { type: 'ai-title', aiTitle: 'Flaky exec test fix', sessionId: 's' },
    { type: 'assistant', timestamp: '2026-06-28T00:04:00.000Z', uuid: 'a-3', message: { id: 'msg_3', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 30, output_tokens: 40 } } },
  ];
}

describe('incremental parity — boundary sweep', () => {
  it('replaying across a split at EVERY line index equals a full parse', async () => {
    const lines = richLines();
    const fullSerialized = lines.map((l) => JSON.stringify(l));
    // Split after each line index 1..n-1 (a two-chunk replay per boundary).
    for (let k = 1; k < fullSerialized.length; k++) {
      const chunkA = fullSerialized.slice(0, k).join('\n');
      const chunkB = fullSerialized.slice(k).join('\n');
      const { inc, full } = await replay([chunkA, chunkB]);
      expectScanParity(inc, full);
    }
  });

  it('replaying line-by-line (n chunks) equals a full parse', async () => {
    const chunks = richLines().map((l) => JSON.stringify(l));
    const { inc, full } = await replay(chunks);
    expectScanParity(inc, full);
  });
});

describe('incremental parity — fallback-id stress', () => {
  it('assistant events sharing a timestamp with NO message.id/uuid keep messageCount/tokenCount parity across a boundary', async () => {
    // Same timestamp, no id/uuid → logical id falls back to `${ts}:${size}`. If
    // the hydrated set size is wrong, the dedup and thus messageCount diverges.
    const ts = '2026-06-28T09:00:00.000Z';
    const lines: object[] = [
      { type: 'user', timestamp: '2026-06-28T08:59:00.000Z', cwd: '/x', message: { role: 'user', content: 'start' } },
    ];
    for (let i = 0; i < 12; i++) {
      lines.push({ type: 'assistant', timestamp: ts, message: { model: 'claude-sonnet-4-5', content: [{ type: 'text', text: `t${i}` }], usage: { input_tokens: 10, output_tokens: 2 } } });
    }
    const serialized = lines.map((l) => JSON.stringify(l));
    for (let k = 1; k < serialized.length; k++) {
      const { inc, full } = await replay([serialized.slice(0, k).join('\n'), serialized.slice(k).join('\n')]);
      expect(inc.messageCount, `split@${k} messageCount`).toBe(full.messageCount);
      expect(inc.tokenCount, `split@${k} tokenCount`).toBe(full.tokenCount);
      expect(inc.outputTokens, `split@${k} outputTokens`).toBe(full.outputTokens);
      expectScanParity(inc, full);
    }
  });

  it('keeps size parity even when the recent-id window is smaller than the true count', async () => {
    // > SEEN_IDS_RECENT_CAP (256) distinct assistant ids forces the FIFO window
    // to drop older ids; the persisted seenIdsSize must still make the fallback
    // `${ts}:${size}` line up after the boundary.
    const lines: object[] = [
      { type: 'user', timestamp: '2026-06-28T08:00:00.000Z', cwd: '/x', message: { role: 'user', content: 'go' } },
    ];
    for (let i = 0; i < 300; i++) {
      lines.push({ type: 'assistant', timestamp: '2026-06-28T09:00:00.000Z', message: { model: 'claude-sonnet-4-5', content: [{ type: 'text', text: `x${i}` }], usage: { input_tokens: 1, output_tokens: 1 } } });
    }
    // Split AFTER the window would have overflowed, then append more fallback-id events.
    const serialized = lines.map((l) => JSON.stringify(l));
    const k = 280;
    const { inc, full } = await replay([serialized.slice(0, k).join('\n'), serialized.slice(k).join('\n')]);
    expect(inc.messageCount).toBe(full.messageCount);
    expectScanParity(inc, full);
  });
});

describe('incremental parity — straddled two-event patterns', () => {
  it('PR create tool_use in chunk 1, tool_result URL in chunk 2 → prUrl/prNumber parity', async () => {
    const chunkA = jsonl([
      { type: 'user', timestamp: '2026-06-28T00:00:00.000Z', cwd: '/x', message: { role: 'user', content: 'ship it' } },
      { type: 'assistant', timestamp: '2026-06-28T00:01:00.000Z', message: { id: 'm1', content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'gh pr create --fill' } }] } },
    ]);
    const chunkB = jsonl([
      { type: 'user', timestamp: '2026-06-28T00:02:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: 'https://github.com/org/repo/pull/123' }] } },
    ]);
    const { inc, full } = await replay([chunkA, chunkB]);
    expect(inc.prUrl).toBe('https://github.com/org/repo/pull/123');
    expect(inc.prNumber).toBe(123);
    expectScanParity(inc, full);
  });

  it('create_issue tool_use in chunk 1, result ref in chunk 2 → createdTickets parity', async () => {
    const chunkA = jsonl([
      { type: 'user', timestamp: '2026-06-28T00:00:00.000Z', cwd: '/x', message: { role: 'user', content: 'open a ticket' } },
      { type: 'assistant', timestamp: '2026-06-28T00:01:00.000Z', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tt-1', name: 'mcp__linear__create_issue', input: {} }] } },
    ]);
    const chunkB = jsonl([
      { type: 'user', timestamp: '2026-06-28T00:02:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tt-1', content: 'Created RUSH-9001' }] } },
    ]);
    const { inc, full } = await replay([chunkA, chunkB]);
    expect(inc.createdTickets).toEqual(['RUSH-9001']);
    expectScanParity(inc, full);
  });

  it('spawnedTeam from a teams-create command straddling the boundary', async () => {
    const chunkA = jsonl([
      { type: 'user', timestamp: '2026-06-28T00:00:00.000Z', cwd: '/x', message: { role: 'user', content: 'spin up a team' } },
    ]);
    const chunkB = jsonl([
      { type: 'assistant', timestamp: '2026-06-28T00:01:00.000Z', message: { id: 'm1', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'agents teams create my-feature --enable-worktrees' } }] } },
    ]);
    const { inc, full } = await replay([chunkA, chunkB]);
    expect(inc.spawnedTeam).toBe('my-feature');
    expectScanParity(inc, full);
  });
});

describe('incremental parity — title/plan after boundary', () => {
  it('custom-title / ai-title / ExitPlanMode in the tail update label + plan', async () => {
    const chunkA = jsonl([
      { type: 'user', timestamp: '2026-06-28T00:00:00.000Z', cwd: '/x', message: { role: 'user', content: 'first prompt topic' } },
    ]);
    const chunkB = jsonl([
      { type: 'assistant', timestamp: '2026-06-28T00:01:00.000Z', message: { id: 'm1', content: [{ type: 'tool_use', id: 'p1', name: 'ExitPlanMode', input: { plan: '# Tail plan' } }] } },
      { type: 'custom-title', customTitle: 'renamed-in-tail', sessionId: 's' },
    ]);
    const { inc, full } = await replay([chunkA, chunkB]);
    expect(inc.topic).toBe('first prompt topic');
    expect(inc.label).toBe('renamed-in-tail');
    expect(inc.plan).toBe('# Tail plan');
    expectScanParity(inc, full);
  });

  it('a title-less tail does NOT null a title established before the boundary', async () => {
    const chunkA = jsonl([
      { type: 'user', timestamp: '2026-06-28T00:00:00.000Z', cwd: '/x', message: { role: 'user', content: 'start' } },
      { type: 'custom-title', customTitle: 'set-early', sessionId: 's' },
    ]);
    const chunkB = jsonl([
      { type: 'assistant', timestamp: '2026-06-28T00:01:00.000Z', message: { id: 'm1', content: [{ type: 'text', text: 'more work, no new title' }] } },
      { type: 'user', timestamp: '2026-06-28T00:02:00.000Z', message: { role: 'user', content: 'keep going' } },
    ]);
    const { inc, full } = await replay([chunkA, chunkB]);
    expect(inc.topic).toBe('start');
    expect(full.topic).toBe('start');
    expect(inc.label).toBe('set-early');
    expect(full.label).toBe('set-early');
    expectScanParity(inc, full);
  });
});

describe('incremental parity — content_text', () => {
  it('rebuilt content_text equals the full parse userTexts.join', async () => {
    const lines = richLines();
    const serialized = lines.map((l) => JSON.stringify(l));
    for (let k = 1; k < serialized.length; k++) {
      const { inc, full } = await replay([serialized.slice(0, k).join('\n'), serialized.slice(k).join('\n')]);
      expect(inc.contentText, `split@${k} contentText`).toBe(full.contentText);
      expectScanParity(inc, full);
    }
  });

  it('the persisted continuation content_text round-trips the joined user doc', async () => {
    const fp = path.join(dir, 'ct.jsonl');
    fs.writeFileSync(fp, jsonl([
      { type: 'user', timestamp: '2026-06-28T00:00:00.000Z', cwd: '/x', message: { role: 'user', content: 'alpha' } },
      { type: 'user', timestamp: '2026-06-28T00:01:00.000Z', message: { role: 'user', content: 'beta' } },
    ]) + '\n');
    const step = await scanClaudeSessionIncremental(fp, 0, serializeClaudeParserState(initClaudeParseState(), 0));
    expect(step.newState.contentText).toBe('alpha\nbeta');
    expect(step.scan.contentText).toBe('alpha\nbeta');
  });
});

describe('incremental parity — truncation → full reparse', () => {
  it('when the file shrinks below the stored offset, the caller falls back to a full parse from offset 0', async () => {
    const fp = path.join(dir, 'trunc.jsonl');
    const original = jsonl([
      { type: 'user', timestamp: '2026-06-28T00:00:00.000Z', cwd: '/x', message: { role: 'user', content: 'long original prompt one' } },
      { type: 'assistant', timestamp: '2026-06-28T00:01:00.000Z', message: { id: 'm1', content: [{ type: 'text', text: 'reply one' }], usage: { input_tokens: 9, output_tokens: 3 } } },
    ]) + '\n';
    fs.writeFileSync(fp, original);
    const first = await scanClaudeSessionIncremental(fp, 0, serializeClaudeParserState(initClaudeParseState(), 0));
    expect(first.newOffset).toBe(Buffer.byteLength(original, 'utf-8'));

    // Rewrite the file SMALLER (a fresh, shorter session reusing the same path).
    const rewritten = jsonl([
      { type: 'user', timestamp: '2026-06-29T00:00:00.000Z', cwd: '/y', message: { role: 'user', content: 'brand new short session' } },
    ]) + '\n';
    fs.writeFileSync(fp, rewritten);
    const newSize = Buffer.byteLength(rewritten, 'utf-8');

    // The stored offset now exceeds the file size → truncation detected. The
    // resumable contract (B-2 will wire this) is: on newSize < offset, discard
    // the continuation and full-parse from scratch.
    expect(newSize).toBeLessThan(first.newOffset);
    const reparse = newSize < first.newOffset
      ? await scanClaudeSessionIncremental(fp, 0, serializeClaudeParserState(initClaudeParseState(), 0))
      : await scanClaudeSessionIncremental(fp, first.newOffset, first.newState);

    const full = await scanClaudeSession(fp);
    expectScanParity(reparse.scan, full);
    expect(reparse.scan.topic).toBe('brand new short session');
  });
});

describe('incremental parity — partial trailing line', () => {
  it('a chunk ending mid-JSON (no trailing newline) is re-consumed on the next append', async () => {
    const fp = path.join(dir, 'partial.jsonl');
    const l1 = JSON.stringify({ type: 'user', timestamp: '2026-06-28T00:00:00.000Z', cwd: '/x', message: { role: 'user', content: 'first complete line' } });
    fs.writeFileSync(fp, l1 + '\n');
    const step1 = await scanClaudeSessionIncremental(fp, 0, serializeClaudeParserState(initClaudeParseState(), 0));
    // newOffset stops at the last '\n' — the full first line.
    expect(step1.newOffset).toBe(Buffer.byteLength(l1 + '\n', 'utf-8'));

    // Append a HALF-written second record (no trailing '\n').
    const l2full = JSON.stringify({ type: 'assistant', timestamp: '2026-06-28T00:01:00.000Z', message: { id: 'm2', content: [{ type: 'text', text: 'second reply' }], usage: { input_tokens: 7, output_tokens: 4 } } });
    const l2partial = l2full.slice(0, Math.floor(l2full.length / 2));
    fs.appendFileSync(fp, l2partial);
    const step2 = await scanClaudeSessionIncremental(fp, step1.newOffset, step1.newState);
    // No new '\n' seen → offset must NOT advance past the last committed newline.
    expect(step2.newOffset).toBe(step1.newOffset);
    // The half-line must not have been parsed (JSON.parse would have thrown and
    // been skipped anyway), so the assistant message is not yet counted.
    expect(step2.scan.messageCount).toBe(1);

    // Now complete the second record + a newline.
    fs.appendFileSync(fp, l2full.slice(l2partial.length) + '\n');
    const step3 = await scanClaudeSessionIncremental(fp, step2.newOffset, step2.newState);
    expect(step3.newOffset).toBe(Buffer.byteLength(fs.readFileSync(fp)));

    const full = await scanClaudeSession(fp);
    expectScanParity(step3.scan, full);
    expect(step3.scan.messageCount).toBe(2);
  });

  it('a COMPLETE record missing only its trailing newline is deferred, then counted EXACTLY once', async () => {
    // The non-atomic-append case prix-cloud caught: a writer appends a full,
    // valid record and only later appends its '\n'. readline emits that
    // unterminated line at EOF, so a naive pass applies it while the offset
    // stops before it → the next pass re-reads and re-applies the SAME record.
    // User events have no dedup (no seenAssistantIds), so the double-apply shows
    // up as messageCount 2→3 and contentText carrying the second message twice.
    const fp = path.join(dir, 'complete-unterminated.jsonl');
    const l1 = JSON.stringify({ type: 'user', timestamp: '2026-06-28T00:00:00.000Z', cwd: '/x', message: { role: 'user', content: 'first message' } });
    fs.writeFileSync(fp, l1 + '\n');
    const step1 = await scanClaudeSessionIncremental(fp, 0, serializeClaudeParserState(initClaudeParseState(), 0));
    expect(step1.scan.messageCount).toBe(1);
    expect(step1.scan.contentText).toBe('first message');
    expect(step1.newOffset).toBe(Buffer.byteLength(l1 + '\n', 'utf-8'));

    // Append a COMPLETE, valid second record — but WITHOUT its trailing '\n' yet.
    const l2 = JSON.stringify({ type: 'user', timestamp: '2026-06-28T00:01:00.000Z', message: { role: 'user', content: 'second message' } });
    fs.appendFileSync(fp, l2);
    const step2 = await scanClaudeSessionIncremental(fp, step1.newOffset, step1.newState);
    // Deferred: the offset does NOT advance, and line2 is NOT yet counted.
    expect(step2.newOffset).toBe(step1.newOffset);
    expect(step2.scan.messageCount).toBe(1);
    expect(step2.scan.contentText).toBe('first message');

    // Now the writer flushes the terminating '\n'.
    fs.appendFileSync(fp, '\n');
    const step3 = await scanClaudeSessionIncremental(fp, step2.newOffset, step2.newState);
    // Counted EXACTLY once — not twice.
    expect(step3.scan.messageCount).toBe(2);
    expect(step3.scan.contentText).toBe('first message\nsecond message');
    expect(step3.newOffset).toBe(Buffer.byteLength(fs.readFileSync(fp)));

    const full = await scanClaudeSession(fp);
    expectScanParity(step3.scan, full);
  });
});

describe('incremental parity — skill/slash-command usage (#12)', () => {
  // A Skill tool_use, a user-typed <command-name> wrapper, and a model-invoked
  // SlashCommand tool_use — the three sources session_resource_usage draws on.
  function skillAndCommandLines(): object[] {
    return [
      { type: 'user', timestamp: '2026-06-28T00:00:00.000Z', cwd: '/home/u/repo', message: { role: 'user', content: 'run the teams skill' } },
      { type: 'assistant', timestamp: '2026-06-28T00:00:10.000Z', uuid: 'a-1', message: { id: 'msg_1', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'sk-1', name: 'Skill', input: { skill: 'teams' } }], usage: { input_tokens: 5, output_tokens: 5 } } },
      { type: 'user', timestamp: '2026-06-28T00:00:20.000Z', message: { role: 'user', content: '<command-message>recap</command-message>\n<command-name>/recap</command-name>' } },
      { type: 'assistant', timestamp: '2026-06-28T00:00:30.000Z', uuid: 'a-2', message: { id: 'msg_2', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'sk-2', name: 'Skill', input: { skill: 'teams' } }], usage: { input_tokens: 5, output_tokens: 5 } } },
      { type: 'assistant', timestamp: '2026-06-28T00:00:40.000Z', uuid: 'a-3', message: { id: 'msg_3', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'sc-1', name: 'SlashCommand', input: { command: '/code:commit fix the bug' } }], usage: { input_tokens: 5, output_tokens: 5 } } },
    ];
  }

  it('replaying across a split at EVERY line index equals a full parse, including skillsUsed/slashCommandsUsed', async () => {
    const lines = skillAndCommandLines();
    const fullSerialized = lines.map((l) => JSON.stringify(l));
    for (let k = 1; k < fullSerialized.length; k++) {
      const chunkA = fullSerialized.slice(0, k).join('\n');
      const chunkB = fullSerialized.slice(k).join('\n');
      const { inc, full } = await replay([chunkA, chunkB]);
      expectScanParity(inc, full);
      expect(inc.skillsUsed, `split at ${k}`).toEqual(full.skillsUsed);
      expect(inc.slashCommandsUsed, `split at ${k}`).toEqual(full.slashCommandsUsed);
    }
  });

  it('a full parse tallies both skills and both slash-command sources correctly', async () => {
    const full = await scanClaudeSession(await (async () => {
      const fp = path.join(dir, 'skills-full.jsonl');
      fs.writeFileSync(fp, jsonl(skillAndCommandLines()));
      return fp;
    })());
    expect(full.skillsUsed).toEqual([{ name: 'teams', count: 2 }]);
    // Both have count 1, so tie-broken alphabetically: '/code:commit' < '/recap'.
    expect(full.slashCommandsUsed).toEqual([
      { name: '/code:commit', count: 1 },
      { name: '/recap', count: 1 },
    ]);
  });
});
