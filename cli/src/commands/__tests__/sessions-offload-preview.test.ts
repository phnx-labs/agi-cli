
import { describe, it, expect } from 'vitest';
import { foldExecutionMachine, type ActiveSession } from '../../lib/session/active.js';
import { liveSessionToMeta } from '../sessions-browser.js';
import { buildPreview } from '../sessions-picker.js';

const self = 'zion';

function offloadedRow(): ActiveSession {
  return {
    context: 'terminal',
    kind: 'claude',
    status: 'running',
    sessionId: '1936fb8e-571a-4ef0-a5e6-ceafbc890eee',
    cwd: '/Users/muqsit/.agents/.system',
    machine: self,
    label: '[host/yosemite-s0]',
    sessionFile: undefined,
  } as ActiveSession;
}

describe('offloaded session: live row -> meta -> preview', () => {
  it('resolves the preview against the executing peer, not a local dead end', () => {
    const rows = [offloadedRow()];
    foldExecutionMachine(rows, () => 'yosemite-s0', self);

    const meta = liveSessionToMeta(rows[0], self);
    expect(meta.machine).toBe('yosemite-s0');
    expect(meta._remote).toBe(true);

    const preview = buildPreview(meta);
    expect(preview).toContain('yosemite-s0');
    expect(preview).not.toContain('full transcript not indexed here');
    expect(preview.trim()).not.toBe('');
  });

  it('without the attribution the same row still dead-ends (the regression guard)', () => {
    const meta = liveSessionToMeta(offloadedRow(), self);
    expect(meta._remote).toBe(false);
  });

  it('a genuinely local session is untouched and still previews locally', () => {
    const rows = [{ ...offloadedRow(), label: undefined }] as ActiveSession[];
    foldExecutionMachine(rows, () => self, self);
    const meta = liveSessionToMeta(rows[0], self);
    expect(meta.machine).toBe(self);
    expect(meta._remote).toBe(false);
  });
});
