import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeSubagentFiles, materializeInlineImages, readSessionSubagents, resolvedSubAgentCount } from './glance-files.js';
import type { SessionEvent } from '@phnx-labs/sessions-cli/reader';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-files-'));

function sessionWith(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, '');
  return file;
}

function toolLine(id: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-02T00:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'a.ts' } }] },
  }) + '\n';
}

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
});

describe('subagent counts', () => {
  it('keeps the tool-call count when this session has no subagent transcripts', () => {
    expect(resolvedSubAgentCount(undefined, 4)).toBe(4);
    expect(resolvedSubAgentCount([], 4)).toBe(4);
    const file = sessionWith('empty');
    fs.mkdirSync(path.join(path.dirname(file), 'session', 'subagents'), { recursive: true });
    expect(claudeSubagentFiles(file)).toEqual([]);
    expect(resolvedSubAgentCount(claudeSubagentFiles(file), 6)).toBe(6);
  });

  it('counts this session\'s own transcripts, and a growing child is folded in bounded reads', () => {
    const file = sessionWith('kids');
    const dir = path.join(path.dirname(file), 'session', 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    const child = path.join(dir, 'agent-reviewer.jsonl');
    const line = toolLine('toolu_1');
    const total = Math.ceil((300 * 1024) / Buffer.byteLength(line));
    fs.writeFileSync(child, line.repeat(total));
    fs.writeFileSync(child.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({
      agentType: 'code-reviewer', description: 'Review PR 1',
    }));

    const first = readSessionSubagents(file, false, [], 1_000)!;
    expect(first).toHaveLength(1);
    expect(first[0].agentType).toBe('code-reviewer');
    expect(first[0].description).toBe('Review PR 1');
    expect(first[0].toolCount).toBeGreaterThan(0);
    expect(first[0].toolCount).toBeLessThan(total);
    expect(resolvedSubAgentCount(claudeSubagentFiles(file), 6)).toBe(1);

    const second = readSessionSubagents(file, false, [], 1_000)!;
    expect(second[0].toolCount).toBe(total);
    expect(second[0].status).toBe('done');
  });
});

describe('pasted images', () => {
  it('writes one private file and drops the inline bytes, including a refused session id', () => {
    const root = path.join(tmp, 'images');
    const png = Buffer.from('hello-image');
    const kept: SessionEvent = { type: 'attachment', mediaType: 'image/png', _imageData: png.toString('base64') };
    materializeInlineImages([kept], 'sess1', root);
    expect(kept._imageData).toBeUndefined();
    expect(kept.path).toMatch(/sess1\/[a-f0-9]{64}\.png$/);
    expect(fs.statSync(kept.path!).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(kept.path!)).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(kept.path!).equals(png)).toBe(true);

    const again: SessionEvent = { type: 'attachment', mediaType: 'image/png', _imageData: png.toString('base64') };
    materializeInlineImages([again], 'sess1', root);
    expect(again.path).toBe(kept.path);
    expect(fs.readdirSync(path.dirname(kept.path!))).toHaveLength(1);

    const refused: SessionEvent = { type: 'attachment', mediaType: 'image/png', _imageData: png.toString('base64') };
    materializeInlineImages([refused], '../sess1', root);
    expect(refused._imageData).toBeUndefined();
    expect(refused.path).toBeUndefined();
  });
});
