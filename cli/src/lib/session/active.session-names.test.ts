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
const { scanSessionsIncremental } = await import('./discover.js');
const { upsertSession, closeDB, getDB } = await import('./db.js');
const { machineId } = await import('../machine-id.js');
type ActiveSession = import('./active.js').ActiveSession;

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata', 'session-names', 'claude-goal-renamed.jsonl');
const accountSessions = path.join(TEST_HOME, '.agents', '.history', 'accounts', 'claude', 'acct-names-0002', '.claude', 'sessions');

afterAll(() => {
  closeDB();
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
  it("the transcript's rename, read from the index, beats a derived live name and the launch name", async () => {
    const id = '5e55a000-0000-4000-8000-00000000b001';
    const projects = path.join(TEST_HOME, '.agents', '.history', 'versions', 'claude', '2.1.289', 'home', '.claude', 'projects', '-repo');
    fs.mkdirSync(projects, { recursive: true });
    const file = path.join(projects, `${id}.jsonl`);
    fs.writeFileSync(file, fs.readFileSync(FIXTURE, 'utf-8').replaceAll('5e55a000-0000-4000-8000-000000004387', id));
    await scanSessionsIncremental({ agent: 'claude' });
    writeLiveName(5100, id, 'repo-4a', 'derived');
    recordRunName({ sessionId: id, name: 'fork of Artifacts-cli base', agent: 'claude' });
    const rows = [row(id, { sessionFile: file })];
    applySessionNames(rows);
    expect(rows[0].label).toBe('Rush credentials');
    expect(rows[0].name).toBe('fork of Artifacts-cli base');
  });

  it("Claude's live name beats a stale index label", () => {
    upsertSession({ id: 'live-a', shortId: 'live-a', agent: 'claude', timestamp: new Date().toISOString(), filePath: '', label: 'Artifacts-cli base' }, '');
    writeLiveName(5101, 'live-a', 'Rush credentials', 'user');
    const rows = [row('live-a')];
    applySessionNames(rows);
    expect(rows[0].label).toBe('Rush credentials');
  });

  it('with no live name the index label wins, then the launch name; the tab title is not an input', () => {
    upsertSession({ id: 'live-b', shortId: 'live-b', agent: 'claude', timestamp: new Date().toISOString(), filePath: '', label: 'Indexed title' }, '');
    recordRunName({ sessionId: 'live-b', name: 'name probe', agent: 'claude' });
    recordRunName({ sessionId: 'live-c', name: 'name probe', agent: 'claude' });
    const rows = [
      row('live-b', { label: 'tab title echoed by the extension' }),
      row('live-c', { label: 'tab title echoed by the extension' }),
    ];
    applySessionNames(rows);
    expect(rows.map((r) => r.label)).toEqual(['Indexed title', 'name probe']);
  });

  it("a peer's row keeps the label its own device resolved", () => {
    writeLiveName(5102, 'peer-a', 'Local stale name', 'user');
    const rows = [row('peer-a', { machine: `${machineId()}-peer`, label: 'Peer name' })];
    applySessionNames(rows);
    expect(rows[0].label).toBe('Peer name');
  });

  it('a teammate with no session id yet shows its team name', () => {
    const rows = [row('', { sessionId: undefined, context: 'teams', name: 'reviewer' })];
    applySessionNames(rows);
    expect(rows[0].label).toBe('reviewer');
  });

  it('a --device launcher row keeps its --name; the peer pid files are not on this disk', () => {
    writeLiveName(5103, 'offloaded-a', 'Name on this box', 'user');
    recordRunName({ sessionId: 'offloaded-a', name: 'nightly', agent: 'claude' });
    const rows = [row('offloaded-a', { machine: `${machineId()}-peer`, offloadedFrom: machineId() })];
    applySessionNames(rows);
    expect(rows[0].label).toBe('nightly');
  });
});

describe("applySessionNames — Claude's latest recap rides the live row", () => {
  const RECAP_FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata', 'session-names', 'claude-recap.jsonl');
  const id = '5e55a000-0000-4000-8000-00000000ec01';
  const projects = path.join(TEST_HOME, '.agents', '.history', 'versions', 'claude', '2.1.289', 'home', '.claude', 'projects', '-repo-recap');
  const file = path.join(projects, `${id}.jsonl`);
  const lines = fs.readFileSync(RECAP_FIXTURE, 'utf-8').split('\n').filter(Boolean);

  it('is the newest away_summary, without the "(disable recaps in /config)" hint', async () => {
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(file, `${lines.slice(0, 7).join('\n')}\n`);
    await scanSessionsIncremental({ agent: 'claude' });
    const first = [row(id, { sessionFile: file })];
    applySessionNames(first);
    expect(first[0].label).toBe('Platform readiness for agents');
    expect(first[0].recap).toEqual({
      text: 'Main already matches origin and no task is open yet. Next, pick one: PHNX-4360 or PHNX-4397.',
      at: '2026-10-19T00:38:19.222Z',
    });

    getDB().prepare('UPDATE scan_ledger SET scanned_at = 0 WHERE file_path = ?').run(file);
    fs.appendFileSync(file, `${lines.slice(7).join('\n')}\n`);
    writeLiveName(5104, id, '', 'derived');
    await scanSessionsIncremental({ agent: 'claude' });
    const next = [row(id, { sessionFile: file })];
    applySessionNames(next);
    expect(next[0].recap).toEqual({
      text: 'You asked where the Turing milestone stands: it is due today at 17%, with three fixes merged but not yet released. Next is releasing rush/api and rush/console, once you say go.',
      at: '2026-10-19T00:49:31.496Z',
    });
  });
});
