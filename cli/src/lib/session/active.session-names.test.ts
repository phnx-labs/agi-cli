import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-active-names-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { applySessionNames, readTranscriptHead } = await import('./active.js');
const { recordRunName } = await import('./run-names.js');
const { machineId } = await import('../machine-id.js');
type ActiveSession = import('./active.js').ActiveSession;

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata', 'session-names', 'claude-goal-renamed.jsonl');
const accountSessions = path.join(TEST_HOME, '.agents', '.history', 'accounts', 'claude', 'acct-names-0002', '.claude', 'sessions');

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

function writeLiveName(pid: number, sessionId: string, name: string, nameSource: string): void {
  fs.mkdirSync(accountSessions, { recursive: true });
  fs.writeFileSync(path.join(accountSessions, `${pid}.json`), JSON.stringify({
    pid, sessionId, cwd: '/repo', startedAt: Date.now(), kind: 'interactive', name, nameSource,
  }));
}

function row(sessionId: string, over: Partial<ActiveSession> = {}): ActiveSession {
  return { context: 'terminal', kind: 'claude', sessionId, ...over };
}

describe('readTranscriptHead — startedAs (PHNX-4387)', () => {
  it('is the /goal ask, not the injected Stop-hook turn, and the topic skips that turn too', () => {
    const head = readTranscriptHead(FIXTURE);
    expect(head.startedAs).toBe('Build the artifacts CLI base -- then show it to me');
    expect(head.topic).not.toMatch(/Stop hook/);
  });
});

describe('applySessionNames — one label for every live row (PHNX-4387)', () => {
  it("Claude's live rename beats a stale index label and the launch name", () => {
    writeLiveName(5101, 'live-a', 'Rush credentials', 'user');
    recordRunName({ sessionId: 'live-a', name: 'fork of Artifacts-cli base', agent: 'claude' });
    const rows = [row('live-a', { label: 'Artifacts-cli base' })];
    applySessionNames(rows, () => 'Artifacts-cli base');
    expect(rows[0].label).toBe('Rush credentials');
    expect(rows[0].name).toBe('fork of Artifacts-cli base');
  });

  it('a row with no live name takes the index label, then the launch name; the tab title is not an input', () => {
    recordRunName({ sessionId: 'live-b', name: 'name probe', agent: 'claude' });
    const indexed = [row('live-b', { label: 'tab title echoed by the extension' })];
    applySessionNames(indexed, () => 'Indexed title');
    expect(indexed[0].label).toBe('Indexed title');

    const unindexed = [row('live-b', { label: 'tab title echoed by the extension' })];
    applySessionNames(unindexed);
    expect(unindexed[0].label).toBe('name probe');
  });

  it("a peer's row keeps the label its own device resolved", () => {
    writeLiveName(5102, 'peer-a', 'Local stale name', 'user');
    const rows = [row('peer-a', { machine: `${machineId()}-peer`, label: 'Peer name' })];
    applySessionNames(rows, () => 'Mirror label');
    expect(rows[0].label).toBe('Peer name');
  });
});
