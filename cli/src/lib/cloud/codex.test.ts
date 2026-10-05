import { describe, it, expect } from 'vitest';
import { extractTaskId } from './codex.js';

// Dispatch keys status, list and reconcile on the id extractTaskId returns. The old synthetic
// `codex-<ts>` fallback never matched; a genuine miss yields undefined, which dispatch makes loud.
describe('extractTaskId', () => {
  it('reads the id from JSON output', () => {
    expect(extractTaskId('{"id":"task_abc123","status":"queued"}')).toBe('task_abc123');
    expect(extractTaskId('{"task_id":"019fb-real-exec"}')).toBe('019fb-real-exec');
  });

  it('reads a UUID printed in free text', () => {
    expect(extractTaskId('Started execution 3bc93e7d-390e-4126-b0cb-f668a6d63bd8 on env foo'))
      .toBe('3bc93e7d-390e-4126-b0cb-f668a6d63bd8');
  });

  it('reads a task_/id: key line', () => {
    expect(extractTaskId('task_id: task_9f3axyz')).toBe('task_9f3axyz');
    expect(extractTaskId('  id = codex_run_42  ')).toBe('codex_run_42');
  });

  it('returns undefined when no id is present — dispatch must fail loud, not fabricate one', () => {
    expect(extractTaskId('dispatched, see the web UI')).toBeUndefined();
    expect(extractTaskId('')).toBeUndefined();
  });

  it('never invents a codex-<timestamp> id', () => {
    // The removed synthetic fallback returned `codex-<Date.now()>`; a genuine
    // miss must be undefined so dispatch fails loud, never a fabricated id.
    const out = extractTaskId('no id here');
    expect(out).toBeUndefined();
    expect(out === undefined || !/^codex-\d+$/.test(out)).toBe(true);
  });
});
