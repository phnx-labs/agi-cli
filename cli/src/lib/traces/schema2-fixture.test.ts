/**
 * End-to-end: build a rich schema-2 shard from a synthesized session, assert it
 * satisfies the CONSUMER contract (mirrors prix/web's decodeSessionDetail field
 * requirements), and write it to testdata so the shard shape is pinned. If the
 * consumer decoder changes, this fixture is the producer-side canary.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSessionDetailV2, type SessionDetailV2 } from './schema2-build.js';
import { buildTrajectory } from '@phnx-labs/sessions-cli/reader';
import type { SessionEvent, SessionMeta } from '@phnx-labs/sessions-cli/reader';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const T0 = '2026-08-30T00:00:00.000Z';
const at = (sec: number) => new Date(Date.parse(T0) + sec * 1000).toISOString();

const META: SessionMeta = {
  id: 'sess-schema2-producer',
  shortId: 'sess1',
  agent: 'claude',
  timestamp: T0,
  filePath: '/x/sess.jsonl',
  project: 'agents',
  model: 'opus-4-8',
  costUsd: 0.12,
};

/** A session exercising every schema-2 step kind. */
function richSession(): SessionEvent[] {
  const e: SessionEvent[] = [];
  e.push({ type: 'thinking', agent: 'claude', timestamp: at(0), content: 'plan the change' } as SessionEvent);
  // bash: multi-segment, one destructive
  e.push({ type: 'tool_use', agent: 'claude', timestamp: at(1), tool: 'Bash', callId: 'c1', command: `/bin/zsh -lc 'bun test && rm -rf dist'`, args: { command: `/bin/zsh -lc 'bun test && rm -rf dist'` } } as SessionEvent);
  e.push({ type: 'tool_result', agent: 'claude', timestamp: at(3), tool: 'Bash', callId: 'c1', outcome: 'ok', success: true, exitCode: 0, output: '42 pass 0 fail' } as SessionEvent);
  // read
  e.push({ type: 'tool_use', agent: 'claude', timestamp: at(4), tool: 'Read', callId: 'c2', args: { file_path: '/repo/types.ts', offset: 1, limit: 200 } } as SessionEvent);
  e.push({ type: 'tool_result', agent: 'claude', timestamp: at(5), tool: 'Read', callId: 'c2', outcome: 'ok', success: true, output: 'a\nb\nc' } as SessionEvent);
  // grep
  e.push({ type: 'tool_use', agent: 'claude', timestamp: at(6), tool: 'Grep', callId: 'c3', args: { pattern: 'decodeSessionDetail', path: 'src', output_mode: 'files' } } as SessionEvent);
  e.push({ type: 'tool_result', agent: 'claude', timestamp: at(7), tool: 'Grep', callId: 'c3', outcome: 'ok', success: true, output: 'a.ts\nb.ts\nc.ts' } as SessionEvent);
  // edit then revert
  e.push({ type: 'tool_use', agent: 'claude', timestamp: at(8), tool: 'Edit', callId: 'c4', args: { file_path: '/repo/f.ts', old_string: 'OLD', new_string: 'NEW' } } as SessionEvent);
  e.push({ type: 'tool_result', agent: 'claude', timestamp: at(9), tool: 'Edit', callId: 'c4', outcome: 'ok', success: true } as SessionEvent);
  e.push({ type: 'tool_use', agent: 'claude', timestamp: at(10), tool: 'Edit', callId: 'c5', args: { file_path: '/repo/f.ts', old_string: 'NEW', new_string: 'OLD' } } as SessionEvent);
  e.push({ type: 'tool_result', agent: 'claude', timestamp: at(11), tool: 'Edit', callId: 'c5', outcome: 'ok', success: true } as SessionEvent);
  // write
  e.push({ type: 'tool_use', agent: 'claude', timestamp: at(12), tool: 'Write', callId: 'c6', args: { file_path: '/repo/n.ts', content: 'x\ny' } } as SessionEvent);
  e.push({ type: 'tool_result', agent: 'claude', timestamp: at(13), tool: 'Write', callId: 'c6', outcome: 'ok', success: true } as SessionEvent);
  // generic
  e.push({ type: 'tool_use', agent: 'claude', timestamp: at(14), tool: 'WebFetch', callId: 'c7', args: { url: 'https://example.com/docs' } } as SessionEvent);
  e.push({ type: 'tool_result', agent: 'claude', timestamp: at(15), tool: 'WebFetch', callId: 'c7', outcome: 'ok', success: true, output: 'ok' } as SessionEvent);
  // hook
  e.push({ type: 'hook', agent: 'claude', timestamp: at(16), hookName: 'main-branch-guard', hookEvent: 'PreToolUse', success: false } as SessionEvent);
  return e;
}

/**
 * Structural validation mirroring prix/web's decodeSessionDetail. Not the exact
 * decoder (it lives in the consumer repo) but the same field-presence contract, so
 * a producer regression that would fail the real decoder fails here too.
 */
function assertValidSchema2(d: SessionDetailV2): void {
  expect(d.schema).toBe(2);
  expect(typeof d.id).toBe('string');
  // Tested contract: the producer deliberately OMITS category / risk / metrics —
  // the consumer backfills neutral defaults (coerceCategory/coerceRisk never throw).
  // If a future change starts emitting them, this assertion forces a conscious update.
  for (const k of ['category', 'risk', 'categoryMetrics'] as const) {
    expect(d).not.toHaveProperty(k);
  }
  for (const k of ['repo', 'agent', 'model', 'outcome'] as const) expect(typeof d.meta[k]).toBe('string');
  for (const k of ['spanMs', 'turns', 'tools', 'errorCount', 'tokens', 'costUsd'] as const) {
    expect(typeof d.meta[k]).toBe('number');
  }
  expect(Array.isArray(d.steps)).toBe(true);
  for (const s of d.steps) {
    expect(typeof s.ordinal).toBe('number');
    expect(typeof s.startMs).toBe('number');
    expect(typeof s.durationMs).toBe('number');
    expect(typeof s.durationEstimated).toBe('boolean');
    expect(['ok', 'error', 'running', 'unknown']).toContain(s.outcome);
    expect(typeof s.label).toBe('string');
    if (s.kind === 'thinking') {
      expect(s.lane).toBe('think');
      continue;
    }
    expect(s.kind).toBe('execution');
    const exec = s as any;
    if (exec.executionType === 'hook') {
      expect(exec.lane).toBe('hook');
      expect(['pre', 'post', 'session', 'other']).toContain(exec.phase);
      expect(['allowed', 'blocked', 'error', 'unknown']).toContain(exec.decision);
      expect(exec.result && typeof exec.result === 'object').toBe(true);
      continue;
    }
    if (exec.executionType === 'permission') {
      expect(exec.lane).toBe('permission');
      continue;
    }
    // a tool execution
    expect(['bash', 'edit', 'write', 'read', 'grep', 'generic']).toContain(exec.executionType);
    expect(typeof exec.tool).toBe('string');
    expect(exec.result && typeof exec.result === 'object').toBe(true);
    if (exec.executionType === 'bash') {
      expect(typeof exec.command).toBe('string');
      expect(typeof exec.unwrappedCommand).toBe('string');
      expect(['parsed', 'partial', 'unparseable']).toContain(exec.parseStatus);
      expect(Array.isArray(exec.parseDiagnostics)).toBe(true);
      for (const a of exec.actions) {
        expect(Array.isArray(a.argv)).toBe(true);
        expect(typeof a.argvComplete).toBe('boolean');
        expect(Array.isArray(a.categories)).toBe(true);
        for (const c of a.categories) expect(['build', 'test', 'git', 'network', 'other']).toContain(c);
        expect(['normal', 'potentially-destructive', 'DESTRUCTIVE']).toContain(a.danger);
      }
    }
    if (exec.executionType === 'edit' || exec.executionType === 'write') {
      expect(Array.isArray(exec.files)).toBe(true);
      expect(Array.isArray(exec.reverts)).toBe(true);
      for (const f of exec.files) {
        expect(typeof f.path).toBe('string');
        expect(['create', 'update', 'overwrite', 'delete', 'rename', 'unknown']).toContain(f.operation);
        for (const h of f.hunks) {
          expect(typeof h.id).toBe('string');
          expect(typeof h.addedLines).toBe('number');
          expect(typeof h.removedLines).toBe('number');
        }
      }
    }
    if (exec.executionType === 'read') expect(typeof exec.file).toBe('string');
    if (exec.executionType === 'grep') expect(typeof exec.query).toBe('string');
  }
  expect(Array.isArray(d.gaps)).toBe(true);
  expect(typeof d.truncatedSteps).toBe('number');
  expect(d.whereItWentWrong === null || typeof d.whereItWentWrong === 'string').toBe(true);
  expect(Array.isArray(d.surfacedToolFailures)).toBe(true);
}

describe('schema-2 producer fixture', () => {
  const events = richSession();
  const traj = buildTrajectory(events, META, { redact: false });
  const shard = buildSessionDetailV2(traj, events, { redact: false });

  it('produces a shard that satisfies the consumer schema-2 contract', () => {
    assertValidSchema2(shard);
  });

  it('exercises every step kind', () => {
    const types = new Set(shard.steps.map((s) => (s.kind === 'thinking' ? 'thinking' : (s as any).executionType)));
    for (const t of ['thinking', 'bash', 'read', 'grep', 'edit', 'write', 'generic', 'hook']) {
      expect(types.has(t)).toBe(true);
    }
  });

  it('carries the revert ledger and a destructive bash action', () => {
    const edits = shard.steps.filter((s) => (s as any).executionType === 'edit') as any[];
    const reverting = edits.find((e) => e.reverts.length > 0);
    expect(reverting).toBeDefined();
    const bash = shard.steps.find((s) => (s as any).executionType === 'bash') as any;
    expect(bash.actions.some((a: any) => a.danger === 'DESTRUCTIVE')).toBe(true);
  });

  it('pins the fixture to testdata (writes on demand)', () => {
    const out = path.join(__dirname, 'testdata', 'session-schema2-producer.json');
    if (process.env['UPDATE_FIXTURES'] === '1' || !fs.existsSync(out)) {
      fs.writeFileSync(out, JSON.stringify(shard, null, 2) + '\n');
    }
    const onDisk = JSON.parse(fs.readFileSync(out, 'utf8')) as SessionDetailV2;
    assertValidSchema2(onDisk);
    expect(onDisk.id).toBe(shard.id);
    expect(onDisk.steps.length).toBe(shard.steps.length);
  });
});
