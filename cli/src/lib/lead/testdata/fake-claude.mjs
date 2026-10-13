import * as fs from 'node:fs';
import * as readline from 'node:readline';

const argv = process.argv.slice(2);
const log = process.env.FAKE_LEAD_LOG;
const record = (obj) => { if (log) fs.appendFileSync(log, `${JSON.stringify(obj)}\n`); };
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const resume = flag('--resume');
const sessionId = resume ?? flag('--session-id') ?? 'no-session';
record({ argv });
if (resume && process.env.FAKE_LEAD_FAIL_RESUME === '1') {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  process.exit(1);
}

const out = (obj) => process.stdout.write(`${JSON.stringify({ ...obj, session_id: sessionId })}\n`);
const window = 1_000_000;
const result = (text, tokens = 50_000) => out({
  type: 'result', subtype: 'success', is_error: false, result: text,
  usage: { input_tokens: 1, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, output_tokens: 10,
    iterations: [{ input_tokens: 1, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, output_tokens: 10 }] },
  modelUsage: { 'claude-sonnet-test': { contextWindow: window } },
});
const streamText = (text) => {
  out({ type: 'stream_event', event: { type: 'message_start' } });
  for (const piece of text.match(/.{1,12}/g)) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } });
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let turns = 0;
let inited = false;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const msg = JSON.parse(line);
  const content = msg.message.content;
  record({ input: content });
  turns++;
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', model: 'claude-sonnet-test', tools: ['Bash'] }); }
  if (content.includes('CRASH')) process.exit(3);
  if (content.includes('context is about to be rotated')) { streamText('- remembered: PHNX-1 goes to Claude'); result('- remembered: PHNX-1 goes to Claude'); return; }
  const stop = /STOP (\S+)/.exec(content);
  if (stop) {
    out({ type: 'stream_event', event: { type: 'message_start' } });
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_stop', name: 'Bash', input: { command: `agents ps stop ${stop[1]}` } }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_stop', is_error: true, content: 'Permission denied' }] } });
    streamText('Stopping it needs your Confirm.');
    result('Stopping it needs your Confirm.');
    return;
  }
  if (content.includes('TOOL')) {
    out({ type: 'stream_event', event: { type: 'message_start' } });
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_ps', name: 'Bash', input: { command: 'agents ps --json --local', description: 'list' } }] } });
    await sleep(50);
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_ps', is_error: false, content: '[]' }] } });
    streamText('Nothing is running.');
    result('Nothing is running.');
    return;
  }
  const text = `Turn ${turns}. See PHNX-4365 and #3607 for “Fix the flaky login test”.`;
  streamText(text);
  result(text, content.includes('BIG') ? 700_000 : 50_000);
});
rl.on('close', () => process.exit(0));
