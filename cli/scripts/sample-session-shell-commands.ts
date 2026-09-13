#!/usr/bin/env bun
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { isDialableDevice, type DeviceProfile } from '../src/lib/devices/registry.js';
import type { ToolSearchEnvelope, ToolSessionEvidence } from '../src/lib/session/tool-index.js';
import { machineId, normalizeHost } from '../src/lib/session/sync/config.js';

interface SampleOptions {
  sessions: number;
  since: string;
  devices: string[];
  passes: number;
  output?: string;
}

export const SAMPLE_MAX_SERIALIZED_BYTES = 16 * 1024 * 1024;
const SAMPLE_PROJECTED_SESSION_BYTES = SAMPLE_MAX_SERIALIZED_BYTES - 1024 * 1024;
const SAMPLE_CANDIDATE_SESSION_MULTIPLIER = 2;

interface SampleEnvelope extends ToolSearchEnvelope {
  sampleTruncated?: boolean;
  failedQueries?: number;
  failedSources?: number;
  failedSessions?: number;
}

export function parseSampleOptions(argv: string[]): SampleOptions {
  const options: SampleOptions = { sessions: 100, since: '7d', devices: [], passes: 4 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--sessions' && value) {
      options.sessions = Number(value);
      i++;
    } else if (arg === '--since' && value) {
      options.since = value;
      i++;
    } else if (arg === '--device' && value) {
      options.devices.push(value);
      i++;
    } else if (arg === '--passes' && value) {
      options.passes = Number(value);
      i++;
    } else if (arg === '--output' && value) {
      options.output = value;
      i++;
    } else if (arg === '--help') {
      process.stdout.write([
        'Sample redacted shell commands from recent agent sessions.',
        '',
        'Usage: bun scripts/sample-session-shell-commands.ts [options]',
        '  --sessions <50-100>  Number of sessions to sample (default: 100)',
        '  --since <time>        Recency window (default: 7d)',
        '  --device <name>       Query only this device; repeatable',
        '  --passes <n>          Bounded cache passes before sampling (default: 4)',
        '  --output <path>       Write JSON to a file instead of stdout',
        '',
        'Output is redacted and capped at 16 MiB; truncation is recorded in the JSON.',
      ].join('\n') + '\n');
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete option: ${arg}`);
    }
  }
  if (!Number.isInteger(options.sessions) || options.sessions < 50 || options.sessions > 100) {
    throw new Error('--sessions must be an integer from 50 to 100');
  }
  if (!Number.isInteger(options.passes) || options.passes < 1 || options.passes > 20) {
    throw new Error('--passes must be an integer from 1 to 20');
  }
  return options;
}

function sampleKey(session: ToolSessionEvidence): string {
  return createHash('sha256')
    .update(`${session.machine ?? 'local'}\0${session.id}`)
    .digest('hex');
}

/** Stable round-robin sampling keeps every available machine represented. */
export function deterministicSessionSample(
  sessions: ToolSessionEvidence[],
  count: number,
): ToolSessionEvidence[] {
  const byMachine = new Map<string, ToolSessionEvidence[]>();
  for (const session of sessions) {
    const machine = normalizeHost(session.machine ?? 'local');
    const group = byMachine.get(machine) ?? [];
    group.push(session);
    byMachine.set(machine, group);
  }
  const groups = [...byMachine.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => group.sort((a, b) => sampleKey(a).localeCompare(sampleKey(b))));
  const sampled: ToolSessionEvidence[] = [];
  for (let round = 0; sampled.length < count; round++) {
    let advanced = false;
    for (const group of groups) {
      const session = group[round];
      if (!session) continue;
      sampled.push(session);
      advanced = true;
      if (sampled.length === count) break;
    }
    if (!advanced) break;
  }
  return sampled;
}

export function runAgents(args: string[]): string {
  const run = spawnSync('agents', args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  if (run.status !== 0) {
    throw new Error((run.stderr || run.stdout || `agents exited ${run.status}`).trim());
  }
  return run.stdout;
}

export function automaticSampleDevices(devices: DeviceProfile[]): string[] {
  return devices
    .filter((device) => isDialableDevice(device)
      && ['linux', 'macos', 'windows'].includes(device.platform))
    .map((device) => device.name);
}

function defaultDevices(): string[] {
  return automaticSampleDevices(
    JSON.parse(runAgents(['devices', 'list', '--json', '--no-stats'])) as DeviceProfile[],
  );
}

export function partitionSampleDevices(
  devices: string[],
  self: string,
  explicit: boolean,
): { includeLocal: boolean; remoteDevices: string[] } {
  const normalizedSelf = normalizeHost(self);
  const normalized = [...new Map(devices.map((device) => [normalizeHost(device), device])).entries()];
  return {
    includeLocal: !explicit || normalized.some(([device]) => device === normalizedSelf),
    remoteDevices: normalized.filter(([device]) => device !== normalizedSelf).map(([, original]) => original),
  };
}

const SHELL_CANDIDATE_QUERIES = ['tool:exec', 'tool:command', 'tool:shell', 'tool:bash'];

/** Avoid asking a broad candidate class for an unbounded session set. */
export function candidateQueryLimit(requestedSessions: number): number {
  return requestedSessions * SAMPLE_CANDIDATE_SESSION_MULTIPLIER;
}

function toolQueryArgs(options: SampleOptions, devices: string[], local: boolean, query: string): string[] {
  const args = [
    'sessions', '--include', 'tools', '--since', options.since,
    '--query', query,
    '--limit', String(candidateQueryLimit(options.sessions)), '--all', '--json', '--no-interactive',
  ];
  if (local) args.push('--local');
  else for (const device of devices) args.push('--device', device);
  return args;
}

function toolBackfillArgs(options: SampleOptions, devices: string[], local: boolean): string[] {
  const args = ['sessions', 'backfill', 'tools', '--since', options.since, '--json'];
  if (local) args.push('--local');
  else for (const device of devices) args.push('--device', device);
  return args;
}

interface QuerySourceResult {
  envelope?: ToolSearchEnvelope;
  failed: boolean;
}

function querySource(args: string[], passes: number): QuerySourceResult {
  let envelope: ToolSearchEnvelope | undefined;
  for (let pass = 0; pass < passes; pass++) {
    try {
      const next = JSON.parse(runAgents(args)) as ToolSearchEnvelope;
      if (next.schemaVersion !== 1) throw new Error(`Unsupported tool-search schema ${next.schemaVersion}`);
      envelope = next;
    } catch {
      if (envelope) envelope = { ...envelope, coverage: { ...envelope.coverage, complete: false } };
      return { envelope, failed: true };
    }
    if (envelope.coverage.complete || envelope.coverage.remainingFiles === 0) break;
  }
  return { envelope, failed: false };
}

function failedCandidateQueryEnvelope(failedQueries: number): SampleEnvelope {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    query: { clauses: [] },
    coverage: {
      indexedFiles: 0,
      indexedCalls: 0,
      skippedFiles: 0,
      limitedFiles: 0,
      remainingFiles: 0,
      complete: false,
    },
    sessions: [],
    failedQueries,
    failedSources: 1,
  };
}

function queryScopeCandidates(
  options: SampleOptions,
  devices: string[],
  local: boolean,
): SampleEnvelope {
  const firstArgs = toolQueryArgs(options, devices, local, SHELL_CANDIDATE_QUERIES[0]);
  const envelopes: ToolSearchEnvelope[] = [];
  let failedQueries = 0;
  const first = querySource(firstArgs, options.passes);
  if (first.failed) failedQueries++;
  if (first.envelope) envelopes.push(first.envelope);
  for (const query of SHELL_CANDIDATE_QUERIES.slice(1)) {
    const result = querySource(toolQueryArgs(options, devices, local, query), 1);
    if (result.failed) failedQueries++;
    if (result.envelope) envelopes.push(result.envelope);
  }
  if (envelopes.length === 0) {
    return failedCandidateQueryEnvelope(failedQueries);
  }
  const merged = mergeCandidateQueryEnvelopes(envelopes, failedQueries);
  return { ...merged, failedQueries };
}

export function mergeCandidateQueryEnvelopes(
  envelopes: ToolSearchEnvelope[],
  failedQueries = 0,
): ToolSearchEnvelope {
  const sessions = new Map<string, ToolSessionEvidence>();
  for (const envelope of envelopes) {
    for (const session of envelope.sessions) {
      sessions.set(`${normalizeHost(session.machine ?? 'local')}\0${session.id}`, session);
    }
  }
  const finalEnvelope = envelopes.at(-1);
  if (!finalEnvelope) throw new Error('At least one candidate query is required');
  return {
    ...finalEnvelope,
    query: { clauses: [] },
    coverage: {
      ...finalEnvelope.coverage,
      skippedFiles: Math.max(...envelopes.map((envelope) => envelope.coverage.skippedFiles)),
      limitedFiles: Math.max(...envelopes.map((envelope) => envelope.coverage.limitedFiles)),
      remainingFiles: Math.max(...envelopes.map((envelope) => envelope.coverage.remainingFiles)),
      complete: failedQueries === 0 && envelopes.every((envelope) => envelope.coverage.complete),
    },
    sessions: [...sessions.values()],
  };
}

export function exactSampleTargetArgs(candidateMachine: string | undefined, self: string): string[] {
  if (candidateMachine && normalizeHost(candidateMachine) !== normalizeHost(self)) {
    return ['--device', candidateMachine];
  }
  return ['--local'];
}

export function mergeSampleEnvelopes(envelopes: ToolSearchEnvelope[]): ToolSearchEnvelope {
  const sessions = new Map<string, ToolSessionEvidence>();
  for (const envelope of envelopes) {
    for (const session of envelope.sessions) {
      sessions.set(`${normalizeHost(session.machine ?? 'local')}\0${session.id}`, session);
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    query: { clauses: [] },
    coverage: {
      indexedFiles: envelopes.reduce((total, envelope) => total + envelope.coverage.indexedFiles, 0),
      indexedCalls: envelopes.reduce((total, envelope) => total + envelope.coverage.indexedCalls, 0),
      skippedFiles: envelopes.reduce((total, envelope) => total + envelope.coverage.skippedFiles, 0),
      limitedFiles: envelopes.reduce((total, envelope) => total + envelope.coverage.limitedFiles, 0),
      remainingFiles: envelopes.reduce((total, envelope) => total + envelope.coverage.remainingFiles, 0),
      complete: envelopes.every((envelope) => envelope.coverage.complete),
    },
    sessions: [...sessions.values()],
  };
}

export function evaluateExactSample(
  envelope: ToolSearchEnvelope,
  sessionId: string,
  aggregate: ToolSearchEnvelope['coverage'],
): { coverage: ToolSearchEnvelope['coverage']; hit?: ToolSessionEvidence; failed: boolean } {
  const hit = envelope.sessions.find((session) => session.id === sessionId);
  return {
    coverage: {
      ...aggregate,
      indexedFiles: Math.max(aggregate.indexedFiles, envelope.coverage.indexedFiles),
      indexedCalls: Math.max(aggregate.indexedCalls, envelope.coverage.indexedCalls),
      skippedFiles: Math.max(aggregate.skippedFiles, envelope.coverage.skippedFiles),
      limitedFiles: Math.max(aggregate.limitedFiles, envelope.coverage.limitedFiles),
      remainingFiles: Math.max(aggregate.remainingFiles, envelope.coverage.remainingFiles),
      complete: aggregate.complete && envelope.coverage.complete && hit !== undefined,
    },
    hit,
    failed: !envelope.coverage.complete || hit === undefined,
  };
}

export function loadEnvelope(
  options: SampleOptions,
  self: string = machineId(),
): ToolSearchEnvelope {
  const explicit = options.devices.length > 0;
  const devices = explicit ? options.devices : defaultDevices();
  const { includeLocal, remoteDevices } = partitionSampleDevices(devices, self, explicit);
  const envelopes: ToolSearchEnvelope[] = [];
  let failedQueries = 0;
  let failedSources = 0;
  const sources = [
    ...(includeLocal ? [{ devices: [] as string[], local: true }] : []),
    ...(remoteDevices.length > 0 ? [{ devices: remoteDevices, local: false }] : []),
  ];
  for (const source of sources) {
    try {
      runAgents(toolBackfillArgs(options, source.devices, source.local));
    } catch {
      failedSources++;
    }
    try {
      const envelope = queryScopeCandidates(options, source.devices, source.local);
      failedQueries += envelope.failedQueries ?? 0;
      failedSources += envelope.failedSources ?? 0;
      envelopes.push(envelope);
    } catch {
      failedSources++;
    }
  }
  const merged = mergeSampleEnvelopes(envelopes);
  if (failedSources > 0) {
    merged.coverage.complete = false;
  }
  const candidates = deterministicSessionSample(merged.sessions, merged.sessions.length);
  const sessions: ToolSessionEvidence[] = [];
  let retainedBytes = 0;
  let sampleTruncated = false;
  let failedSessions = 0;

  for (const candidate of candidates) {
    if (sessions.length >= options.sessions) break;
    const args = [
      'sessions', candidate.id, '--include', 'tools', '--all', '--limit', '1',
      '--json', '--no-interactive', ...exactSampleTargetArgs(candidate.machine, self),
    ];
    const result = querySource(args, options.passes);
    if (result.failed) {
      failedSessions++;
      merged.coverage.complete = false;
    }
    const exact = result.envelope;
    if (!exact) {
      if (!result.failed) failedSessions++;
      continue;
    }
    const evaluated = evaluateExactSample(exact, candidate.id, merged.coverage);
    merged.coverage = evaluated.coverage;
    if (evaluated.failed && !result.failed) failedSessions++;
    const hit = evaluated.hit;
    if (!hit) continue;
    const shellCalls = hit.calls.filter((call) => call.programs.length > 0).map((call) => ({
      id: call.id,
      ordinal: call.ordinal,
      timestamp: call.timestamp,
      tool: call.tool,
      programs: call.programs,
      input: call.input,
      outcome: call.outcome,
      parseError: call.parseError,
    }));
    if (shellCalls.length === 0) continue;
    const projected: ToolSessionEvidence = {
      id: hit.id,
      shortId: hit.shortId,
      agent: hit.agent,
      machine: hit.machine,
      timestamp: hit.timestamp,
      calls: shellCalls,
    };
    const projectedBytes = Buffer.byteLength(JSON.stringify(projected));
    if (retainedBytes + projectedBytes > SAMPLE_PROJECTED_SESSION_BYTES) {
      merged.coverage.complete = false;
      sampleTruncated = true;
      break;
    }
    retainedBytes += projectedBytes;
    sessions.push(projected);
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    query: { clauses: [] },
    coverage: merged.coverage,
    sessions,
    sampleTruncated,
    failedQueries,
    failedSources,
    failedSessions,
  } as SampleEnvelope;
}

export function buildSample(envelope: ToolSearchEnvelope, count: number) {
  const candidates = deterministicSessionSample(
    envelope.sessions.filter((session) => session.calls.some((call) => call.programs.length > 0)),
    count,
  );
  const sessions: Array<{
    id: string;
    machine?: string;
    agent: string;
    timestamp: string;
    commands: Array<{
      callId: string;
      tool: string;
      programs: string[];
      input: string;
      outcome: string;
      parseError?: string;
    }>;
  }> = [];
  let projectedBytes = 0;
  let truncated = (envelope as SampleEnvelope).sampleTruncated === true;
  for (const session of candidates) {
    const projected = {
      id: session.id,
      machine: session.machine,
      agent: session.agent,
      timestamp: session.timestamp,
      commands: session.calls
        .filter((call) => call.programs.length > 0)
        .map((call) => ({
          callId: call.id,
          tool: call.tool,
          programs: call.programs,
          input: call.input,
          outcome: call.outcome,
          parseError: call.parseError,
        })),
    };
    const bytes = Buffer.byteLength(JSON.stringify(projected));
    if (projectedBytes + bytes > SAMPLE_PROJECTED_SESSION_BYTES) {
      truncated = true;
      break;
    }
    projectedBytes += bytes;
    sessions.push(projected);
  }
  const coverage = { ...envelope.coverage, complete: envelope.coverage.complete && !truncated };
  const sample = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    requestedSessions: count,
    sampledSessions: sessions.length,
    failedQueries: (envelope as SampleEnvelope).failedQueries ?? 0,
    failedSources: (envelope as SampleEnvelope).failedSources ?? 0,
    failedSessions: (envelope as SampleEnvelope).failedSessions ?? 0,
    coverage,
    truncation: truncated
      ? { reason: 'sample_byte_limit', maxBytes: SAMPLE_MAX_SERIALIZED_BYTES }
      : undefined,
    sessions,
  };
  while (sessions.length > 0 && Buffer.byteLength(JSON.stringify(sample, null, 2) + '\n') > SAMPLE_MAX_SERIALIZED_BYTES) {
    sessions.pop();
    sample.sampledSessions = sessions.length;
    sample.coverage.complete = false;
    sample.truncation = { reason: 'sample_byte_limit', maxBytes: SAMPLE_MAX_SERIALIZED_BYTES };
  }
  return sample;
}

if (import.meta.main) {
  try {
    const options = parseSampleOptions(process.argv.slice(2));
    const output = JSON.stringify(buildSample(loadEnvelope(options), options.sessions), null, 2) + '\n';
    if (options.output) fs.writeFileSync(options.output, output, { mode: 0o600 });
    else process.stdout.write(output);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
