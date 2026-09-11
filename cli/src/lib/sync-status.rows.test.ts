import { describe, expect, it } from 'vitest';
import { formatDriftRows, type AgentVersionStatus } from './sync-status.js';

const base: AgentVersionStatus = {
  agent: 'claude',
  version: '2.1.220',
  isDefault: true,
  everSynced: true,
  counts: { synced: 9, drifted: 2, missing: 1, orphan: 3 },
  needsSync: true,
  resources: [
    { agent: 'claude', version: '2.1.220', kind: 'skills', name: 'artifacts', status: 'drifted' },
    { agent: 'claude', version: '2.1.220', kind: 'hooks', name: 'feed-publish', status: 'synced' },
    { agent: 'claude', version: '2.1.220', kind: 'subagents', name: 'artifact-critic', status: 'missing' },
    { agent: 'claude', version: '2.1.220', kind: 'plugins', name: 'code', status: 'drifted', detail: '0.9.0 -> 0.10.0' },
    { agent: 'claude', version: '2.1.220', kind: 'commands', name: 'old', status: 'orphan' },
  ],
};

describe('formatDriftRows', () => {
  it('names each drifted or missing resource, sorted by kind then name, with detail when known', () => {
    expect(formatDriftRows(base)).toEqual([
      'drifted plugins/code (0.9.0 -> 0.10.0)',
      'drifted skills/artifacts',
      'missing subagents/artifact-critic',
    ]);
  });

  it('prints nothing for an install that is in sync, orphans included', () => {
    expect(formatDriftRows({ ...base, needsSync: false, resources: base.resources.filter((r) => r.status === 'synced' || r.status === 'orphan') })).toEqual([]);
  });
});
