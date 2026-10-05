import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  computeAgentCounts,
  probeLocalFleetStatus,
  readFleetStatus,
  writeFleetStatusRows,
  setFleetStatusMirrorPathForTest,
  type FleetStatusRow,
} from './fleet-status.js';

describe('computeAgentCounts — running-agent workload with per-context/agent breakdown', () => {
  it('counts only running sessions, broken down by context and agent', () => {
    const counts = computeAgentCounts([
      { status: 'running', context: 'terminal', kind: 'claude' },
      { status: 'running', context: 'teams', kind: 'codex' },
      { status: 'running', context: 'terminal', kind: 'claude' },
      { status: 'idle', context: 'terminal', kind: 'claude' },
      { status: 'orphaned', context: 'headless', kind: 'droid' },
    ]);
    expect(counts.running).toBe(3);
    expect(counts.live).toBe(5);
    expect(counts.byContext).toEqual({ terminal: 2, teams: 1 });
    expect(counts.byAgent).toEqual({ claude: 2, codex: 1 });
  });

  it('is all zeros for an empty session set', () => {
    expect(computeAgentCounts([])).toEqual({ running: 0, live: 0, byContext: {}, byAgent: {} });
  });

  it('buckets missing context/agent under "unknown" without throwing', () => {
    const counts = computeAgentCounts([{ status: 'running' }]);
    expect(counts.running).toBe(1);
    expect(counts.byContext).toEqual({ unknown: 1 });
    expect(counts.byAgent).toEqual({ unknown: 1 });
  });
});

describe('fleet-status mirror — publish-own / union read', () => {
  let dir: string;
  let prev: string | null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-fleet-status-'));
    prev = setFleetStatusMirrorPathForTest(path.join(dir, '.fleet-status.json'));
  });

  afterEach(() => {
    setFleetStatusMirrorPathForTest(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('unions rows from multiple hosts, preserving the ones it did not write', () => {
    const rowA: FleetStatusRow = {
      host: 'zion', agents: { running: 2, live: 3, byContext: { terminal: 2 }, byAgent: { claude: 2 } },
      stats: null, capturedAt: 1,
    };
    const rowB: FleetStatusRow = {
      host: 'mac-mini', agents: { running: 0, live: 0, byContext: {}, byAgent: {} },
      stats: null, capturedAt: 2,
    };
    writeFleetStatusRows({ zion: rowA });
    writeFleetStatusRows({ 'mac-mini': rowB });
    const mirror = readFleetStatus();
    expect(Object.keys(mirror).sort()).toEqual(['mac-mini', 'zion']);
    expect(mirror.zion.agents.running).toBe(2);
  });

  it('reads an empty map when the mirror is absent', () => {
    expect(readFleetStatus()).toEqual({});
  });
});

describe('probeLocalFleetStatus — this host, no ssh, carries a running-agent count', () => {
  let dir: string;
  let prev: string | null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-fleet-status-probe-'));
    prev = setFleetStatusMirrorPathForTest(path.join(dir, '.fleet-status.json'));
  });
  afterEach(() => {
    setFleetStatusMirrorPathForTest(prev);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns a row with a numeric running-agent count (the RUSH-2061 enrichment)', async () => {
    const row = await probeLocalFleetStatus('zion', 12345);
    expect(row.host).toBe('zion');
    expect(row.capturedAt).toBe(12345);
    expect(typeof row.agents.running).toBe('number');
    expect(row.agents.running).toBeGreaterThanOrEqual(0);
    expect(row.agents.live).toBeGreaterThanOrEqual(row.agents.running);
  });
});
