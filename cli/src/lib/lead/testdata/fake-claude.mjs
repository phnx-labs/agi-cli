import * as fs from 'node:fs';
import * as net from 'node:net';
import * as readline from 'node:readline';

const argv = process.argv.slice(2);
const log = process.env.FAKE_LEAD_LOG;
const record = (obj) => { if (log) fs.appendFileSync(log, `${JSON.stringify(obj)}\n`); };
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const resume = flag('--resume');
const sessionId = resume ?? flag('--session-id') ?? 'no-session';
record({ argv, cwd: process.cwd(), envKeys: Object.keys(process.env).sort() });
if (resume && process.env.FAKE_LEAD_RESUME_ERROR) {
  process.stderr.write(`${process.env.FAKE_LEAD_RESUME_ERROR}\n`);
  process.exit(1);
}

const out = (obj) => process.stdout.write(`${JSON.stringify({ ...obj, session_id: sessionId })}\n`);
const result = (text, tokens = 50_000) => out({
  type: 'result', subtype: 'success', is_error: false, result: text,
  usage: { input_tokens: 1, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, output_tokens: 10,
    iterations: [{ input_tokens: 1, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, output_tokens: 10 }] },
  modelUsage: { 'claude-sonnet-test': { contextWindow: 1_000_000 } },
});
const streamText = (text) => {
  out({ type: 'stream_event', event: { type: 'message_start' } });
  for (const piece of text.match(/.{1,12}/g)) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } });
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
};
const hostCall = (req) => new Promise((resolve, reject) => {
  const socket = net.connect(process.env.FAKE_LEAD_SOCKET);
  let buf = '';
  socket.on('data', (d) => { buf += d; });
  socket.on('end', () => resolve(JSON.parse(buf.trim().split('\n')[0])));
  socket.on('error', reject);
  socket.write(`${JSON.stringify(req)}\n`);
});
const toolCall = async (id, command, run) => {
  out({ type: 'stream_event', event: { type: 'message_start' } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const reply = await run();
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: reply }] } });
};

let turns = 0;
let inited = false;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const content = JSON.parse(line).message.content;
  record({ input: content });
  turns++;
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', model: 'claude-sonnet-test', tools: ['Bash'] }); }
  if (content.includes('CRASH')) process.exit(3);
  if (content.includes('context is about to be rotated')) { streamText('- remembered: PHNX-1 goes to Claude'); result('- remembered: PHNX-1 goes to Claude'); return; }
  const stop = /STOP (\S+)/.exec(content);
  if (stop) {
    await toolCall('toolu_stop', `agents lead tool stop --session ${stop[1]}`, async () => (await hostCall({ op: 'hold-stop', session: stop[1] })).label);
    streamText('Stopping it needs your Confirm.');
    result('Stopping it needs your Confirm.');
    return;
  }
  if (content.includes('ROSTER')) {
    await toolCall('toolu_roster', 'agents lead tool roster', async () => (await hostCall({ op: 'roster' })).text);
    streamText('One session is running.');
    result('One session is running.');
    return;
  }
  const text = `Turn ${turns}. See PHNX-4365, GPT-4 and #3607 (not #12) for “Fix the flaky login test”.`;
  streamText(text);
  result(text, content.includes('BIG') ? 700_000 : 50_000);
});
rl.on('close', () => process.exit(0));
