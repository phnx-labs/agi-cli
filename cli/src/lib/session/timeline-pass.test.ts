import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const realHome = process.env.HOME;
const realUserProfile = process.env.USERPROFILE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-timeline-pass-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const TESTDATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata');
const CLAUDE_FIXTURE = path.join(TESTDATA, 'timeline-claude.jsonl');

let db: typeof import('./db.js');
let pass: typeof import('./timeline-pass.js');
let timeline: typeof import('@phnx-labs/sessions-cli/reader');
type ActiveSession = import('./active.js').ActiveSession;

function row(sessionId: string, sessionFile: string, kind = 'claude'): ActiveSession {
  return { context: 'terminal', kind, sessionId, sessionFile, status: 'running', activity: 'working' } as ActiveSession;
}

beforeAll(async () => {
  db = await import('./db.js');
  pass = await import('./timeline-pass.js');
  timeline = await import('@phnx-labs/sessions-cli/reader');
  db.getDB();
});

afterAll(() => {
  db.closeDB();
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('runTimelinePass — the daemon\'s incremental fold', () => {
  it('folds a live transcript, caches it, and reuses the cache when nothing was appended', () => {
    const file = path.join(tmpHome, 'live-a.jsonl');
    const lines = fs.readFileSync(CLAUDE_FIXTURE, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(file, `${lines.slice(0, 200).join('\n')}\n`);

    const first = pass.runTimelinePassSync({ sessions: [row('live-a', file)] });
    expect(first).toMatchObject({ computed: 1, reused: 0, skipped: 0 });

    const stored = db.readSessionTimelineAny('live-a');
    expect(stored?.timeline.steps.length).toBeGreaterThan(0);
    expect(stored?.timeline.state).toBe('ready');
    expect(stored?.request?.headline).toBeTruthy();
    expect(stored!.timeline.steps[stored!.timeline.steps.length - 1].live).toBe(true);

    expect(pass.runTimelinePassSync({ sessions: [row('live-a', file)] })).toMatchObject({ computed: 0, reused: 1 });
  });

  it('reads only the appended bytes, and the result equals folding the whole file', () => {
    const file = path.join(tmpHome, 'live-b.jsonl');
    const lines = fs.readFileSync(CLAUDE_FIXTURE, 'utf8').split('\n').filter(Boolean);
    const head = `${lines.slice(0, 150).join('\n')}\n`;
    fs.writeFileSync(file, head);
    pass.runTimelinePassSync({ sessions: [row('live-b', file)] });
    const afterHead = db.readSessionTimelineEntry('live-b')!;
    expect(afterHead.state.offset).toBe(Buffer.byteLength(head));

    fs.appendFileSync(file, `${lines.slice(150).join('\n')}\n`);
    pass.runTimelinePassSync({ sessions: [row('live-b', file)] });
    const resumed = db.readSessionTimelineEntry('live-b')!;
    expect(resumed.state.offset).toBe(fs.statSync(file).size);

    const cold = path.join(tmpHome, 'cold-b.jsonl');
    fs.copyFileSync(file, cold);
    pass.runTimelinePassSync({ sessions: [row('cold-b', cold)] });
    const whole = db.readSessionTimelineEntry('cold-b')!;
    expect(resumed.timeline).toEqual(whole.timeline);
    expect(resumed.request).toEqual(whole.request);
    expect(resumed.files).toEqual(whole.files);
  });

  it('never folds a record that is still being written, and folds it whole once it lands', () => {
    const file = path.join(tmpHome, 'straddle.jsonl');
    const complete = JSON.stringify({
      type: 'assistant', timestamp: '2026-09-06T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'First beat of the run.' }] },
    });
    const partial = JSON.stringify({
      type: 'assistant', timestamp: '2026-09-06T00:00:10.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: `Second beat. ${'x'.repeat(200_000)}` }] },
    });
    fs.writeFileSync(file, `${complete}\n${partial.slice(0, 120_000)}`);
    pass.runTimelinePassSync({ sessions: [row('straddle', file)] });
    let stored = db.readSessionTimelineEntry('straddle')!;
    expect(stored.timeline.steps).toHaveLength(1);
    expect(stored.state.offset).toBe(Buffer.byteLength(`${complete}\n`));

    fs.writeFileSync(file, `${complete}\n${partial}\n`);
    pass.runTimelinePassSync({ sessions: [row('straddle', file)] });
    stored = db.readSessionTimelineEntry('straddle')!;
    expect(stored.timeline.steps).toHaveLength(2);
    expect(stored.timeline.steps[1].text.startsWith('Second beat.')).toBe(true);
    expect(stored.state.offset).toBe(fs.statSync(file).size);
  });

  it('stops at the per-tick BYTE budget, so a cold cache catches up over ticks', () => {
    const line = (n: number) => `${JSON.stringify({
      type: 'assistant', timestamp: '2026-09-06T00:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: `Beat ${n}. ${'x'.repeat(4000)}` }] },
    })}\n`;
    const rows = ['w1', 'w2', 'w3'].map((id) => {
      const file = path.join(tmpHome, `${id}.jsonl`);
      fs.writeFileSync(file, line(1).repeat(3));
      return row(id, file);
    });
    const size = fs.statSync(rows[0].sessionFile!).size;
    const result = pass.runTimelinePassSync({ sessions: rows, maxBytes: size + 10 });
    expect(result.computed).toBe(1);
    expect(db.readSessionTimelineAny('w2')).toBeUndefined();

    expect(pass.runTimelinePassSync({ sessions: rows }).computed).toBe(2);
    expect(db.readSessionTimelineAny('w3')).toBeDefined();
  });

  it('stops at the per-tick session budget so one tick can never own the daemon', () => {
    const files = ['b1', 'b2', 'b3'].map((id) => {
      const file = path.join(tmpHome, `${id}.jsonl`);
      fs.writeFileSync(file, `${JSON.stringify({
        type: 'assistant', timestamp: '2026-09-06T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: `Beat for ${id}.` }] },
      })}\n`);
      return row(id, file);
    });
    const result = pass.runTimelinePassSync({ sessions: files, budget: 2 });
    expect(result.computed).toBe(2);
    expect(db.readSessionTimelineAny('b3')).toBeUndefined();
  });

  it('re-parses a non-resumable harness at most once a minute, never every tick', () => {
    const dir = fs.mkdtempSync(path.join(tmpHome, 'kimi-'));
    fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
    const wire = path.join(dir, 'agents', 'main', 'wire.jsonl');
    const state = path.join(dir, 'state.json');
    const line = (text: string, at: number) => `${JSON.stringify({
      type: 'context.append_loop_event', time: at,
      event: { type: 'content.part', part: { type: 'text', text } },
    })}\n`;
    fs.writeFileSync(wire, line('First beat of the kimi run.', Date.UTC(2026, 8, 6)));
    fs.writeFileSync(state, '{}');

    const kimi = { ...row('kimi-1', state, 'kimi'), activity: 'working' } as ActiveSession;
    expect(pass.runTimelinePassSync({ sessions: [kimi], nowMs: 1_000_000 })).toMatchObject({ computed: 1 });

    fs.appendFileSync(wire, line('Second beat of the kimi run.', Date.UTC(2026, 8, 6, 0, 0, 30)));
    expect(pass.runTimelinePassSync({ sessions: [kimi], nowMs: 1_015_000 }))
      .toMatchObject({ computed: 0, reused: 1, skipped: 0 });
    expect(db.readSessionTimelineAny('kimi-1')!.timeline.steps).toHaveLength(1);

    expect(pass.runTimelinePassSync({ sessions: [kimi], nowMs: 1_000_000 + pass.TIMELINE_PASS_NON_RESUMABLE_MIN_INTERVAL_MS + 1 }))
      .toMatchObject({ computed: 1 });
    expect(db.readSessionTimelineAny('kimi-1')!.timeline.steps).toHaveLength(2);
  });

  function writeGrokSession(id: string, atLeastBytes: number): ActiveSession {
    const dir = fs.mkdtempSync(path.join(tmpHome, `grok-${id}-`));
    const history = path.join(dir, 'chat_history.jsonl');
    const summary = path.join(dir, 'summary.json');
    const filler = 'x'.repeat(8000);
    const out: string[] = [JSON.stringify({ type: 'system', content: 'You are Grok.' })];
    let bytes = out[0].length + 1;
    for (let i = 0; bytes < atLeastBytes; i++) {
      const assistant = JSON.stringify({
        type: 'assistant',
        content: `Beat ${i} of the run. ${filler}`,
        tool_calls: [{ id: `call-${i}`, name: 'read_file', arguments: JSON.stringify({ target_file: `src/f${i}.ts` }) }],
      });
      const result = JSON.stringify({ type: 'tool_result', tool_call_id: `call-${i}`, content: filler });
      out.push(assistant, result);
      bytes += assistant.length + result.length + 2;
    }
    fs.writeFileSync(history, `${out.join('\n')}\n`);
    fs.writeFileSync(summary, '{}');
    return { ...row(id, summary, 'grok'), activity: 'working' } as ActiveSession;
  }


  it('folds a 4-16 MiB non-resumable transcript instead of leaving it with no row at all', () => {
    const grok = writeGrokSession('grok-band', 5 * 1024 * 1024);
    const size = fs.statSync(path.join(path.dirname(grok.sessionFile!), 'chat_history.jsonl')).size;
    expect(size).toBeGreaterThan(pass.TIMELINE_PASS_MAX_BYTES_PER_SESSION);
    expect(size).toBeLessThan(pass.TIMELINE_PASS_MAX_WHOLE_FILE_BYTES);

    expect(pass.runTimelinePassSync({ sessions: [grok], nowMs: 2_000_000 })).toMatchObject({ computed: 1, reused: 0 });
    const stored = db.readSessionTimelineAny('grok-band')!;
    expect(stored.timeline.state).toBe('ready');
    expect(stored.timeline.steps.length).toBeGreaterThan(0);
  });

  it('says why when a transcript genuinely does not fit the tick, rather than counting it reused', () => {
    const grok = writeGrokSession('grok-tight', 5 * 1024 * 1024);
    const result = pass.runTimelinePassSync({ sessions: [grok], maxBytes: 64 * 1024, nowMs: 3_000_000 });
    expect(result).toMatchObject({ computed: 1, reused: 0, skipped: 0 });
    const stored = db.readSessionTimelineAny('grok-tight')!;
    expect(stored.timeline.state).toBe('partial');
    expect(stored.timeline.reason).toMatch(/whole-file fold.*budget left/);
    expect(db.readSessionTimelineEntry('grok-tight')!.state.offset).toBe(0);
    expect(pass.runTimelinePassSync({ sessions: [grok], nowMs: 3_000_000 + pass.TIMELINE_PASS_NON_RESUMABLE_MIN_INTERVAL_MS + 1 }))
      .toMatchObject({ computed: 1 });
    expect(db.readSessionTimelineAny('grok-tight')!.timeline.state).toBe('ready');
  });


  it('debits the tick budget by the bytes a whole-file re-parse actually reads', () => {
    const a = writeGrokSession('grok-debit-a', 5 * 1024 * 1024);
    const b = writeGrokSession('grok-debit-b', 5 * 1024 * 1024);
    const result = pass.runTimelinePassSync({ sessions: [a, b], maxBytes: 6 * 1024 * 1024, nowMs: 4_000_000 });
    expect(result.computed).toBe(2);
    expect(db.readSessionTimelineAny('grok-debit-a')!.timeline.state).toBe('ready');
    expect(db.readSessionTimelineAny('grok-debit-b')!.timeline.state).toBe('partial');
  });

  it('skips a session with no transcript on disk instead of throwing', () => {
    const result = pass.runTimelinePassSync({ sessions: [row('gone', path.join(tmpHome, 'nope.jsonl'))] });
    expect(result).toMatchObject({ computed: 0, skipped: 1 });
  });

  it('states a harness with no parseable transcript as unavailable, never as an empty timeline', () => {
    const file = path.join(tmpHome, 'openclaw.jsonl');
    fs.writeFileSync(file, '{}\n');
    pass.runTimelinePassSync({ sessions: [row('claw', file, 'openclaw')] });
    const stored = db.readSessionTimelineAny('claw')!;
    expect(stored.timeline.state).toBe('unavailable');
    expect(stored.timeline.reason).toContain('OpenClaw');
  });

  it('is reader-gated: no watcher attached, no work', async () => {
    const result = await pass.runTimelinePass({ nowMs: 0 });
    expect(result).toEqual({ computed: 0, reused: 0, skipped: 0 });
  });

  it('resumes a pasted image larger than one read and keeps the bytes out of the timeline cache', () => {
    const raw = Buffer.alloc(3 * 1024 * 1024, 7);
    const data = raw.toString('base64');
    const image = JSON.stringify({
      type: 'user',
      timestamp: '2026-10-02T22:13:00.000Z',
      message: { role: 'user', content: [
        { type: 'text', text: 'see this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
      ] },
    });
    const assistant = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-10-02T22:14:00.000Z',
      message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'looks fine' }] },
    });
    const file = path.join(tmpHome, 'wide-image.jsonl');
    fs.writeFileSync(file, `${image}\n${assistant}\n`);
    expect(image.length).toBeGreaterThan(pass.TIMELINE_PASS_MAX_BYTES_PER_SESSION);

    const first = pass.runTimelinePassSync({ sessions: [row('wide-image', file)] });
    expect(first).toMatchObject({ computed: 1, reused: 0 });
    const mid = db.readSessionTimelineEntry('wide-image')!;
    expect(mid.state.offset).toBeGreaterThan(0);
    expect(mid.state.offset).toBeLessThan(fs.statSync(file).size);
    expect(mid.state.partialLine?.skippingData).toBe(true);
    expect(JSON.stringify(mid.state)).not.toContain(data.slice(100, 180));
    expect(db.readSessionTimelineAny('wide-image')?.model).toBeUndefined();

    const second = pass.runTimelinePassSync({ sessions: [row('wide-image', file)] });
    expect(second).toMatchObject({ computed: 1, reused: 0 });
    const done = db.readSessionTimelineEntry('wide-image')!;
    expect(done.state.partialLine).toBeUndefined();
    expect(done.state.offset).toBe(fs.statSync(file).size);
    const rowAfter = db.readSessionTimelineAny('wide-image')!;
    expect(rowAfter.model).toBe('claude-opus-5-5');
    expect(rowAfter.userTurns?.some(turn => turn.text.includes('see this'))).toBe(true);
    const imagePath = rowAfter.attachments?.find(item => item.path)?.path;
    expect(imagePath).toBeTruthy();
    expect(fs.statSync(imagePath!).size).toBe(raw.length);
    expect(fs.statSync(imagePath!).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(done.state)).not.toContain(data.slice(100, 180));
  });

  it('leaves an unfinished tail unread until its newline fits in one read', () => {
    const text = `see this ${'x'.repeat(300_000)}`;
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-10-02T22:13:00.000Z',
      message: { role: 'user', content: text },
    });
    const file = path.join(tmpHome, 'tail-300.jsonl');
    fs.writeFileSync(file, line);
    expect(line.length).toBeGreaterThan(256 * 1024);
    expect(line.length).toBeLessThan(pass.TIMELINE_PASS_MAX_BYTES_PER_SESSION);

    const waiting = pass.runTimelinePassSync({ sessions: [row('tail-300', file)] });
    expect(waiting).toMatchObject({ computed: 0, reused: 1 });
    expect(db.readSessionTimelineEntry('tail-300')?.state.partialLine).toBeUndefined();

    fs.appendFileSync(file, '\n');
    expect(pass.runTimelinePassSync({ sessions: [row('tail-300', file)] })).toMatchObject({ computed: 1, reused: 0 });
    expect(db.readSessionTimelineAny('tail-300')?.userTurns?.some(turn => turn.text.includes('see this'))).toBe(true);
  });

  it('projects the glance model, and an older extractor version is refolded', () => {
    const file = path.join(tmpHome, 'glance.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      type: 'assistant',
      timestamp: '2026-10-02T22:13:00.000Z',
      message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 1, output_tokens: 1 } },
    }) + '\n');
    expect(pass.runTimelinePassSync({ sessions: [row('glance-model', file)] })).toMatchObject({ computed: 1 });
    expect(db.readSessionTimelineAny('glance-model')?.model).toBe('claude-opus-5-5');

    const stored = db.readSessionTimelineEntry('glance-model')!;
    stored.state.version = 1;
    const stamp = fs.statSync(file);
    db.writeSessionTimeline({
      id: 'glance-model',
      fileMtimeMs: Math.round(stamp.mtimeMs),
      fileSize: stamp.size,
      timeline: stored,
    });
    expect(pass.runTimelinePassSync({ sessions: [row('glance-model', file)] })).toMatchObject({ computed: 1, reused: 0 });
    expect(db.readSessionTimelineEntry('glance-model')!.state.version).toBe(timeline.TIMELINE_EXTRACTOR_VERSION);
  });

  it('does not fold a peer mirror\'s stored projection onto a local byte offset', () => {
    db.writeSessionTimeline({
      id: 'peer-1', fileMtimeMs: null, fileSize: null,
      timeline: {
        timeline: timeline.projectTimeline(timeline.emptyTimelineState(), undefined),
        state: timeline.emptyTimelineState(),
      },
    });
    expect(db.readSessionTimelineEntry('peer-1')!.state.offset).toBe(0);
  });
});
