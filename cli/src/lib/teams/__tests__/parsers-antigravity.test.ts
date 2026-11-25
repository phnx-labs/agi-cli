import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { normalizeEvents } from '../parsers.js';

function fixtureEvents(name: string): any[] {
  const p = fileURLToPath(new URL(`./testdata/${name}`, import.meta.url));
  return fs.readFileSync(p, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean)
    .flatMap((l) => normalizeEvents('antigravity', JSON.parse(l)));
}

describe('normalizeEvents(antigravity)', () => {
  it('turns a write_file run into init, file_create, message and result', () => {
    const events = fixtureEvents('antigravity-write.jsonl');
    expect(events.map((e) => e.type)).toEqual(['init', 'file_create', 'tool_result', 'message', 'message', 'result']);
    expect(events[0]).toMatchObject({ type: 'init', session_id: '06f57e3e-5302-40b3-8a09-3f474b62da5f' });
    expect(events[1]).toMatchObject({ type: 'file_create', tool: 'write_file', path: '/work/demo/fixture.txt' });
    expect(events.filter((e) => e.type === 'message').map((e) => e.content).join('')).toBe('wrote it\n');
    expect(events.at(-1)).toMatchObject({ type: 'result', status: 'success', session_id: '06f57e3e-5302-40b3-8a09-3f474b62da5f' });
  });

  it('maps run_command to bash with file-op sidecars and edit_file to file_write', () => {
    const events = fixtureEvents('antigravity-shell-edit.jsonl');
    expect(events.find((e) => e.type === 'bash')).toMatchObject({ tool: 'run_command', command: 'echo hi > shell.txt' });
    expect(events.find((e) => e.type === 'file_write' && e.tool === 'bash')).toMatchObject({ path: 'shell.txt' });
    expect(events.find((e) => e.type === 'file_write' && e.tool === 'edit_file')).toMatchObject({ path: '/work/demo/fixture.txt' });
    expect(events.filter((e) => e.type === 'tool_result').every((e) => e.success)).toBe(true);
    expect(events.some((e) => e.type === 'unknown' || e.type === 'step_update')).toBe(false);
  });

  it('reports a non-SUCCESS result as an error', () => {
    const [event] = normalizeEvents('antigravity', { event: 'result', result: { conversation_id: 'c1', status: 'ERROR' } });
    expect(event).toMatchObject({ type: 'result', status: 'error', session_id: 'c1' });
  });

  it('emits an unknown event for non-object input', () => {
    expect(normalizeEvents('antigravity', null)[0]).toMatchObject({ type: 'unknown', agent: 'antigravity' });
  });
});
