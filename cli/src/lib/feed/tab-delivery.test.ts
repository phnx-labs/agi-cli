import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deliverToTab, readTabDelivery, TAB_DELIVERY_TTL_MS } from './tab-delivery.js';

function setup(existing = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-delivery-'));
  const transcript = path.join(root, 's.jsonl');
  fs.writeFileSync(transcript, existing);
  return { root, transcript };
}

function window(root: string, sessionId: string, transcript: string, line: string) {
  const timer = setInterval(() => {
    if (!readTabDelivery(sessionId, root)) return;
    clearInterval(timer);
    fs.appendFileSync(transcript, `${line}\n`);
  }, 30);
  return () => clearInterval(timer);
}

describe('deliverToTab', () => {
  it('is delivered when the transcript takes the words after the hand-off, and the record is owner-only and gone after', async () => {
    const { root, transcript } = setup();
    let mode = 0;
    const peek = setInterval(() => { try { mode = fs.statSync(path.join(root, 'deliveries', 's1.json')).mode & 0o777; } catch { } }, 10);
    const stop = window(root, 's1', transcript, JSON.stringify({ type: 'user', message: { content: 'Merge it, then post the URL' } }));
    const r = await deliverToTab({ sessionId: 's1', text: 'Merge it, then post the URL', transcript, root, timeoutMs: 3_000 });
    stop(); clearInterval(peek);
    expect(r.delivered).toBe(true);
    expect(mode).toBe(0o600);
    expect(readTabDelivery('s1', root, Number.NEGATIVE_INFINITY)).toBeUndefined();
  });

  it('words already in the transcript before the hand-off are no receipt', async () => {
    const { root, transcript } = setup(`${JSON.stringify({ type: 'user', message: { content: 'continue' } })}\n`);
    const stop = window(root, 's2', transcript, JSON.stringify({ type: 'assistant', message: { content: 'still working' } }));
    const r = await deliverToTab({ sessionId: 's2', text: 'continue', transcript, root, timeoutMs: 1_000 });
    stop();
    expect(r).toMatchObject({ delivered: false, touched: true });
  });

  it('a picker key counts only when a tool result lands, and an untouched transcript says nothing reached it', async () => {
    const { root, transcript } = setup();
    const stop = window(root, 's3', transcript, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Build B' }] } }));
    expect((await deliverToTab({ sessionId: 's3', text: '2', enter: false, transcript, root, timeoutMs: 2_000 })).delivered).toBe(true);
    stop();
    const quiet = setup();
    expect(await deliverToTab({ sessionId: 's4', text: '2', enter: false, transcript: quiet.transcript, root: quiet.root, timeoutMs: 600 }))
      .toMatchObject({ delivered: false, touched: false });
  });

  it('with no transcript to confirm it, nothing is sent and the answer can be retried', async () => {
    const { root } = setup();
    expect(await deliverToTab({ sessionId: 's6', text: 'hi', root })).toMatchObject({ delivered: false, touched: false });
    expect(readTabDelivery('s6', root, Number.NEGATIVE_INFINITY)).toBeUndefined();
  });

  it('a window never sees a delivery older than the wait', () => {
    const { root } = setup();
    fs.mkdirSync(path.join(root, 'deliveries'));
    const at = new Date(Date.now() - TAB_DELIVERY_TTL_MS - 1).toISOString();
    fs.writeFileSync(path.join(root, 'deliveries', 's5.json'), JSON.stringify({ id: 'x', sessionId: 's5', text: 'hi', enter: true, at }));
    expect(readTabDelivery('s5', root)).toBeUndefined();
  });
});
