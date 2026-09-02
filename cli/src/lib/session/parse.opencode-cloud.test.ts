import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// isCloudSessionPath (cloud.ts) keys the routing off getCacheDir(); pin it to a
// temp root so a fixture written under <cache>/cloud-runs/... is recognized as a
// cloud session. Hoisted by vitest before parse.js (which imports cloud.js) loads.
const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-oc-cloud-cache-'));
vi.mock('../state.js', () => ({
  getCacheDir: () => cacheRoot,
}));

/** One normalized-JSONL line as produced by the factory's opencode capture. */
function row(o: Record<string, unknown>): string {
  return JSON.stringify(o);
}
function toolPart(o: Record<string, unknown>): string {
  return JSON.stringify(o);
}

const FIXTURE = [
  row({ role: 'user', part_type: 'text', part_data: toolPart({ text: 'hello world' }), time_created: 1000 }),
  row({ role: 'assistant', part_type: 'reasoning', part_data: toolPart({ text: 'let me think' }), time_created: 2000 }),
  // bash = the real opencode shell tool name (>=1.18.x)
  row({
    role: 'assistant',
    part_type: 'tool',
    part_data: toolPart({ type: 'tool', tool: 'bash', callID: 'call-1', state: { status: 'completed', input: { command: 'ls -la' }, output: 'a.txt\nb.txt' } }),
    time_created: 3000,
  }),
  // shell = the older name; command must still be mapped. status error → error event.
  row({
    role: 'assistant',
    part_type: 'tool',
    part_data: toolPart({ type: 'tool', tool: 'shell', callID: 'call-2', state: { status: 'error', input: { command: 'pwd' }, output: 'boom' } }),
    time_created: 4000,
  }),
  row({
    role: 'assistant',
    part_type: 'tool',
    part_data: toolPart({ type: 'tool', tool: 'read', callID: 'call-3', state: { status: 'completed', input: { filePath: '/x/y.ts' }, output: 'source' } }),
    time_created: 5000,
  }),
  row({ part_type: 'todo', todos: [{ content: 'do the thing', status: 'completed' }], time_created: 6000 }),
].join('\n') + '\n';

function writeCloudFixture(id = 'a1b2c3d4-0000-0000-0000-000000000000'): string {
  const dir = path.join(cacheRoot, 'cloud-runs', id);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'session.opencode.jsonl');
  fs.writeFileSync(p, FIXTURE);
  return p;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseOpencodeCloud — normalized JSONL from cloud capture (PHNX-3845)', () => {
  it('parses text, reasoning, tool, and todo parts', async () => {
    const { parseOpencodeCloud } = await import('./parse.js');
    const p = writeCloudFixture();
    const events = parseOpencodeCloud(p);

    const messages = events.filter(e => e.type === 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'hello world', agent: 'opencode' });

    const thinking = events.filter(e => e.type === 'thinking');
    expect(thinking[0]?.content).toBe('let me think');

    const todoWrite = events.find(e => e.type === 'tool_use' && e.tool === 'todo_write');
    expect(todoWrite?.args?.todos).toHaveLength(1);
  });

  it('maps `command` for BOTH bash and shell tool names', async () => {
    const { parseOpencodeCloud } = await import('./parse.js');
    const events = parseOpencodeCloud(writeCloudFixture());

    const bash = events.find(e => e.type === 'tool_use' && e.tool === 'bash');
    expect(bash?.command).toBe('ls -la');
    expect(bash?.callId).toBe('call-1');

    const shell = events.find(e => e.type === 'tool_use' && e.tool === 'shell');
    expect(shell?.command).toBe('pwd');
  });

  it('emits an error event for a failed tool and a tool_result for a completed one', async () => {
    const { parseOpencodeCloud } = await import('./parse.js');
    const events = parseOpencodeCloud(writeCloudFixture());

    const err = events.find(e => e.type === 'error' && e.tool === 'shell');
    expect(err?.output).toBe('boom');

    const ok = events.find(e => e.type === 'tool_result' && e.tool === 'bash');
    expect(ok?.success).toBe(true);
    expect(ok?.output).toContain('a.txt');
  });

  it('surfaces the file path for a read tool part', async () => {
    const { parseOpencodeCloud } = await import('./parse.js');
    const events = parseOpencodeCloud(writeCloudFixture());
    const read = events.find(e => e.type === 'tool_use' && e.tool === 'read');
    expect(read?.path).toBe('/x/y.ts');
  });

  it('skips malformed lines and malformed part_data without throwing', async () => {
    const { parseOpencodeCloud } = await import('./parse.js');
    const id = 'bad00000-0000-0000-0000-000000000000';
    const dir = path.join(cacheRoot, 'cloud-runs', id);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'session.opencode.jsonl');
    fs.writeFileSync(p, [
      'not json at all',
      row({ role: 'user', part_type: 'text', part_data: '{not valid json', time_created: 1 }),
      row({ role: 'user', part_type: 'text', part_data: toolPart({ text: 'survivor' }), time_created: 2 }),
    ].join('\n') + '\n');
    const events = parseOpencodeCloud(p);
    expect(events.filter(e => e.type === 'message').map(e => e.content)).toEqual(['survivor']);
  });
});

describe('parseSession routes opencode by cloud-cache vs local SQLite path', () => {
  it('routes a cloud-cache opencode file to the JSONL parser', async () => {
    const { parseSession } = await import('./parse.js');
    const p = writeCloudFixture('c0dec0de-0000-0000-0000-000000000000');
    const events = parseSession(p, 'opencode');
    // The SQLite parser would return [] on this JSONL; the cloud parser yields events.
    expect(events.some(e => e.type === 'message' && e.content === 'hello world')).toBe(true);
  });

  it('routes a non-cloud composite path to the SQLite parser (no cloud parse)', async () => {
    const { parseSession } = await import('./parse.js');
    // A bogus opencode.db composite path is NOT under the cloud cache, so it goes
    // to parseOpenCode, which returns [] for a missing/unopenable DB.
    const events = parseSession('/nonexistent/opencode.db#ses_x', 'opencode');
    expect(events).toEqual([]);
  });
});
