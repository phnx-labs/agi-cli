
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getPerfSpoolPath } from '../state.js';
import { localMachineId } from '../origin-machine.js';
import type { PerfSample } from './types.js';

export type { PerfSample } from './types.js';

let _spoolOverride: string | null = null;
let _disabled = false;

export function _resetPerfSpoolForTest(spoolPath?: string | null): void {
  _spoolOverride = spoolPath === undefined ? null : spoolPath;
  _disabled = false;
}

export function resolveSpoolPath(): string {
  if (process.env.AGENTS_PERF_SPOOL) return process.env.AGENTS_PERF_SPOOL;
  if (_spoolOverride) return _spoolOverride;
  return getPerfSpoolPath();
}

function isDisabled(): boolean {
  if (_disabled) return true;
  const v = process.env.AGENTS_DISABLE_PERF;
  return v === '1' || v === 'true';
}

export function shortSessionId(sessionId: string | undefined | null): string | undefined {
  if (!sessionId) return undefined;
  const cleaned = sessionId.replace(/^session_/, '');
  return cleaned.length >= 8 ? cleaned.slice(0, 8) : cleaned || undefined;
}

export function recordSample(sample: PerfSample): void {
  if (isDisabled()) return;
  if (!sample.label || !Number.isFinite(sample.durationMs)) return;
  try {
    const tsMs = sample.tsMs ?? Date.now();
    const sessionId = sample.sessionId;
    const sessionShort = sample.sessionShort ?? shortSessionId(sessionId);
    const machine = sample.machine ?? localMachineId();
    const hostname = sample.hostname ?? os.hostname();
    const line = JSON.stringify({
      ts_ms: tsMs,
      kind: sample.kind,
      label: sample.label,
      duration_ms: sample.durationMs,
      session_id: sessionId,
      session_short: sessionShort,
      agent: sample.agent,
      agent_version: sample.agentVersion,
      machine,
      hostname,
      actor: sample.actor,
      cwd: sample.cwd,
      cache: sample.cache,
      exit_code: sample.exitCode,
      status: sample.status,
      meta_json: sample.metaJson,
    });
    const spool = resolveSpoolPath();
    fs.mkdirSync(path.dirname(spool), { recursive: true, mode: 0o700 });
    fs.appendFileSync(spool, line + '\n', { mode: 0o600 });
  } catch {
  }
}
