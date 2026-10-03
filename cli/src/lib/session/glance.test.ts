import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClaudeContent, parseCodexContent, parseCodexItemsContent } from './parse.js';
import { deriveGlance, projectGlance } from './glance.js';
import { foldTimeline, projectTimeline } from './timeline.js';
import { inferSessionState } from './state.js';
import { enrichGlanceFiles, materializeInlineImages, readSessionSubagents } from './glance-files.js';
import { indexArtifactSidecars, mergeArtifacts } from './highlights.js';
import { scanClaudeSession } from './discover.js';
import type { ActiveSession } from './active.js';
import type { SessionEvent } from './types.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata/glance');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const claude = fs.readFileSync(path.join(fixtures, 'claude.jsonl'), 'utf8');
const at = (second: number) => Date.parse(`2026-10-01T12:00:${String(second).padStart(2, '0')}.000Z`);

describe('glance rows from real transcripts', () => {
  it('folds failures, 48 activity buckets, genuine user turns and the latest model', () => {
    const events = parseClaudeContent(claude);
    const folded = foldTimeline(events);
    const glance = projectGlance(folded.glance);
    expect(glance.model).toBe('claude-sonnet-5');
    expect(glance.userTurns).toEqual([
      { atMs: at(0), text: 'Inspect this screenshot.\nThen fix the build.', images: 1 },
      { atMs: at(10), text: 'Now run the tests.', images: 0 },
    ]);
    expect(glance.attachments?.[0].turnIndex).toBe(0);
    expect(glance.failures).toEqual([
      { atMs: at(3), tool: 'Bash', summary: 'bun run build', error: 'exit 1 · Build failed', blocked: false },
      { atMs: at(5), tool: 'Read', summary: '/workspace/private.txt', error: 'Permission denied', blocked: true },
      { atMs: at(7), tool: 'Bash', summary: 'git push origin main', error: 'Hook refused protected branch', blocked: true },
    ]);
    expect(glance.activityHistogram).toMatchObject({ startMs: at(0), endMs: at(11), userAtMs: [at(0), at(10)] });
    expect(glance.activityHistogram!.buckets).toHaveLength(48);
    const totals = glance.activityHistogram!.buckets.reduce((sum, bucket) => ({ tools: sum.tools + bucket.tools, failed: sum.failed + bucket.failed, blocked: sum.blocked + bucket.blocked }), { tools: 0, failed: 0, blocked: 0 });
    expect(totals).toEqual({ tools: 3, failed: 1, blocked: 2 });
    expect(projectTimeline(folded, 'idle')).toMatchObject(totals);
    expect(inferSessionState(events)).toMatchObject({ model: glance.model, failures: glance.failures, userTurns: glance.userTurns });
  });

  it('preserves exact bucket boundaries and call correlation when folds resume', () => {
    const lines = claude.trim().split('\n');
    let incremental = foldTimeline([]);
    for (const line of lines) incremental = foldTimeline(parseClaudeContent(line), incremental);
    expect(projectGlance(incremental.glance)).toEqual(projectGlance(foldTimeline(parseClaudeContent(claude)).glance));
    const buckets = projectGlance(incremental.glance).activityHistogram!.buckets;
    expect(buckets[8].tools).toBe(1);
    expect(buckets[13].failed).toBe(1);
    const sameTime: SessionEvent[] = [{ type: 'tool_use', agent: 'claude', timestamp: new Date(at(0)).toISOString(), tool: 'Read' }];
    expect(projectGlance(deriveGlance(sameTime)).activityHistogram!.buckets[0].tools).toBe(1);
    expect(projectGlance(deriveGlance([]))).toEqual({});
  });

  it('caps the newest failures and user turns and drops stale attachment turn indices', () => {
    const events = parseClaudeContent(claude);
    for (let i = 0; i < 60; i++) {
      const timestamp = new Date(at(0) + 60_000 + i * 1000).toISOString();
      events.push({ type: 'message', role: 'user', agent: 'claude', timestamp, content: 'x'.repeat(400) });
      events.push({ type: 'tool_use', agent: 'claude', timestamp, callId: `call-${i}`, tool: 'Bash', command: 'echo ' + 'y'.repeat(200) });
      events.push({ type: 'error', agent: 'claude', timestamp, callId: `call-${i}`, content: `error ${i} ` + 'z'.repeat(200) });
    }
    const result = projectGlance(deriveGlance(events));
    expect(result.failures).toHaveLength(20);
    expect(result.failures![0].error).toMatch(/^error 40 /);
    expect(result.failures!.at(-1)!.summary).toHaveLength(140);
    expect(result.failures!.at(-1)!.error).toHaveLength(160);
    expect(result.userTurns).toHaveLength(50);
    expect(result.userTurns![0].text).toHaveLength(300);
    expect(result.activityHistogram!.userAtMs).toHaveLength(50);
    expect(result.attachments![0].turnIndex).toBeUndefined();
  });

  it('uses the timeline classifier for a benign search exit across chunk boundaries', () => {
    const first: SessionEvent = { type: 'tool_use', agent: 'claude', timestamp: new Date(at(0)).toISOString(), callId: 'search', tool: 'Bash', command: 'rg missing src' };
    const result: SessionEvent = { type: 'error', agent: 'claude', timestamp: new Date(at(1)).toISOString(), callId: 'search', exitCode: 1, content: 'no matches' };
    const folded = foldTimeline([result], foldTimeline([first]));
    expect(projectGlance(folded.glance).failures).toBeUndefined();
    expect(projectTimeline(folded, 'idle').failed).toBe(0);
  });

  it('reads Codex models from both normalized transcript readers', () => {
    const content = fs.readFileSync(path.join(fixtures, 'codex.jsonl'), 'utf8');
    for (const parse of [parseCodexContent, parseCodexItemsContent]) {
      expect(projectGlance(deriveGlance(parse(content))).model).toBe('gpt-6-astra');
    }
  });

  it('materializes inline images once with a real path and enforces size and count limits', () => {
    const root = path.join(tmp, 'attachments');
    const events = parseClaudeContent(claude, { includeInlineImages: true });
    materializeInlineImages(events, 'fixture', root);
    const first = projectGlance(deriveGlance(events)).attachments![0];
    expect(first.path).toMatch(/\.png$/);
    expect(first.turnIndex).toBe(0);
    expect(fs.readFileSync(first.path!).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    fs.utimesSync(first.path!, 123, 123);
    const repeated = parseClaudeContent(claude, { includeInlineImages: true });
    materializeInlineImages(repeated, 'fixture', root);
    expect(repeated.find(event => event.type === 'attachment')!.path).toBe(first.path);
    expect(fs.statSync(first.path!).mtimeMs).toBe(123000);
    expect(JSON.stringify(repeated)).not.toContain('_imageData');
    const many: SessionEvent[] = Array.from({ length: 12 }, (_, i) => ({ type: 'attachment', agent: 'claude', timestamp: '', mediaType: 'image/png', _imageData: Buffer.from(`image-${i}`).toString('base64') }));
    materializeInlineImages(many, 'limited', root);
    expect(many.filter(event => event.path)).toHaveLength(10);
    const large: SessionEvent[] = [{ type: 'attachment', agent: 'claude', timestamp: '', mediaType: 'image/png', _imageData: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }];
    materializeInlineImages(large, 'large', root);
    expect(large[0].path).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'large'))).toBe(false);
  });

  it('counts real subagent transcripts, orders them, and refreshes appended child activity', async () => {
    const session = path.join(tmp, '.agents/.history/versions/claude/1/home/.claude/projects/example/parent.jsonl');
    fs.mkdirSync(path.dirname(session), { recursive: true });
    fs.copyFileSync(path.join(fixtures, 'claude.jsonl'), session);
    fs.cpSync(path.join(fixtures, 'claude/subagents'), session.replace('.jsonl', '/subagents'), { recursive: true });
    // Six invocation records may describe only two actual child transcripts.
    for (let i = 0; i < 6; i++) fs.appendFileSync(session, JSON.stringify({ type: 'assistant', timestamp: new Date(at(12)).toISOString(), message: { content: [{ type: 'tool_use', id: `spawn-${i}`, name: 'Task', input: { description: 'Review' } }] } }) + '\n');
    expect((await scanClaudeSession(session)).subAgentCount).toBe(2);
    const now = Date.now();
    const rows = readSessionSubagents(session, true, ['agent-call-2'], now)!;
    expect(rows.map(row => [row.id, row.status, row.toolCount])).toEqual([['agent-fixture-1', 'running', 1], ['agent-fixture-2', 'failed', 1]]);
    expect(rows[0]).toMatchObject({ agentType: 'code-reviewer', description: 'Review 1', startedAtMs: at(1), endedAtMs: at(3), resultExcerpt: 'Review 1 complete.' });
    expect(readSessionSubagents(session, true, [], now + 120001)![0].status).toBe('done');
    const child = rows[0].transcriptPath;
    fs.appendFileSync(child, JSON.stringify({ type: 'assistant', timestamp: new Date(at(20)).toISOString(), message: { content: [{ type: 'text', text: 'Updated result.' }] } }) + '\n');
    expect(readSessionSubagents(session, false)![0].resultExcerpt).toBe('Updated result.');
    const row: ActiveSession = { context: 'terminal', kind: 'claude', status: 'running', pidAlive: true, sessionFile: session, sessionId: 'parent', subAgentCount: 6 };
    enrichGlanceFiles([row], now);
    expect(row.subAgentCount).toBe(2);
  });

  it('joins sidecar plans by either session key, prefers HTML, and dedupes tool-created paths', () => {
    const root = path.join(tmp, 'artifacts');
    const dir = path.join(root, '2026-10-01', 'plan');
    fs.mkdirSync(dir, { recursive: true });
    const markdown = path.join(dir, 'plan.md');
    const html = path.join(dir, 'plan.html');
    fs.writeFileSync(markdown, '# Plan');
    fs.writeFileSync(path.join(dir, '.artifact.json'), JSON.stringify({ session: 'parent', kind: 'plan', title: 'A useful plan', slug: 'plan' }));
    expect(indexArtifactSidecars(root).get('parent')![0].path).toBe(markdown);
    fs.writeFileSync(html, '<h1>Plan</h1>');
    const indexed = indexArtifactSidecars(root).get('parent')!;
    expect(indexed).toEqual([{ path: html, basename: 'plan.html', bucket: 'plans', title: 'A useful plan' }]);
    expect(mergeArtifacts([{ path: html, basename: 'plan.html', bucket: 'artifacts' }], indexed)).toEqual(indexed);
    fs.writeFileSync(path.join(dir, '.artifact.json'), JSON.stringify({ sessionId: 'other', kind: 'report', title: 'Report' }));
    expect(indexArtifactSidecars(root).has('parent')).toBe(false);
    expect(indexArtifactSidecars(root).get('other')![0].bucket).toBe('artifacts');
  });
});
