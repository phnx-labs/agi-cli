/** Real-path contract test: fork builds its recap from the real output of `agents sessions preview
 * <id> --json`, so shape drift (e.g. dropping `topic`) must fail a test; seeded with a real
 * session, no hand-written fixture. */
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-preview-contract-'));
process.env.HOME = TEST_HOME;
process.env.AGENTS_REAL_HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { upsertSession, closeDB } = await import('../lib/session/db.js');
const { renderSessionPreview } = await import('./sessions.js');
const { buildForkRecap, forkLabelFor } = await import('../lib/session/fork.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

function seedUnnamed(id: string): SessionMeta {
  const proj = path.join(TEST_HOME, '.claude', 'projects', '-tmp-fork');
  fs.mkdirSync(proj, { recursive: true });
  const filePath = path.join(proj, `${id}.jsonl`);
  const body = [
    JSON.stringify({ type: 'user', sessionId: id, cwd: '/tmp/fork', message: { role: 'user', content: [{ type: 'text', text: 'wire up the evals console' }] } }),
    JSON.stringify({ type: 'assistant', sessionId: id, message: { role: 'assistant', content: [{ type: 'text', text: 'insight widgets need gaps 1 and 2 closed' }] } }),
  ].join('\n') + '\n';
  fs.writeFileSync(filePath, body);
  const meta: SessionMeta = {
    id, shortId: id.slice(0, 8), agent: 'claude',
    timestamp: '2026-01-01T00:00:00.000Z', filePath, cwd: '/tmp/fork',
    topic: 'wire up the evals console',
  };
  upsertSession(meta, body);
  return meta;
}

function captureLog() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  return { get text() { return lines.join('\n'); }, restore: () => spy.mockRestore() };
}

describe('fork ↔ preview --json contract (real path)', () => {
  it('preview --json carries `topic`, and the recap it feeds shows the topic (not the raw short id)', async () => {
    const src = seedUnnamed('c0ffee00-1111-2222-3333-444444444444');

    const out = captureLog();
    await renderSessionPreview(src.id, { json: true, local: true });
    out.restore();

    const data = JSON.parse(out.text);
    expect(data.session.topic).toBe('wire up the evals console');
    expect(data.session.label ?? '').toBe('');
    expect(data.preview.lastAssistant).toContain('insight widgets need gaps');

    const label = forkLabelFor({ label: data.session.label, topic: data.session.topic, shortId: data.session.shortId });
    const recap = buildForkRecap({
      agent: data.session.agent,
      label,
      cwd: data.session.cwd,
      ticketId: data.session.ticketId,
      machine: data.session.machine,
      shortId: data.session.shortId,
      id: data.session.id,
      lastAssistant: data.preview.lastAssistant,
      changes: data.preview.changes,
    });

    expect(recap).toContain('Continue a prior claude session ("wire up the evals console")');
    expect(recap).not.toContain('("c0ffee00")');
    expect(recap).toContain('insight widgets need gaps 1 and 2 closed');
  });
});
