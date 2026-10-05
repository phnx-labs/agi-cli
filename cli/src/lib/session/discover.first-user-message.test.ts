import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  scanClaudeSession,
  initClaudeParseState,
  applyClaudeLine,
  finalizeClaudeScan,
  serializeClaudeParserState,
  hydrateClaudeParseState,
  scanCodexSessionResumable,
  parseKimiWireMetricsIncremental,
  readGrokMeta,
} from './discover.js';

/** PHNX-3621 leftover from competing #3359: per-harness scanner coverage for
 * `SessionMeta.firstUserMessage` that #3358 did not absorb. Hits the real scan path (Claude
 * incremental parse-state resume, Codex rollout, Kimi wire first-wins, Grok bounded prefix read). */

let TMP: string;
beforeAll(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-fum-')); });
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });

function write(rel: string, lines: object[]): string {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

const FULL_FIRST = 'Implement PHNX-3621.\n\nAdd the full first-user-turn field. Verbatim, multi-line.';

describe('Claude scanner captures firstUserMessage (parse-state)', () => {
  it('captures the full first genuine user turn, skipping a synthetic first message', async () => {
    const file = write('claude/session.jsonl', [
      // A synthetic first user message (a slash-command wrapper turn) is skipped
      // by BOTH the topic extractor and the firstUserMessage genuine-turn filter.
      { type: 'user', timestamp: '2026-08-31T00:00:00Z', message: { content: '<command-name>/continue</command-name>' } },
      { type: 'user', timestamp: '2026-08-31T00:00:01Z', message: { content: [{ type: 'text', text: FULL_FIRST }] } },
      { type: 'assistant', timestamp: '2026-08-31T00:00:02Z', message: { id: 'a1', content: [{ type: 'text', text: 'on it' }] } },
    ]);
    const scan = await scanClaudeSession(file);
    expect(scan.firstUserMessage).toBe(FULL_FIRST);
    // Distinct from the one-line topic distilled from the same turn.
    expect(scan.topic).toBe('Implement PHNX-3621.');
  });

  it('survives an incremental resume — serialize + hydrate keep the first-wins turn', () => {
    const state = initClaudeParseState();
    applyClaudeLine(state, { type: 'user', timestamp: '2026-08-31T00:00:00Z', message: { content: [{ type: 'text', text: FULL_FIRST }] } });
    // Persist a continuation (the userTexts array collapses to a joined blob on
    // hydrate, so firstUserMessage MUST ride the serialized state to survive).
    const blob = serializeClaudeParserState(state, 100);
    expect(blob.firstUserMessage).toBe(FULL_FIRST);
    const resumed = hydrateClaudeParseState(blob);
    // A later appended user turn must NOT overwrite the first one.
    applyClaudeLine(resumed, { type: 'user', timestamp: '2026-08-31T00:05:00Z', message: { content: [{ type: 'text', text: 'a much later turn' }] } });
    expect(finalizeClaudeScan(resumed).firstUserMessage).toBe(FULL_FIRST);
  });
});

describe('Codex scanner captures firstUserMessage (rollout parse-state)', () => {
  it('captures the full first user turn from a rollout', async () => {
    const file = write('codex/rollout.jsonl', [
      { type: 'session_meta', payload: { id: 'codex-1', timestamp: '2026-08-31T00:00:00Z', cwd: '/repo' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: FULL_FIRST }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
    ]);
    const size = fs.statSync(file).size;
    const { scan } = await scanCodexSessionResumable(file, null, fs.statSync(file).mtimeMs, size);
    expect(scan.firstUserMessage).toBe(FULL_FIRST);
    expect(scan.topic).toBe('Implement PHNX-3621.');
  });
});

describe('Kimi scanner captures firstUserMessage (wire stream, first-wins across resume)', () => {
  it('captures it from wire.jsonl and preserves it on an incremental resume', () => {
    const dir = path.join(TMP, 'kimi', 'session_abc');
    fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
    const wire = path.join(dir, 'agents', 'main', 'wire.jsonl');
    fs.writeFileSync(wire, JSON.stringify({ type: 'context.append_message', message: { role: 'user', content: FULL_FIRST } }) + '\n');

    const first = parseKimiWireMetricsIncremental(dir, null);
    expect(first.newState.firstUserMessage).toBe(FULL_FIRST);

    // Append a later user turn and resume from the persisted offset — the first
    // turn is in the already-consumed prefix, so it must ride the continuation.
    fs.appendFileSync(wire, JSON.stringify({ type: 'context.append_message', message: { role: 'user', content: 'a later turn' } }) + '\n');
    const resumed = parseKimiWireMetricsIncremental(dir, first.newState);
    expect(resumed.newState.firstUserMessage).toBe(FULL_FIRST);
    expect(resumed.messageCount).toBe(2);
  });
});

function writeGrokSession(id: string, history: object[]): string {
  const dir = path.join(TMP, 'grok', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    info: { id, cwd: '/repo' },
    created_at: '2026-08-31T00:00:00Z',
    generated_title: 'PHNX-3621 work',
  }));
  fs.writeFileSync(path.join(dir, 'chat_history.jsonl'),
    history.map(l => JSON.stringify(l)).join('\n') + '\n');
  return dir;
}

describe('Grok scanner captures firstUserMessage (bounded chat_history read)', () => {
  it('recovers the first user turn from chat_history.jsonl without the full-file parse', () => {
    const dir = writeGrokSession('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', [
      { type: 'user', content: [{ type: 'text', text: FULL_FIRST }] },
      { type: 'assistant', content: 'ack' },
    ]);

    const result = readGrokMeta(path.join(dir, 'summary.json'));
    expect(result?.meta.firstUserMessage).toBe(FULL_FIRST);
    // topic still comes from the summary's generated_title, unchanged.
    expect(result?.meta.topic).toBe('PHNX-3621 work');
  });

  it('skips production Grok scaffolding and returns the prompt_index <user_query> turn', () => {
    // Real chat_history.jsonl shape (23/44 sessions on one box): a system line, a huge
    // <user_info>+<rules> user dump (no synthetic_reason), a system-reminder user with
    // synthetic_reason, then the genuine request at prompt_index 0 wrapped in <user_query>.
    const genuine = '## Mission\nIndependently design the product-facing compute tier model.';
    const userInfoDump = '<user_info>\nOS Version: linux\nWorkspace Path: /repo\n<rules>never store this dump as the first user turn</rules>\n</user_info>';
    const dir = writeGrokSession('bbbbbbbb-cccc-dddd-eeee-ffffffffffff', [
      { type: 'system', content: 'You are Grok. System prompt.' },
      { type: 'user', content: [{ type: 'text', text: userInfoDump }] },
      {
        type: 'user',
        synthetic_reason: 'system_reminder',
        content: [{ type: 'text', text: '<system-reminder>\nThe following skills are available for use.\n</system-reminder>' }],
      },
      {
        type: 'user',
        prompt_index: 0,
        content: [{ type: 'text', text: `<user_query>\n${genuine}\n</user_query>` }],
      },
      { type: 'assistant', content: 'ack' },
    ]);

    const result = readGrokMeta(path.join(dir, 'summary.json'));
    expect(result?.meta.firstUserMessage).toBe(genuine);
    expect(result?.meta.firstUserMessage).not.toMatch(/<user_info>/i);
    expect(result?.meta.firstUserMessage).not.toMatch(/OS Version/);
    expect(result?.meta.firstUserMessage).not.toMatch(/never store this dump/);
    expect(result?.meta.firstUserMessage).not.toMatch(/<user_query>/i);
  });
});
