import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-session-names-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { scanClaudeSession, scanSessionsIncremental, readClaudeLiveNames } = await import('./discover.js');
const { getSessionById, getDB, closeDB } = await import('./db.js');
const { recordRunName } = await import('./run-names.js');

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata', 'session-names', 'claude-goal-renamed.jsonl');
const FIXTURE_LINES = fs.readFileSync(FIXTURE, 'utf-8').split('\n').filter(Boolean);
const RENAME_AT = FIXTURE_LINES.findIndex((l) => l.includes('"custom-title"'));

const history = path.join(TEST_HOME, '.agents', '.history');
const versionProjects = path.join(history, 'versions', 'claude', '2.1.289', 'home', '.claude', 'projects', '-repo');
const accountSessions = path.join(history, 'accounts', 'claude', 'acct-names-0001', '.claude', 'sessions');

fs.mkdirSync(path.join(TEST_HOME, '.claude', 'projects'), { recursive: true });

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

function writeTranscript(id: string, lines: string[]): string {
  fs.mkdirSync(versionProjects, { recursive: true });
  const file = path.join(versionProjects, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => l.replaceAll('5e55a000-0000-4000-8000-000000004387', id)).join('\n') + '\n');
  return file;
}

function writeLiveName(pid: number, id: string, name: string, nameSource: string): void {
  fs.mkdirSync(accountSessions, { recursive: true });
  fs.writeFileSync(path.join(accountSessions, `${pid}.json`), JSON.stringify({
    pid, sessionId: id, cwd: '/repo', startedAt: Date.now(), kind: 'interactive', name, nameSource, updatedAt: Date.now(),
  }));
}

function makeCold(file: string): void {
  getDB().prepare('UPDATE scan_ledger SET scanned_at = 0 WHERE file_path = ?').run(file);
}

describe('Claude session names in the index (PHNX-4387)', () => {
  it('a /rename beats the generated title even when Claude re-appends the ai-title after it', async () => {
    const scan = await scanClaudeSession(FIXTURE);
    expect(scan.label).toBe('Rush credentials');
  });

  it('reads Claude live names from account homes, not only ~/.claude', () => {
    writeLiveName(4101, 'live-only-0001', 'Rush credentials', 'user');
    expect(readClaudeLiveNames().get('live-only-0001')).toMatchObject({ name: 'Rush credentials', source: 'user' });
  });

  it('a rename in a running session reaches the index although the transcript directory is unchanged', async () => {
    const id = '5e55a000-0000-4000-8000-00000000a001';
    const file = writeTranscript(id, FIXTURE_LINES.slice(0, RENAME_AT));
    await scanSessionsIncremental({ agent: 'claude' });
    expect(getSessionById(id)?.label).toBe('Artifacts-cli base');

    makeCold(file);
    fs.appendFileSync(file, FIXTURE_LINES.slice(RENAME_AT).map((l) => l.replaceAll('5e55a000-0000-4000-8000-000000004387', id)).join('\n') + '\n');
    await scanSessionsIncremental({ agent: 'claude' });
    expect(getSessionById(id)?.label, 'not running: a cold file waits for its directory to change').toBe('Artifacts-cli base');

    writeLiveName(4102, id, 'Rush credentials', 'user');
    await scanSessionsIncremental({ agent: 'claude' });
    expect(getSessionById(id)?.label).toBe('Rush credentials');
  });

  it('the agents run --name launch name outranks the generated title and yields to a rename', async () => {
    const named = '5e55a000-0000-4000-8000-00000000a002';
    recordRunName({ sessionId: named, name: 'fork of Artifacts-cli base', agent: 'claude' });
    writeTranscript(named, FIXTURE_LINES.slice(0, RENAME_AT));
    const renamed = '5e55a000-0000-4000-8000-00000000a003';
    recordRunName({ sessionId: renamed, name: 'fork of Artifacts-cli base', agent: 'claude' });
    writeTranscript(renamed, FIXTURE_LINES);
    await scanSessionsIncremental({ agent: 'claude' });
    expect(getSessionById(named)?.label).toBe('fork of Artifacts-cli base');
    expect(getSessionById(renamed)?.label).toBe('Rush credentials');
  });
});
