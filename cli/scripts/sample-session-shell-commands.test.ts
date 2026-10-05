import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  automaticSampleDevices,
  buildSample,
  candidateQueryLimit,
  deterministicSessionSample,
  exactSampleTargetArgs,
  evaluateExactSample,
  loadEnvelope,
  mergeCandidateQueryEnvelopes,
  mergeSampleEnvelopes,
  parseSampleOptions,
  partitionSampleDevices,
  runAgents,
  SAMPLE_MAX_SERIALIZED_BYTES,
} from './sample-session-shell-commands.js';
import type { DeviceProfile } from '../src/lib/devices/registry.js';
import type { ToolSearchEnvelope, ToolSessionEvidence } from '../src/lib/session/tool-index.js';

function session(id: string, machine: string): ToolSessionEvidence {
  return {
    id, shortId: id, machine, agent: 'codex', timestamp: '2026-08-03T00:00:00Z',
    filePath: `/${machine}/${id}.jsonl`, calls: [{
      id: `${id}-call`, ordinal: 0, timestamp: '2026-08-03T00:00:01Z',
      tool: 'exec_command', programs: ['git'], input: 'git status', outcome: 'unknown',
    }],
  };
}

function device(name: string, overrides: Partial<DeviceProfile> = {}): DeviceProfile {
  return {
    name,
    platform: 'linux',
    shell: 'posix',
    address: { via: 'manual', dnsName: `${name}.example` },
    auth: { method: 'key' },
    createdAt: '2026-08-03T00:00:00Z',
    updatedAt: '2026-08-03T00:00:00Z',
    ...overrides,
  };
}

describe('session shell-command sampler', () => {
  it('bounds each candidate query below the aggregate evidence ceiling', () => {
    expect(candidateQueryLimit(50)).toBe(100);
    expect(candidateQueryLimit(100)).toBe(200);
  });

  it('validates the requested 50-100 session range and repeatable devices', () => {
    expect(parseSampleOptions(['--sessions', '75', '--since', '5d', '--device', 'a', '--device', 'b']))
      .toMatchObject({ sessions: 75, since: '5d', devices: ['a', 'b'] });
    expect(parseSampleOptions(['--output', '/tmp/sample.json'])).toMatchObject({ output: '/tmp/sample.json' });
    expect(() => parseSampleOptions(['--sessions', '49'])).toThrow('50 to 100');
    expect(() => parseSampleOptions(['--sessions', '101'])).toThrow('50 to 100');
  });

  it('selects a stable cross-device sample and keeps bounded command origins', () => {
    const sessions = [session('a', 'box-1'), session('b', 'box-2'), session('c', 'box-1')];
    expect(deterministicSessionSample(sessions, 2).map((item) => item.id))
      .toEqual(deterministicSessionSample([...sessions].reverse(), 2).map((item) => item.id));
    expect(new Set(deterministicSessionSample(sessions, 2).map((item) => item.machine)))
      .toEqual(new Set(['box-1', 'box-2']));
    const skewed = [
      ...Array.from({ length: 100 }, (_, index) => session(`local-${index}`, 'box-1')),
      session('only-peer', 'box-2'),
    ];
    expect(deterministicSessionSample(skewed, 10).some((item) => item.machine === 'box-2')).toBe(true);
    const envelope: ToolSearchEnvelope = {
      schemaVersion: 1, generatedAt: '2026-08-03T00:00:00Z', query: { clauses: [] },
      coverage: { indexedFiles: 0, indexedCalls: 0, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
      sessions,
    };
    const sample = buildSample(envelope, 2);
    expect(sample.sampledSessions).toBe(2);
    expect(sample.sessions.every((item) => item.commands[0].input === 'git status')).toBe(true);
  });

  it('reads the current device locally and sends only peers through device fan-out', () => {
    expect(partitionSampleDevices(['yosemite-s1', 'yosemite-m3'], 'yosemite-s1', false)).toEqual({
      includeLocal: true,
      remoteDevices: ['yosemite-m3'],
    });
    expect(partitionSampleDevices(['yosemite-m3'], 'yosemite-s1', true)).toEqual({
      includeLocal: false,
      remoteDevices: ['yosemite-m3'],
    });
    expect(partitionSampleDevices(['YOSEMITE-S1'], 'yosemite-s1', true)).toEqual({
      includeLocal: true,
      remoteDevices: [],
    });
    expect(exactSampleTargetArgs('yosemite-s1', 'yosemite-s1')).toEqual(['--local']);
    expect(exactSampleTargetArgs('YOSEMITE-S1', 'yosemite-s1')).toEqual(['--local']);
    expect(exactSampleTargetArgs('yosemite-m3', 'yosemite-s1')).toEqual(['--device', 'yosemite-m3']);
  });

  it('uses canonical dialability and compute roles for default fleet sampling', () => {
    expect(automaticSampleDevices([
      device('manual'),
      device('probe-reachable', {
        tailscale: { online: false, direct: false },
        reachability: { reachable: true, checkedAt: '2026-08-03T00:00:00Z' },
      }),
      device('offline', { tailscale: { online: false, direct: false } }),
      device('phone', { platform: 'unknown' }),
    ])).toEqual(['manual', 'probe-reachable']);
  });

  it.skipIf(process.platform === 'win32')('spawns the production CLI path for candidate and exact local queries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sampler-spawn-'));
    const binDir = path.join(root, 'bin');
    const sessionsDir = path.join(root, '.codex', 'sessions');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(path.join(root, '.agents', '.system', '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', 'agents.yaml'), 'agents: {}\n');
    const cliEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.ts');
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(binDir, 'agents.cmd'), `@echo off\r\nbun "${cliEntry}" %*\r\n`);
    } else {
      fs.writeFileSync(path.join(binDir, 'agents'), `#!/bin/sh\nexec bun "${cliEntry}" "$@"\n`, { mode: 0o755 });
    }
    const id = 'real-sampler-spawn';
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(sessionsDir, `rollout-${id}.jsonl`), [
      JSON.stringify({ type: 'session_meta', timestamp: now, payload: { id, timestamp: now, cwd: '/repo' } }),
      JSON.stringify({ type: 'response_item', timestamp: now, payload: {
        type: 'function_call', name: 'exec_command', call_id: 'real-call', arguments: JSON.stringify({ cmd: 'git status' }),
      } }),
    ].join('\n') + '\n');

    const previous = {
      home: process.env.HOME,
      userprofile: process.env.USERPROFILE,
      path: process.env.PATH,
      machine: process.env.AGENTS_SYNC_MACHINE_ID,
      noUpdate: process.env.AGENTS_NO_UPDATE_CHECK,
      noUsage: process.env.AGENTS_NO_USAGE_TRACK,
    };
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    process.env.PATH = `${binDir}${path.delimiter}${previous.path ?? ''}`;
    process.env.AGENTS_SYNC_MACHINE_ID = 'fixture-host';
    process.env.AGENTS_NO_UPDATE_CHECK = '1';
    process.env.AGENTS_NO_USAGE_TRACK = '1';
    try {
      expect(runAgents(['--version']).trim()).toMatch(/^\d+\.\d+\.\d+$/);
      const backfill = JSON.parse(runAgents([
        'sessions', 'backfill', 'tools', '--since', '7d', '--json', '--local',
      ])) as { complete: boolean };
      expect(backfill.complete).toBe(true);
      const direct = JSON.parse(runAgents([
        'sessions', '--include', 'tools', '--since', '7d', '--query', 'tool:exec',
        '--limit', '500', '--all', '--json', '--no-interactive', '--local',
      ])) as ToolSearchEnvelope;
      expect(direct.sessions).toHaveLength(1);
      const unresolved = JSON.parse(runAgents([
        'sessions', '--include', 'tools', '--since', '7d', '--query', 'tool:exec',
        '--limit', '500', '--all', '--json', '--no-interactive', '--device', 'unregistered-peer',
      ])) as ToolSearchEnvelope;
      expect(unresolved.coverage.complete).toBe(false);
      expect(evaluateExactSample(unresolved, id, direct.coverage)).toMatchObject({
        coverage: { complete: false }, hit: undefined, failed: true,
      });
      const envelope = loadEnvelope(
        { sessions: 50, since: '7d', devices: ['fixture-host', 'unregistered-peer'], passes: 1 },
        'fixture-host',
      );
      expect(envelope.sessions, JSON.stringify(envelope, null, 2)).toHaveLength(1);
      expect(envelope.sessions[0].calls).toMatchObject([{ programs: ['git'], input: 'git status' }]);
      expect(envelope, JSON.stringify(envelope, null, 2)).toMatchObject({
        coverage: { complete: false }, failedSources: 0, failedSessions: 0,
      });

      for (let fileIndex = 0; fileIndex < 26; fileIndex++) {
        const isExecCandidate = fileIndex % 5 === 0;
        const sessionId = isExecCandidate
          ? `retained-exec-result-${fileIndex}`
          : `non-shell-backfill-${fileIndex}`;
        fs.writeFileSync(path.join(sessionsDir, `rollout-${sessionId}.jsonl`), [
          JSON.stringify({ type: 'session_meta', timestamp: now, payload: { id: sessionId, timestamp: now, cwd: '/repo' } }),
          JSON.stringify({ type: 'response_item', timestamp: now, payload: {
            type: 'function_call', name: isExecCandidate ? 'exec_command' : 'read_file', call_id: `filler-${fileIndex}`,
            arguments: JSON.stringify(isExecCandidate
              ? { cmd: `git diff -- file-${fileIndex}.txt` }
              : { path: `/repo/${fileIndex}.txt` }),
          } }),
        ].join('\n') + '\n');
      }

      const counterPath = path.join(root, 'agents-driver-count');
      const driverPath = path.join(root, 'agents-driver.mjs');
      fs.writeFileSync(driverPath, [
        "import fs from 'fs';",
        "import { spawnSync } from 'child_process';",
        `const counterPath = ${JSON.stringify(counterPath)};`,
        `const cliEntry = ${JSON.stringify(cliEntry)};`,
        "let count = 0;",
        "try { count = Number.parseInt(fs.readFileSync(counterPath, 'utf8'), 10) || 0; } catch {}",
        "count += 1;",
        "fs.writeFileSync(counterPath, String(count));",
        "if (count >= 3 && count <= 6) process.exit(1);",
        "const child = spawnSync('bun', [cliEntry, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });",
        "process.exit(Number.isInteger(child.status) ? child.status : 1);",
      ].join('\n') + '\n');
      if (process.platform === 'win32') {
        fs.writeFileSync(path.join(binDir, 'agents.cmd'), `@echo off\r\nnode "${driverPath}" %*\r\n`);
      } else {
        fs.writeFileSync(path.join(binDir, 'agents'), `#!/bin/sh\nexec node "${driverPath}" "$@"\n`, { mode: 0o755 });
      }

      const partial = loadEnvelope(
        { sessions: 50, since: '7d', devices: ['fixture-host'], passes: 2 },
        'fixture-host',
      ) as ToolSearchEnvelope & { failedQueries: number; failedSources: number };
      expect(partial.failedQueries).toBeGreaterThan(0);
      expect(partial.failedSources).toBe(0);
      expect(partial.coverage.complete).toBe(false);
      expect(partial.sessions.some((item) => item.id.startsWith('retained-exec-result-'))).toBe(true);

      fs.writeFileSync(counterPath, '1');
      const allQueriesFailed = loadEnvelope(
        { sessions: 50, since: '7d', devices: ['fixture-host'], passes: 1 },
        'fixture-host',
      ) as ToolSearchEnvelope & { failedQueries: number; failedSources: number };
      expect(allQueriesFailed).toMatchObject({
        failedQueries: 4,
        failedSources: 1,
        coverage: { complete: false },
        sessions: [],
      });
    } finally {
      if (previous.home === undefined) delete process.env.HOME; else process.env.HOME = previous.home;
      if (previous.userprofile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previous.userprofile;
      if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path;
      if (previous.machine === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID; else process.env.AGENTS_SYNC_MACHINE_ID = previous.machine;
      if (previous.noUpdate === undefined) delete process.env.AGENTS_NO_UPDATE_CHECK; else process.env.AGENTS_NO_UPDATE_CHECK = previous.noUpdate;
      if (previous.noUsage === undefined) delete process.env.AGENTS_NO_USAGE_TRACK; else process.env.AGENTS_NO_USAGE_TRACK = previous.noUsage;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('deduplicates bulk results from normalized machine names', () => {
    const first: ToolSearchEnvelope = {
      schemaVersion: 1, generatedAt: '2026-08-03T00:00:00Z', query: { clauses: [] },
      coverage: { indexedFiles: 1, indexedCalls: 1, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
      sessions: [session('same', 'YOSEMITE-S1')],
    };
    const second: ToolSearchEnvelope = {
      ...first,
      sessions: [session('same', 'yosemite-s1')],
    };
    expect(mergeSampleEnvelopes([first, second]).sessions).toHaveLength(1);
  });

  it('keeps candidate coverage partial when an earlier query ran before backfill completed', () => {
    const partial: ToolSearchEnvelope = {
      schemaVersion: 1, generatedAt: '2026-08-03T00:00:00Z', query: { clauses: ['tool:exec'] },
      coverage: { indexedFiles: 1, indexedCalls: 1, skippedFiles: 0, limitedFiles: 0, remainingFiles: 2, complete: false },
      sessions: [session('exec-before-backfill', 'box-1')],
    };
    const complete: ToolSearchEnvelope = {
      schemaVersion: 1, generatedAt: '2026-08-03T00:01:00Z', query: { clauses: ['tool:bash'] },
      coverage: { indexedFiles: 3, indexedCalls: 3, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
      sessions: [session('bash-after-backfill', 'box-1')],
    };

    const merged = mergeCandidateQueryEnvelopes([partial, complete]);
    expect(merged.sessions.map((item) => item.id)).toEqual(['exec-before-backfill', 'bash-after-backfill']);
    expect(merged.coverage).toMatchObject({ indexedFiles: 3, remainingFiles: 2, complete: false });
  });

  it('retains successful candidate classes and reports a failed class as partial coverage', () => {
    const complete: ToolSearchEnvelope = {
      schemaVersion: 1, generatedAt: '2026-08-03T00:01:00Z', query: { clauses: ['tool:exec'] },
      coverage: { indexedFiles: 3, indexedCalls: 3, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
      sessions: [session('exec-result', 'box-1')],
    };

    const merged = mergeCandidateQueryEnvelopes([complete], 1);
    expect(merged.sessions.map((item) => item.id)).toEqual(['exec-result']);
    expect(merged.coverage).toMatchObject({ remainingFiles: 0, complete: false });
  });

  it('caps the serialized artifact even when every sampled session carries maximum-size inputs', () => {
    const sessions = Array.from({ length: 50 }, (_, sessionIndex) => {
      const item = session(`large-${sessionIndex}`, `box-${sessionIndex % 2}`);
      item.calls = Array.from({ length: 24 }, (_, callIndex) => ({
        ...item.calls[0],
        id: `${item.id}-call-${callIndex}`,
        ordinal: callIndex,
        input: `${sessionIndex}:${callIndex}:` + 'x'.repeat(16 * 1024),
      }));
      return item;
    });
    const envelope: ToolSearchEnvelope = {
      schemaVersion: 1,
      generatedAt: '2026-08-03T00:00:00Z',
      query: { clauses: [] },
      coverage: { indexedFiles: 50, indexedCalls: 1_200, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
      sessions,
    };

    const sample = buildSample(envelope, 50);
    const bytes = Buffer.byteLength(JSON.stringify(sample, null, 2) + '\n');
    expect(bytes).toBeLessThanOrEqual(SAMPLE_MAX_SERIALIZED_BYTES);
    expect(sample.sampledSessions).toBeLessThan(50);
    expect(sample.coverage.complete).toBe(false);
    expect(sample.truncation).toEqual({ reason: 'sample_byte_limit', maxBytes: SAMPLE_MAX_SERIALIZED_BYTES });
  });
});
