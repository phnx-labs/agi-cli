
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-account-roots-test-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getAgentSessionDirs, isManagedSessionFile, hydrateSessionTranscript, findLocalSessionTranscripts } = await import('./discover.js');

const { upsertSession, getSessionById, closeDB } = await import('./db.js');
const { writeSessionActorRecord } = await import('./actor-sidecar.js');

function historyDir(): string {
  return path.join(TEST_HOME, '.agents', '.history');
}

function agentsUserDir(): string {
  return path.join(TEST_HOME, '.agents');
}

function writeFile(p: string, content = '{}'): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('getAgentSessionDirs — account-slot roots (PHNX-3940)', () => {
  const claudeAccountId = 'acct-claude-cold-0001';
  const claudeSlotTranscript = path.join(
    historyDir(), 'accounts', 'claude', claudeAccountId, '.claude', 'projects', '-p', 'a.jsonl',
  );

  beforeAll(() => {
    writeFile(claudeSlotTranscript);
  });

  it('scans a claude account-slot dir even with no version home ever installed', () => {
    const dirs = getAgentSessionDirs('claude', 'projects');
    const expected = path.join(historyDir(), 'accounts', 'claude', claudeAccountId, '.claude', 'projects');
    expect(dirs).toContain(expected);
    expect(fs.existsSync(claudeSlotTranscript)).toBe(true);
  });

  it('classifies an account-slot transcript as managed', () => {
    expect(isManagedSessionFile(claudeSlotTranscript)).toBe(true);
  });
});

describe('getAgentSessionDirs — codex short account-home keys (PHNX-3940)', () => {
  const shortKey = 'a-deadbeef0123';
  const codexShortTranscript = path.join(
    agentsUserDir(), '.codex-homes', shortKey, '.codex', 'sessions', 'b.jsonl',
  );

  beforeAll(() => {
    writeFile(codexShortTranscript);
  });

  it('scans a .codex-homes/<key> dir independent of installed-version iteration', () => {
    const dirs = getAgentSessionDirs('codex', 'sessions');
    expect(dirs).toContain(path.dirname(codexShortTranscript));
  });

  it('classifies it as managed even though no codex version is installed', () => {
    expect(isManagedSessionFile(codexShortTranscript)).toBe(true);
  });
});

describe('getAgentSessionDirs — symlinked account-slot dedup (PHNX-3940)', () => {
  const accountId = 'acct-codex-dup-0002';
  const shortKey = 'a-cafef00dfeed';
  const realShortHome = path.join(agentsUserDir(), '.codex-homes', shortKey, '.codex');
  const slotOrigin = path.join(historyDir(), 'accounts', 'codex', accountId, '.codex');

  beforeAll(() => {
    fs.mkdirSync(path.join(realShortHome, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(realShortHome, 'sessions', 'c.jsonl'), '{}');
    fs.mkdirSync(path.dirname(slotOrigin), { recursive: true });
    const linkType = process.platform === 'win32' ? 'junction' : undefined;
    fs.symlinkSync(realShortHome, slotOrigin, linkType);
  });

  it('deduplicates the slot origin and its short-home target to one root', () => {
    const dirs = getAgentSessionDirs('codex', 'sessions');
    const real = fs.realpathSync(path.join(realShortHome, 'sessions'));
    const matches = dirs.filter((d) => {
      try { return fs.realpathSync(d) === real; } catch { return false; }
    });
    expect(matches.length).toBe(1);
  });
});


describe('hydrateSessionTranscript', () => {
  it.each(['', '/missing/old-home/rollout.jsonl'])('repairs a cold Codex row with path %j from its account short home', async (oldPath) => {
    const id = oldPath ? '11111111-2222-3333-4444-555555555551' : '11111111-2222-3333-4444-555555555552';
    const filePath = path.join(agentsUserDir(), '.codex-homes', 'a-cold-resume', '.codex', 'sessions', '2026', '09', '12', `rollout-2026-09-12T00-00-00-${id}.jsonl`);
    writeFile(filePath, [
      { type: 'session_meta', payload: { id, cwd: TEST_HOME, timestamp: '2026-09-12T00:00:00Z', cli_version: '0.154.0' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue the account-home fixture.' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const source = { id, shortId: id.slice(0, 8), agent: 'codex' as const, timestamp: '2026-09-12T00:00:00Z', filePath: oldPath, accountId: 'recorded-origin' };
    upsertSession(source, '');
    const hydrated = await hydrateSessionTranscript(source);
    expect(fs.realpathSync(hydrated.filePath)).toBe(fs.realpathSync(filePath));
    expect(hydrated.accountId).toBe('recorded-origin');
    expect(getSessionById(id)?.filePath).toBe(oldPath);
  });
});

it('cold lookup preserves saved permissions and prefers the live copy over a newer backup', async () => {
  const id = '11111111-2222-3333-4444-555555555553';
  const live = path.join(TEST_HOME, '.codex', 'sessions', `rollout-${id}.jsonl`);
  const backup = path.join(agentsUserDir(), '.codex-homes', 'a-newer-copy', '.codex', 'sessions', `rollout-${id}.jsonl`);
  for (const [file, timestamp] of [[live, '2026-09-12T00:00:00Z'], [backup, '2026-09-13T00:00:00Z']]) {
    writeFile(file, [
      { type: 'session_meta', payload: { id, cwd: TEST_HOME, timestamp, cli_version: '0.154.0' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Saved mode fixture.' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
  }
  writeSessionActorRecord({ sessionId: id, accountId: 'origin-account', mode: 'auto', startedAtMs: Date.now() });
  const [match] = await findLocalSessionTranscripts(id, 'codex');
  expect(match).toMatchObject({ filePath: fs.realpathSync(live), mode: 'auto', accountId: 'origin-account' });
});
