/** Tests for the cloud dispatch live budget kill-switch (issue #399): the wrapper feeds `usage`
 * frames into `makeLiveSpendWatcher` and calls `provider.cancel(taskId)` on first breach. Checks:
 * null with no caps; passthrough under cap; on breach, one cancel and a cancelled status. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Pin HOME BEFORE any state.ts import so getHistoryDir() points at a temp dir.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'live-cloud-home-'));
process.env.HOME = fakeHome;
fs.mkdirSync(path.join(fakeHome, '.agents'), { recursive: true });

const { wrapStreamWithBudgetGate } = await import('./live-cloud.js');
import type { CloudEvent, CloudProvider, CloudTask, CloudTaskStatus, DispatchOptions, ProviderCapabilities } from '../cloud/types.js';

let projectDir: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-cloud-proj-'));
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

/** A stub CloudProvider implementing only `cancel`; every other method throws, so a call the budget
 * wrapper shouldn't make surfaces immediately. */
class StubProvider implements CloudProvider {
  id = 'rush' as const;
  name = 'stub';
  cancelCalls: string[] = [];
  cancelShouldThrow = false;

  capabilities(): ProviderCapabilities {
    return {
      available: true,
      dispatch: true, status: true, list: true, stream: true, cancel: true,
      message: false, multiRepo: false, skills: false, images: false,
    };
  }
  async dispatch(_o: DispatchOptions): Promise<CloudTask> { throw new Error('dispatch called'); }
  async status(_id: string): Promise<CloudTask> { throw new Error('status called'); }
  async list(): Promise<CloudTask[]> { throw new Error('list called'); }
  async *stream(_id: string): AsyncIterable<CloudEvent> { throw new Error('stream called'); }
  async cancel(taskId: string): Promise<void> {
    this.cancelCalls.push(taskId);
    if (this.cancelShouldThrow) throw new Error('cancel failed');
  }
  async message(_id: string, _c: string): Promise<void> { throw new Error('message called'); }
}

/** Build a synthetic SSE stream from a fixed event list. */
async function* mkStream(events: CloudEvent[]): AsyncIterable<CloudEvent> {
  for (const e of events) yield e;
}

/** Collect every event a wrapped stream yields, to assert pre-breach events pass through and
 * post-breach events are dropped. */
async function collect(stream: AsyncIterable<CloudEvent>): Promise<CloudEvent[]> {
  const out: CloudEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe('wrapStreamWithBudgetGate', () => {
  it('returns null when no caps are configured (feature dormant)', () => {
    // No agents.yaml, no user meta → hasAnyCap = false.
    const provider = new StubProvider();
    const wrapped = wrapStreamWithBudgetGate({
      provider,
      taskId: 'task-1',
      project: 'owner/repo',
      agent: 'claude',
      cwd: projectDir,
    });
    expect(wrapped).toBeNull();
  });

  it('forwards events unchanged when spend stays under cap', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'agents.yaml'),
      'budget:\n  per_project: 100\n',
    );
    const provider = new StubProvider();
    const wrapped = wrapStreamWithBudgetGate({
      provider,
      taskId: 'task-1',
      project: 'owner/repo',
      agent: 'claude',
      cwd: projectDir,
    });
    expect(wrapped).not.toBeNull();

    // 1M input on claude-opus-4 = $5, well under $100.
    const events: CloudEvent[] = [
      { type: 'text', content: 'hello' },
      { type: 'usage', model: 'claude-opus-4', inputTokens: 1_000_000, outputTokens: 0 },
      { type: 'done', status: 'completed' },
    ];
    const collected = await collect(wrapped!.wrap(mkStream(events)));
    expect(collected).toEqual(events);
    expect(provider.cancelCalls).toEqual([]);
    expect(wrapped!.gate.breached()).toBe(false);
  });

  it('cancels the cloud task and emits an error frame on cap breach', async () => {
    // per_project = $3; one 1M-input Claude turn is $5 → breach.
    fs.writeFileSync(
      path.join(projectDir, 'agents.yaml'),
      'budget:\n  per_project: 3\n  on_exceed: block\n',
    );
    const provider = new StubProvider();
    const wrapped = wrapStreamWithBudgetGate({
      provider,
      taskId: 'task-XYZ',
      project: 'owner/repo',
      agent: 'claude',
      cwd: projectDir,
    });

    // Include events AFTER the breaching usage frame — they must NOT come out
    // downstream. If they did, the renderer would keep printing text after
    // the task was already cancelled.
    const events: CloudEvent[] = [
      { type: 'text', content: 'hi' },
      { type: 'usage', model: 'claude-opus-4', inputTokens: 1_000_000 },
      { type: 'text', content: 'this-must-not-appear' },
      { type: 'done', status: 'completed' },
    ];
    const collected = await collect(wrapped!.wrap(mkStream(events)));

    // Cancel called exactly once with the task id we handed the wrapper.
    expect(provider.cancelCalls).toEqual(['task-XYZ']);
    expect(wrapped!.gate.breached()).toBe(true);
    expect(wrapped!.gate.breach()?.cap).toBe('per_project');

    // Downstream sees: pre-breach text, the breaching usage, then the
    // synthetic error + cancelled status. NO events after the breach.
    expect(collected[0]).toEqual({ type: 'text', content: 'hi' });
    // Last two frames are the gate's own signals.
    expect(collected[collected.length - 2].type).toBe('error');
    expect(collected[collected.length - 1]).toMatchObject({ type: 'status', status: 'cancelled' });
    expect(collected.some((e) => e.type === 'text' && e.content === 'this-must-not-appear')).toBe(false);
  });

  it('surfaces cancel-failure to the caller (never silently drops the breach)', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'agents.yaml'),
      'budget:\n  per_project: 3\n',
    );
    const provider = new StubProvider();
    provider.cancelShouldThrow = true;
    const wrapped = wrapStreamWithBudgetGate({
      provider,
      taskId: 'task-oom',
      project: 'owner/repo',
      agent: 'claude',
      cwd: projectDir,
    });

    const events: CloudEvent[] = [
      { type: 'usage', model: 'claude-opus-4', inputTokens: 1_000_000 },
    ];
    const collected = await collect(wrapped!.wrap(mkStream(events)));
    expect(provider.cancelCalls).toEqual(['task-oom']);
    // Even when cancel fails we must still surface the breach + cancelled
    // status downstream so the CLI exits with a visible reason.
    expect(collected.some((e) => e.type === 'error' && /cancel FAILED/.test(e.message))).toBe(true);
    expect(collected[collected.length - 1]).toMatchObject({ type: 'status', status: 'cancelled' });
  });

  it('per_agent cap trips ONLY when the dispatch agent matches', async () => {
    // per_agent.codex $1 → only codex would breach, not claude.
    fs.writeFileSync(
      path.join(projectDir, 'agents.yaml'),
      'budget:\n  per_agent:\n    codex: 1\n',
    );
    const provider = new StubProvider();
    // Dispatch registered as agent=claude → $5 of "usage" attributed to
    // claude does NOT breach the codex cap.
    const wrapped = wrapStreamWithBudgetGate({
      provider,
      taskId: 't',
      project: 'owner/repo',
      agent: 'claude',
      cwd: projectDir,
    });
    const events: CloudEvent[] = [
      { type: 'usage', model: 'claude-opus-4', inputTokens: 1_000_000 },
    ];
    await collect(wrapped!.wrap(mkStream(events)));
    expect(provider.cancelCalls).toEqual([]);
    expect(wrapped!.gate.breached()).toBe(false);
  });
});
