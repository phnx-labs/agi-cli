import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  scanCodexSessionIncremental,
  initCodexParseState,
  serializeCodexParserState,
  type CodexParserState,
} from '../discover.js';


let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-codex-inc-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fresh(): CodexParserState {
  return serializeCodexParserState(initCodexParseState(), 0);
}

async function fullScan(fp: string) {
  return (await scanCodexSessionIncremental(fp, 0, fresh())).scan;
}

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

async function replay(chunks: string[]) {
  const fp = path.join(dir, 'rollout.jsonl');
  expect(chunks.length).toBeGreaterThan(0);

  fs.writeFileSync(fp, chunks[0] + '\n');
  let prior: CodexParserState = fresh();
  let step = await scanCodexSessionIncremental(fp, 0, prior);
  let inc = step.scan;
  prior = step.newState;
  const offsets: number[] = [step.newOffset];

  for (let i = 1; i < chunks.length; i++) {
    fs.appendFileSync(fp, chunks[i] + '\n');
    step = await scanCodexSessionIncremental(fp, prior.offset, prior);
    inc = step.scan;
    prior = step.newState;
    offsets.push(step.newOffset);
  }

  const full = await fullScan(fp);
  return { inc, full, offsets };
}

function expectScanParity(inc: any, full: any) {
  expect(inc).toEqual(full);
  const fields = [
    'sessionId', 'timestamp', 'cwd', 'gitBranch', 'version', 'model', 'topic',
    'messageCount', 'tokenCount', 'outputTokens', 'costUsd', 'durationMs',
    'lastActivity', 'contentText', 'prUrl', 'prNumber', 'worktreeSlug',
    'ticketId', 'createdTickets', 'spawnedTeam', 'todos', 'recentDirectoriesTouched',
  ];
  for (const f of fields) {
    expect(inc[f], `field ${f}`).toEqual(full[f]);
  }
}

function richLines(): object[] {
  return [
    { type: 'session_meta', timestamp: '2026-06-28T00:00:00.000Z', payload: { id: 'sess-1', timestamp: '2026-06-28T00:00:00.000Z', cwd: '/home/u/repo', git: { branch: 'RUSH-42-fix' }, cli_version: '0.9.0', model: 'gpt-5-codex' } },
    { type: 'response_item', timestamp: '2026-06-28T00:00:30.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'investigate the flaky exec test' }] } },
    { type: 'response_item', timestamp: '2026-06-28T00:01:00.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'looking into it' }] } },
    { type: 'response_item', timestamp: '2026-06-28T00:01:01.000Z', payload: { type: 'function_call', name: 'update_plan', call_id: 'plan-1', arguments: JSON.stringify({ plan: [{ step: 'Inspect', status: 'completed' }, { step: 'Build', status: 'in_progress' }] }) } },
    { type: 'response_item', timestamp: '2026-06-28T00:01:02.000Z', payload: { type: 'function_call', name: 'exec_command', call_id: 'exec-1', arguments: JSON.stringify({ cmd: 'bun test', workdir: '/home/u/repo/tests' }) } },
    { type: 'event_msg', timestamp: '2026-06-28T00:01:05.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 5, output_tokens: 20, reasoning_output_tokens: 4 } } } },
    { type: 'response_item', timestamp: '2026-06-28T00:02:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'yes go ahead' }] } },
    { type: 'response_item', timestamp: '2026-06-28T00:03:00.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
    { type: 'event_msg', timestamp: '2026-06-28T00:03:05.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 300, cached_input_tokens: 12, output_tokens: 60, reasoning_output_tokens: 8 } } } },
  ];
}

describe('codex incremental parity — boundary sweep', () => {
  it('replaying across a split at EVERY line index equals a full parse', async () => {
    const lines = richLines();
    const serialized = lines.map((l) => JSON.stringify(l));
    for (let k = 1; k < serialized.length; k++) {
      const chunkA = serialized.slice(0, k).join('\n');
      const chunkB = serialized.slice(k).join('\n');
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

describe('codex incremental parity — last-wins token usage across a boundary', () => {
  it('a later cumulative token_count snapshot in the tail wins (not summed)', async () => {
    const chunkA = jsonl([
      { type: 'session_meta', timestamp: '2026-06-28T00:00:00.000Z', payload: { id: 's', cwd: '/x', model: 'gpt-5-codex' } },
      { type: 'event_msg', timestamp: '2026-06-28T00:01:00.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 50, output_tokens: 10, reasoning_output_tokens: 2 } } } },
    ]);
    const chunkB = jsonl([
      { type: 'event_msg', timestamp: '2026-06-28T00:02:00.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, output_tokens: 100, reasoning_output_tokens: 20 } } } },
    ]);
    const { inc, full } = await replay([chunkA, chunkB]);
    expect(inc.tokenCount).toBe(620);
    expect(inc.outputTokens).toBe(120);
    expectScanParity(inc, full);
  });
});

describe('codex incremental parity — straddled two-event patterns', () => {
  it('PR create function_call in chunk 1, URL in a function_call_output in chunk 2', async () => {
    const chunkA = jsonl([
      { type: 'session_meta', timestamp: '2026-06-28T00:00:00.000Z', payload: { id: 's', cwd: '/x' } },
      { type: 'response_item', timestamp: '2026-06-28T00:01:00.000Z', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: 'gh pr create --fill' }) } },
    ]);
    const chunkB = jsonl([
      { type: 'response_item', timestamp: '2026-06-28T00:02:00.000Z', payload: { type: 'function_call_output', call_id: 'c1', output: 'https://github.com/org/repo/pull/321' } },
    ]);
    const { inc, full } = await replay([chunkA, chunkB]);
    expect(inc.prUrl).toBe('https://github.com/org/repo/pull/321');
    expect(inc.prNumber).toBe(321);
    expectScanParity(inc, full);
  });

  it('create_issue function_call in chunk 1, result ref in chunk 2 → createdTickets parity', async () => {
    const chunkA = jsonl([
      { type: 'session_meta', timestamp: '2026-06-28T00:00:00.000Z', payload: { id: 's', cwd: '/x' } },
      { type: 'response_item', timestamp: '2026-06-28T00:01:00.000Z', payload: { type: 'function_call', name: 'shell', call_id: 'tt1', arguments: JSON.stringify({ command: 'gh issue create --title bug' }) } },
    ]);
    const chunkB = jsonl([
      { type: 'response_item', timestamp: '2026-06-28T00:02:00.000Z', payload: { type: 'function_call_output', call_id: 'tt1', output: 'https://github.com/org/repo/issues/88' } },
    ]);
    const { inc, full } = await replay([chunkA, chunkB]);
    expect(inc.createdTickets).toEqual(['#88']);
    expectScanParity(inc, full);
  });

  it('spawnedTeam from a teams-create command straddling the boundary', async () => {
    const chunkA = jsonl([
      { type: 'session_meta', timestamp: '2026-06-28T00:00:00.000Z', payload: { id: 's', cwd: '/x' } },
    ]);
    const chunkB = jsonl([
      { type: 'response_item', timestamp: '2026-06-28T00:01:00.000Z', payload: { type: 'function_call', name: 'shell', call_id: 'c9', arguments: JSON.stringify({ command: 'agents teams create my-feature --enable-worktrees' }) } },
    ]);
    const { inc, full } = await replay([chunkA, chunkB]);
    expect(inc.spawnedTeam).toBe('my-feature');
    expectScanParity(inc, full);
  });
});

describe('codex incremental parity — turn_context metadata fallback', () => {
  it('extracts model from turn_context when session_meta omits it', async () => {
    const chunkA = jsonl([
      { type: 'session_meta', timestamp: '2026-06-28T00:00:00.000Z', payload: { id: 's', cwd: '/x' } },
      { type: 'response_item', timestamp: '2026-06-28T00:01:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } },
    ]);
    const chunkB = jsonl([
      { type: 'turn_context', timestamp: '2026-06-28T00:02:00.000Z', payload: { model: 'gpt-5.6-sol', cwd: '/y' } },
    ]);
    const { inc, full } = await replay([chunkA, chunkB]);
    expect(inc.model).toBe('gpt-5.6-sol');
    expect(inc.cwd).toBe('/x');
    expectScanParity(inc, full);
  });

  it('session_meta model wins over turn_context model', async () => {
    const chunkA = jsonl([
      { type: 'session_meta', timestamp: '2026-06-28T00:00:00.000Z', payload: { id: 's', cwd: '/x', model: 'gpt-5-codex' } },
    ]);
    const chunkB = jsonl([
      { type: 'turn_context', timestamp: '2026-06-28T00:01:00.000Z', payload: { model: 'gpt-5.6-sol' } },
    ]);
    const { inc, full } = await replay([chunkA, chunkB]);
    expect(inc.model).toBe('gpt-5-codex');
    expectScanParity(inc, full);
  });

  it('falls back cwd from turn_context when session_meta omits it', async () => {
    const chunkA = jsonl([
      { type: 'session_meta', timestamp: '2026-06-28T00:00:00.000Z', payload: { id: 's' } },
      { type: 'response_item', timestamp: '2026-06-28T00:01:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } },
    ]);
    const chunkB = jsonl([
      { type: 'turn_context', timestamp: '2026-06-28T00:02:00.000Z', payload: { model: 'gpt-5.6-sol', cwd: '/from-turn' } },
    ]);
    const { inc, full } = await replay([chunkA, chunkB]);
    expect(inc.cwd).toBe('/from-turn');
    expect(inc.model).toBe('gpt-5.6-sol');
    expectScanParity(inc, full);
  });
});

describe('codex incremental parity — truncation → full reparse', () => {
  it('when the file shrinks below the stored offset, a full parse from offset 0 matches a from-scratch parse', async () => {
    const fp = path.join(dir, 'trunc.jsonl');
    const original = jsonl([
      { type: 'session_meta', timestamp: '2026-06-28T00:00:00.000Z', payload: { id: 's1', cwd: '/x', model: 'gpt-5-codex' } },
      { type: 'response_item', timestamp: '2026-06-28T00:01:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'long original prompt one' }] } },
      { type: 'event_msg', timestamp: '2026-06-28T00:01:05.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 90, output_tokens: 30 } } } },
    ]) + '\n';
    fs.writeFileSync(fp, original);
    const first = await scanCodexSessionIncremental(fp, 0, fresh());
    expect(first.newOffset).toBe(Buffer.byteLength(original, 'utf-8'));

    const rewritten = jsonl([
      { type: 'session_meta', timestamp: '2026-06-29T00:00:00.000Z', payload: { id: 's2', cwd: '/y' } },
      { type: 'response_item', timestamp: '2026-06-29T00:00:30.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'brand new short session' }] } },
    ]) + '\n';
    fs.writeFileSync(fp, rewritten);
    const newSize = Buffer.byteLength(rewritten, 'utf-8');
    expect(newSize).toBeLessThan(first.newOffset);

    const reparse = newSize < first.newOffset
      ? await scanCodexSessionIncremental(fp, 0, fresh())
      : await scanCodexSessionIncremental(fp, first.newOffset, first.newState);

    const full = await fullScan(fp);
    expectScanParity(reparse.scan, full);
    expect(reparse.scan.topic).toBe('brand new short session');
    expect(reparse.scan.sessionId).toBe('s2');
  });
});

describe('codex incremental parity — partial trailing line', () => {
  it('a chunk ending mid-JSON (no trailing newline) is re-consumed on the next append', async () => {
    const fp = path.join(dir, 'partial.jsonl');
    const l1 = JSON.stringify({ type: 'session_meta', timestamp: '2026-06-28T00:00:00.000Z', payload: { id: 's', cwd: '/x' } });
    fs.writeFileSync(fp, l1 + '\n');
    const step1 = await scanCodexSessionIncremental(fp, 0, fresh());
    expect(step1.newOffset).toBe(Buffer.byteLength(l1 + '\n', 'utf-8'));

    const l2full = JSON.stringify({ type: 'response_item', timestamp: '2026-06-28T00:01:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a user message' }] } });
    const l2partial = l2full.slice(0, Math.floor(l2full.length / 2));
    fs.appendFileSync(fp, l2partial);
    const step2 = await scanCodexSessionIncremental(fp, step1.newOffset, step1.newState);
    expect(step2.newOffset).toBe(step1.newOffset);
    expect(step2.scan.messageCount).toBe(0);

    fs.appendFileSync(fp, l2full.slice(l2partial.length) + '\n');
    const step3 = await scanCodexSessionIncremental(fp, step2.newOffset, step2.newState);
    expect(step3.newOffset).toBe(Buffer.byteLength(fs.readFileSync(fp)));

    const full = await fullScan(fp);
    expectScanParity(step3.scan, full);
    expect(step3.scan.messageCount).toBe(1);
  });

  it('a COMPLETE record missing only its trailing newline is deferred, then counted EXACTLY once', async () => {
    const fp = path.join(dir, 'complete-unterminated.jsonl');
    const l1 = JSON.stringify({ type: 'response_item', timestamp: '2026-06-28T00:00:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first message' }] } });
    fs.writeFileSync(fp, l1 + '\n');
    const step1 = await scanCodexSessionIncremental(fp, 0, fresh());
    expect(step1.scan.messageCount).toBe(1);
    expect(step1.scan.contentText).toBe('first message');
    expect(step1.newOffset).toBe(Buffer.byteLength(l1 + '\n', 'utf-8'));

    const l2 = JSON.stringify({ type: 'response_item', timestamp: '2026-06-28T00:01:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second message' }] } });
    fs.appendFileSync(fp, l2);
    const step2 = await scanCodexSessionIncremental(fp, step1.newOffset, step1.newState);
    expect(step2.newOffset).toBe(step1.newOffset);
    expect(step2.scan.messageCount).toBe(1);
    expect(step2.scan.contentText).toBe('first message');

    fs.appendFileSync(fp, '\n');
    const step3 = await scanCodexSessionIncremental(fp, step2.newOffset, step2.newState);
    expect(step3.scan.messageCount).toBe(2);
    expect(step3.scan.contentText).toBe('first message\nsecond message');
    expect(step3.newOffset).toBe(Buffer.byteLength(fs.readFileSync(fp)));

    const full = await fullScan(fp);
    expectScanParity(step3.scan, full);
  });
});
