import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-batch-'));
process.env.HOME = TEST_HOME;
process.env.AGENTS_REAL_HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { upsertSession, closeDB } = await import('../lib/session/db.js');
const { previewJsonFor, renderSessionPreview, renderSessionPreviews } = await import('./ps.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

function seed(id: string, reply: string): SessionMeta {
  const proj = path.join(TEST_HOME, '.claude', 'projects', '-tmp-batch');
  fs.mkdirSync(proj, { recursive: true });
  const filePath = path.join(proj, `${id}.jsonl`);
  const body = [
    JSON.stringify({ type: 'user', sessionId: id, cwd: '/tmp/batch', message: { role: 'user', content: [{ type: 'text', text: `ask for ${id.slice(0, 8)}` }] } }),
    JSON.stringify({ type: 'assistant', sessionId: id, message: { role: 'assistant', content: [{ type: 'text', text: reply }] } }),
  ].join('\n') + '\n';
  fs.writeFileSync(filePath, body);
  const meta: SessionMeta = { id, shortId: id.slice(0, 8), agent: 'claude', timestamp: '2026-01-01T00:00:00.000Z', filePath, cwd: '/tmp/batch' };
  upsertSession(meta, body);
  return meta;
}

async function captured(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try { await run(); } finally { spy.mockRestore(); errors.mockRestore(); }
  return lines.join('\n');
}

describe('sessions preview with several ids (PHNX-4326)', () => {
  const a = seed('aaaa1111-2222-4333-8444-555555555555', 'first reply');
  const b = seed('bbbb1111-2222-4333-8444-555555555555', 'second reply');
  const missing = 'cccc1111-2222-4333-8444-555555555555';

  it('returns one array in argument order, each element the single-id envelope plus its query', async () => {
    const single = JSON.parse(await captured(() => renderSessionPreview(b.id, { json: true, local: true })));
    process.exitCode = undefined;
    const batch = JSON.parse(await captured(() => renderSessionPreviews([b.id, missing, a.id], { json: true, local: true })));
    expect(process.exitCode).toBeUndefined();
    expect(Array.isArray(single)).toBe(false);
    expect(batch.map((entry: { query: string }) => entry.query)).toEqual([b.id, missing, a.id]);
    expect(batch[0].preview.lastAssistant).toBe('second reply');
    expect(batch[2].preview.lastAssistant).toBe('first reply');
    const { query: _query, ...first } = batch[0];
    expect(Object.keys(first).sort()).toEqual(Object.keys(single).sort());
    expect(batch[1]).toMatchObject({ session: null, preview: null, error: `No session with id ${missing} on this machine.` });
  });

  it('keeps every element when one id\'s read throws', async () => {
    const failing = b.id;
    const batch = JSON.parse(await captured(() => renderSessionPreviews([a.id, failing], { json: true, local: true }, (query, scope, live) => {
      if (query === failing) throw new Error('index locked');
      return previewJsonFor(query, scope, live);
    })));
    expect(batch.map((entry: { query: string }) => entry.query)).toEqual([a.id, failing]);
    expect(batch[0].preview.lastAssistant).toBe('first reply');
    expect(batch[1]).toMatchObject({ session: null, preview: null, error: 'index locked' });
  });

  it('prints every card without --json and exits 1 only when no id resolved', async () => {
    process.exitCode = undefined;
    const text = await captured(() => renderSessionPreviews([a.id, missing], { local: true }));
    expect(text).toContain('first reply');
    expect(process.exitCode).toBeUndefined();
    await captured(() => renderSessionPreviews([missing, 'dddd1111-2222-4333-8444-555555555555'], { local: true }));
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it('exits 1 only when no id resolved', async () => {
    process.exitCode = undefined;
    await captured(() => renderSessionPreviews([missing, 'dddd1111-2222-4333-8444-555555555555'], { json: true, local: true }));
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});
