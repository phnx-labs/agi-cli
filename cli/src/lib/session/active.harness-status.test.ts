import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearLiveSignalsCacheForTest, computeLiveSignals } from './active.js';

// Real captures from yosemite-m6 (PHNX-4387): the transcript as it stood while
// Claude streamed one long Write call (last event a tool_result at 19:19:23.484Z)
// and the `<config>/sessions/<pid>.json` record Claude kept at that moment, which
// said busy. The record is re-pointed at a live child process so the reader's own
// liveness check passes against a real pid.
const TESTDATA = path.join(import.meta.dirname, 'testdata', 'harness-status');
const SESSION = 'ed7688d4-ca54-4747-8005-d59cfdbbf318';
const SILENT_NOW = Date.parse('2026-10-14T19:21:35.906Z');
const tmp: string[] = [];
const children: ChildProcess[] = [];

function startTicks(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
}

/** A Claude config dir holding the silent transcript and a record for a live pid. */
function liveClaude(status: string): string {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-harness-status-'));
  tmp.push(config);
  const projects = path.join(config, 'projects', '-tmp-phnx4387-silent');
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(path.join(config, 'sessions'));
  const transcript = path.join(projects, `${SESSION}.jsonl`);
  fs.copyFileSync(path.join(TESTDATA, 'claude-silent-write.jsonl'), transcript);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  children.push(child);
  const record = JSON.parse(fs.readFileSync(path.join(TESTDATA, 'claude-record-busy.json'), 'utf8'));
  const pid = child.pid!;
  fs.writeFileSync(
    path.join(config, 'sessions', `${pid}.json`),
    JSON.stringify({ ...record, pid, procStart: startTicks(pid), startedAt: Date.now(), status }),
  );
  return transcript;
}

describe('computeLiveSignals reads the turn state Claude reports', () => {
  beforeEach(() => clearLiveSignalsCacheForTest());
  afterAll(() => {
    for (const c of children) c.kill();
    for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  });

  it('a silent busy turn is working, with how long it has been quiet', () => {
    const { state } = computeLiveSignals('claude', liveClaude('busy'), '/tmp/phnx4387-silent', true, SILENT_NOW);
    expect(state?.activity).toBe('working');
    expect(state?.quietMs).toBe(SILENT_NOW - Date.parse('2026-10-14T19:19:23.484Z'));
    expect(state?.quietSinceMs).toBe(Date.parse('2026-10-14T19:19:23.484Z'));
  });

  it('a busy turn whose tail holds only request records is working, quiet since the last write', () => {
    // Seen live on Claude 2.1.261: after each step it appends 100+ KB of
    // api-request-blob records, so the bounded tail read holds no conversation event.
    const transcript = liveClaude('busy');
    const blob = JSON.stringify({ type: 'api-request-blob', blob: 'x'.repeat(16_000) });
    fs.appendFileSync(transcript, `${blob}\n`.repeat(10));
    const lastWrite = SILENT_NOW - 3 * 60_000;
    fs.utimesSync(transcript, new Date(lastWrite), new Date(lastWrite));
    const { state } = computeLiveSignals('claude', transcript, '/tmp/phnx4387-silent', true, SILENT_NOW);
    expect(state?.activity).toBe('working');
    expect(state?.quietSinceMs).toBe(fs.statSync(transcript).mtimeMs);
  });

  it('the same transcript with no live record falls back to the two-minute window', () => {
    const config = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-harness-status-'));
    tmp.push(config);
    const projects = path.join(config, 'projects', '-tmp-phnx4387-silent');
    fs.mkdirSync(projects, { recursive: true });
    const transcript = path.join(projects, `${SESSION}.jsonl`);
    fs.copyFileSync(path.join(TESTDATA, 'claude-silent-write.jsonl'), transcript);
    const { state } = computeLiveSignals('claude', transcript, '/tmp/phnx4387-silent', true, SILENT_NOW);
    expect(state?.activity).toBe('idle');
    expect(state?.quietMs).toBeUndefined();
  });

  it('an idle record ends the turn', () => {
    const { state } = computeLiveSignals('claude', liveClaude('idle'), '/tmp/phnx4387-silent', true, Date.parse('2026-10-14T19:19:30Z'));
    expect(state?.activity).toBe('idle');
  });

  it('a dead process ignores its record', () => {
    const { state } = computeLiveSignals('claude', liveClaude('busy'), '/tmp/phnx4387-silent', false, SILENT_NOW);
    expect(state?.activity).toBe('idle');
  });
});
