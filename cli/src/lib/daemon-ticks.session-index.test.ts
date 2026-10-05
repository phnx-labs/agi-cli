import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ActiveSession } from './session/active.js';


const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalCwd = process.cwd();
const testHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-index-warm-')));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const { runActiveSessionsWarmTick, runSessionIndexWarmTick } = await import('./daemon-ticks.js');
const db = await import('./session/db.js');
const sessionCache = await import('./session/session-cache.js');

afterAll(() => {
  db.closeDB();
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(testHome, { recursive: true, force: true });
});

function writeTranscript(id: string, projectCwd: string, label?: string): void {
  fs.mkdirSync(projectCwd, { recursive: true });
  const projectDir = path.join(testHome, '.claude', 'projects', projectCwd.replace(/[/\\.:]/g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
  const events = [
    JSON.stringify({
      type: 'user',
      sessionId: id,
      cwd: projectCwd,
      timestamp: '2026-08-15T10:00:00.000Z',
      message: { role: 'user', content: 'index me' },
    }),
  ];
  if (label) events.push(JSON.stringify({ type: 'custom-title', customTitle: label, sessionId: id }));
  fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), `${events.join('\n')}\n`);
}

describe('runSessionIndexWarmTick (RUSH-2682, RUSH-2691)', () => {
  it('indexes a transcript whose cwd is NOT the daemon cwd, and says how many', async () => {
    const projectCwd = path.join(testHome, 'work', 'proj');
    const id = '11111111-2222-4333-8444-555555555555';
    writeTranscript(id, projectCwd);

    process.chdir(testHome);

    const first = await runSessionIndexWarmTick();
    expect(first.claimed, 'nothing else holds the scan claim in this test').toBe(true);
    expect(first.indexed, 'a transcript outside the daemon cwd must still count').toBeGreaterThan(0);

    expect(db.getSessionById(id)?.cwd).toBe(projectCwd);
  });

  it('is incremental — an unchanged transcript is not re-parsed on the next tick', async () => {
    const id = '44444444-3333-4222-8111-000000000000';
    writeTranscript(id, path.join(testHome, 'work', 'incremental'));

    const first = await runSessionIndexWarmTick();
    expect(first.indexed, 'the new transcript must be parsed first').toBeGreaterThan(0);
    expect(db.getSessionById(id)).not.toBeNull();

    const second = await runSessionIndexWarmTick();
    expect(second.claimed).toBe(true);
    expect(second.indexed, 'unchanged files must not be re-parsed').toBe(0);
  });

  it('picks up a NEW transcript on a later tick', async () => {
    const id = '99999999-8888-4777-8666-555555555555';
    writeTranscript(id, path.join(testHome, 'work', 'other'));

    const third = await runSessionIndexWarmTick();
    expect(third.indexed, 'a newly written transcript must be parsed').toBeGreaterThan(0);
    expect(db.getSessionById(id), 'the new session must be resolvable by id').not.toBeNull();
  });

  it('publishes an indexed Claude title into the canonical active-session journal', async () => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const projectCwd = path.join(testHome, 'work', 'watch-label');
    writeTranscript(id, projectCwd, 'Remote tab title synced');

    const indexed = await runSessionIndexWarmTick();
    expect(indexed.indexed, 'the title event must reach the real index').toBeGreaterThan(0);
    expect(db.getSessionById(id)?.label).toBe('Remote tab title synced');

    const raw: ActiveSession = {
      context: 'terminal',
      kind: 'claude',
      sessionId: id,
      cwd: projectCwd,
      topic: 'index me',
      status: 'running',
    };
    sessionCache.noteActiveSessionsJournalReader();
    await runActiveSessionsWarmTick({ gather: async () => [raw] });

    const published = sessionCache.readActiveSessionsCache('local')?.sessions.find((row) => row.sessionId === id);
    expect(published?.label).toBe('Remote tab title synced');
    const records = fs.readFileSync(sessionCache.activeSessionsJournalPath(), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    const journalRow = records.flatMap((record) => record.upserts).find((row) => row.sessionId === id);
    expect(journalRow?.label).toBe('Remote tab title synced');
  });
});
