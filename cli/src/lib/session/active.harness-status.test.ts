import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearLiveSignalsCacheForTest, computeLiveSignals } from './active.js';

// A real Claude turn captured on yosemite-m6 (PHNX-4387): the transcript went
// silent while Claude streamed one long Write call, and Claude Code's record for
// the process said `busy` throughout. The record is rewritten for this test
// process so the reader's liveness check passes against a real live pid.
const FIXTURE = path.join(import.meta.dirname, 'testdata', 'harness-status', 'busy');
const SLUG = '-tmp-phnx4387-silent';
const SESSION = 'ed7688d4-ca54-4747-8005-d59cfdbbf318';
const record = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'sessions', '160908.json'), 'utf8'));
const LAST_EVENT_MS = Date.parse('2026-10-14T19:19:23.484Z');
// Seen live: 132 s after the last event the released build said idle.
const SILENT_NOW = Date.parse('2026-10-14T19:21:35.906Z');
const tmp: string[] = [];

function ownStartTicks(): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
}

function configWith(status?: string): string {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-harness-status-'));
  tmp.push(config);
  const projects = path.join(config, 'projects', SLUG);
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(path.join(config, 'sessions'));
  const transcript = path.join(projects, `${SESSION}.jsonl`);
  fs.copyFileSync(path.join(FIXTURE, 'projects', SLUG, `${SESSION}.jsonl`), transcript);
  if (status) {
    const live = { ...record, status, pid: process.pid, procStart: ownStartTicks(), startedAt: Date.now() - 1000 };
    fs.writeFileSync(path.join(config, 'sessions', `${process.pid}.json`), JSON.stringify(live));
  }
  return transcript;
}

// The reader trusts a record only on Linux (start ticks) and macOS (started since boot).
describe.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('computeLiveSignals reads the turn state Claude Code reports', () => {
  beforeEach(() => clearLiveSignalsCacheForTest());
  afterAll(() => {
    for (const dir of tmp) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a turn silent for over two minutes is idle without a report and working on busy, with quietMs', () => {
    const bare = configWith();
    expect(computeLiveSignals('claude', bare, '/tmp/phnx4387-silent', true, SILENT_NOW).state!.activity).toBe('idle');

    const busy = configWith('busy');
    const { state } = computeLiveSignals('claude', busy, '/tmp/phnx4387-silent', true, SILENT_NOW);
    expect(state!.activity).toBe('working');
    expect(state!.quietMs).toBe(SILENT_NOW - LAST_EVENT_MS);
  });

  it('an idle report reads idle', () => {
    const idle = configWith('idle');
    expect(computeLiveSignals('claude', idle, '/tmp/phnx4387-silent', true, SILENT_NOW).state!.activity).toBe('idle');
  });

  it('a dead pid drops the report', () => {
    const busy = configWith('busy');
    expect(computeLiveSignals('claude', busy, '/tmp/phnx4387-silent', false, SILENT_NOW).state!.activity).toBe('idle');
  });
});
