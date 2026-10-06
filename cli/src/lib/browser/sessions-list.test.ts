import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import {
  resolveArtifact,
  renderBrowserSessions,
  groupIntoRows,
  matchesBrowserSessionRow,
  resolveLaunchSession,
  loadTaskIdentities,
  buildBrowserSessionRows,
  readBrowserSessionRows,
  readBrowserTaskHistory,
  readNativeBrowserHistory,
  nativeBrowserHistoryPath,
  type ProfileArtifacts,
  type BrowserArtifact,
  type TaskIdentity,
  type LaunchSessionIndex,
} from './sessions-list.js';
import { getProfileRuntimeDir } from './paths.js';
import { NativeHistoryWriter } from './native-history.test-fixture.js';
import { getBrowserSessionRecord, recordBrowserSession } from '../session/db.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';

function makeSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'sess-1234',
    shortId: 'sess1234',
    agent: 'claude',
    timestamp: '2026-01-01T00:00:00.000Z',
    filePath: '/tmp/does-not-exist.jsonl',
    ...overrides,
  } as SessionMeta;
}


const groups: ProfileArtifacts[] = [
  {
    profile: 'work',
    artifacts: [
      { kind: 'download', name: 'report.pdf', path: '/b/work/downloads/report.pdf', bytes: 800_000, mtimeMs: 3000 },
      { kind: 'screenshot', task: 't1', name: '2000.png', path: '/b/work/sessions/t1/2000.png', bytes: 64_000, mtimeMs: 2000 },
    ],
  },
  {
    profile: 'personal',
    artifacts: [
      { kind: 'recording', task: 't2', name: '1000.webm', path: '/b/personal/sessions/t2/1000.webm', bytes: 5_000_000, mtimeMs: 1000 },
    ],
  },
];

describe('resolveArtifact', () => {
  it("'latest' picks the newest across all profiles", () => {
    expect(resolveArtifact(groups, 'latest')).toBe('/b/work/downloads/report.pdf');
  });

  it('matches an exact filename before falling back to substring', () => {
    expect(resolveArtifact(groups, '2000.png')).toBe('/b/work/sessions/t1/2000.png');
  });

  it('matches on a filename substring', () => {
    expect(resolveArtifact(groups, 'webm')).toBe('/b/personal/sessions/t2/1000.webm');
  });

  it('returns null when nothing matches', () => {
    expect(resolveArtifact(groups, 'nope.gif')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(resolveArtifact([], 'latest')).toBeNull();
  });
});

describe('renderBrowserSessions', () => {
  it('summarizes per-kind counts per profile', () => {
    const out = renderBrowserSessions(groups);
    expect(out).toContain('work  screenshots 1  pdfs 0  recordings 0  downloads 1');
    expect(out).toContain('personal  screenshots 0  pdfs 0  recordings 1  downloads 0');
  });

  it('handles the no-profiles case', () => {
    expect(renderBrowserSessions([])).toBe('No browser profiles found.');
  });
});


const taskArtifacts = (task: string, mtimes: number[]): BrowserArtifact[] =>
  mtimes.map((mtimeMs, i) => ({
    kind: 'screenshot' as const,
    task,
    name: `${mtimeMs}.png`,
    path: `/b/work/sessions/${task}/${mtimeMs}.png`,
    bytes: 1000 + i,
    mtimeMs,
  }));

describe('groupIntoRows', () => {
  it('collapses every capture in a task to one row, newest artifact first', () => {
    const groups: ProfileArtifacts[] = [
      { profile: 'work', artifacts: taskArtifacts('heavy-task', [1000, 3000, 2000]) },
    ];
    const rows = groupIntoRows(groups, new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('task');
    expect(rows[0].task).toBe('heavy-task');
    expect(rows[0].artifacts.map((a) => a.mtimeMs)).toEqual([3000, 2000, 1000]);
    expect(rows[0].latestMtimeMs).toBe(3000);
    expect(rows[0].counts.screenshot).toBe(3);
  });

  it('separates downloads into their own row per profile, distinct from tasks', () => {
    const groups: ProfileArtifacts[] = [
      {
        profile: 'work',
        artifacts: [
          { kind: 'download', name: 'report.pdf', path: '/b/work/downloads/report.pdf', bytes: 500, mtimeMs: 5000 },
          ...taskArtifacts('t1', [1000]),
        ],
      },
    ];
    const rows = groupIntoRows(groups, new Map());
    expect(rows.map((r) => r.kind)).toEqual(['downloads', 'task']);
    expect(rows[0].task).toBeUndefined();
    expect(rows[0].counts.download).toBe(1);
    expect(rows[1].task).toBe('t1');
  });

  it('sorts rows across profiles newest-capture-first', () => {
    const groups: ProfileArtifacts[] = [
      { profile: 'old-profile', artifacts: taskArtifacts('t1', [1000]) },
      { profile: 'new-profile', artifacts: taskArtifacts('t2', [9000]) },
    ];
    const rows = groupIntoRows(groups, new Map());
    expect(rows.map((r) => r.profile)).toEqual(['new-profile', 'old-profile']);
  });

  it('links a task to its session when the task has a launchId that resolves', () => {
    const groups: ProfileArtifacts[] = [{ profile: 'work', artifacts: taskArtifacts('t1', [1000]) }];
    const identities = new Map([['work', new Map<string, TaskIdentity>([['t1', { owner: 'me@zion', launchId: 'launch-1' }]])]]);
    const session = makeSession({ agent: 'codex', topic: 'fix the flaky test' });
    const rows = groupIntoRows(groups, identities, (launchId) => (launchId === 'launch-1' ? session : null));
    expect(rows[0].linkStatus).toBe('linked');
    expect(rows[0].linkedSession).toBe(session);
    expect(rows[0].owner).toBe('me@zion');
  });

  it('marks a task unresolved when it has a launchId but the resolver finds no session', () => {
    const groups: ProfileArtifacts[] = [{ profile: 'work', artifacts: taskArtifacts('t1', [1000]) }];
    const identities = new Map([['work', new Map<string, TaskIdentity>([['t1', { owner: 'me@zion', launchId: 'launch-1' }]])]]);
    const rows = groupIntoRows(groups, identities, () => null);
    expect(rows[0].linkStatus).toBe('unresolved');
    expect(rows[0].linkedSession).toBeUndefined();
    expect(rows[0].launchId).toBe('launch-1');
  });

  it('marks a task unlinked when tasks.json has no entry for it (a stopped/legacy task)', () => {
    const groups: ProfileArtifacts[] = [{ profile: 'work', artifacts: taskArtifacts('gone', [1000]) }];
    const rows = groupIntoRows(groups, new Map());
    expect(rows[0].linkStatus).toBe('unlinked');
    expect(rows[0].owner).toBeUndefined();
    expect(rows[0].launchId).toBeUndefined();
  });
});

describe('matchesBrowserSessionRow', () => {
  const session = makeSession({ agent: 'codex', topic: 'fix the flaky test', label: undefined });
  const linkedRow = groupIntoRows(
    [{ profile: 'work', artifacts: taskArtifacts('rush-2407-task', [1000]) }],
    new Map([['work', new Map<string, TaskIdentity>([['rush-2407-task', { launchId: 'l1' }]])]]),
    () => session,
  )[0];

  it('matches on task name', () => {
    expect(matchesBrowserSessionRow(linkedRow, 'rush-2407')).toBe(true);
    expect(matchesBrowserSessionRow(linkedRow, 'no-such-task')).toBe(false);
  });

  it('matches on profile', () => {
    expect(matchesBrowserSessionRow(linkedRow, 'work')).toBe(true);
  });

  it('matches on the linked session agent and topic', () => {
    expect(matchesBrowserSessionRow(linkedRow, 'codex')).toBe(true);
    expect(matchesBrowserSessionRow(linkedRow, 'flaky test')).toBe(true);
  });

  it('matches on an artifact filename', () => {
    expect(matchesBrowserSessionRow(linkedRow, '1000.png')).toBe(true);
  });

  it('is case-insensitive and treats a blank query as match-all', () => {
    expect(matchesBrowserSessionRow(linkedRow, 'CODEX')).toBe(true);
    expect(matchesBrowserSessionRow(linkedRow, '  ')).toBe(true);
  });

  it('the downloads row matches the literal word "downloads"', () => {
    const downloadsRow = groupIntoRows(
      [{ profile: 'work', artifacts: [{ kind: 'download', name: 'x.zip', path: '/b/work/downloads/x.zip', bytes: 1, mtimeMs: 1 }] }],
      new Map(),
    )[0];
    expect(matchesBrowserSessionRow(downloadsRow, 'download')).toBe(true);
  });
});

describe('resolveLaunchSession', () => {
  it('returns null without consulting the session index when the launchId has no join', () => {
    const index: LaunchSessionIndex = { byLaunchId: new Map() };
    expect(resolveLaunchSession(index, 'never-seen-launch-id')).toBeNull();
  });
});


describe('loadTaskIdentities + buildBrowserSessionRows (real files)', () => {
  let profile: string;
  let root: string;
  const extraDirs: string[] = [];

  beforeEach(() => {
    profile = `tst-rush2407-${crypto.randomBytes(6).toString('hex')}`;
    root = getProfileRuntimeDir(profile);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    for (const d of extraDirs) fs.rmSync(d, { recursive: true, force: true });
    extraDirs.length = 0;
  });

  it('reads owner/launchId for a live task and ignores fields it does not know', () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'tasks.json'),
      JSON.stringify({
        'my-task': { id: 'abc', name: 'my-task', profile, owner: 'muqsit@zion', launchId: 'launch-xyz', pid: 123, tabs: {} },
      }),
    );
    const identities = loadTaskIdentities(profile);
    expect(identities.get('my-task')).toEqual({ owner: 'muqsit@zion', launchId: 'launch-xyz' });
  });

  it('returns an empty map when tasks.json is absent (a fresh or already-stopped profile)', () => {
    expect(loadTaskIdentities(profile).size).toBe(0);
  });

  it('returns an empty map instead of throwing on corrupt JSON', () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'tasks.json'), '{not json');
    expect(loadTaskIdentities(profile).size).toBe(0);
  });

  it('groups real on-disk captures by task and reports an unresolved link for a launchId this machine cannot join', () => {
    const sessionsDir = path.join(root, 'sessions', 'my-task');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'one.png'), 'fake-png');
    fs.writeFileSync(path.join(sessionsDir, 'two.png'), 'fake-png');
    fs.writeFileSync(
      path.join(root, 'tasks.json'),
      JSON.stringify({ 'my-task': { id: 'abc', name: 'my-task', profile, owner: 'muqsit@zion', launchId: `no-such-launch-${profile}`, pid: 1, tabs: {} } }),
    );

    const rows = buildBrowserSessionRows(profile);
    expect(rows).toHaveLength(1);
    expect(rows[0].task).toBe('my-task');
    expect(rows[0].artifacts).toHaveLength(2);
    expect(rows[0].linkStatus).toBe('unresolved');
    expect(rows[0].owner).toBe('muqsit@zion');
  });

  it('surfaces tasks stored under the composite `<profile>@<device>` dir when queried by the bare profile name (PHNX-3317)', () => {
    const compositeDir = getProfileRuntimeDir(`${profile}@zion`);
    extraDirs.push(compositeDir);

    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'tasks.json'), '{}');

    const sessionsDir = path.join(compositeDir, 'sessions', 'prix-demo');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'shot.png'), 'fake-png');
    fs.writeFileSync(
      path.join(compositeDir, 'tasks.json'),
      JSON.stringify({ 'prix-demo': { id: 'abc', name: 'prix-demo', profile: `${profile}@zion`, owner: 'claude@yosemite-m3', launchId: `no-such-launch-${profile}`, pid: 0, tabs: {} } }),
    );

    const rows = buildBrowserSessionRows(profile);
    const taskRow = rows.find((r) => r.task === 'prix-demo');
    expect(taskRow).toBeDefined();
    expect(taskRow!.artifacts).toHaveLength(1);
    expect(taskRow!.owner).toBe('claude@yosemite-m3');
  });
});

describe('native browser history (.history/browser/history.db)', () => {
  let profile: string;
  let writer: NativeHistoryWriter;
  const cleanup: string[] = [];

  beforeEach(() => {
    profile = `tst-native-${crypto.randomBytes(6).toString('hex')}`;
    writer = new NativeHistoryWriter(nativeBrowserHistoryPath());
  });

  afterEach(() => {
    writer.close();
    for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const sha = (file: string) => fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;

  it('lists a finished task that left no capture, with its recorded counts, times and source machine', () => {
    writer.put({
      profile, task: 'done-no-capture', sessionId: `sess-${profile}`, machine: 'origin-box', actor: 'claude@origin-box',
      startedAt: 1_000, lastActivity: 5_000, counts: { screenshot: 3, pdf: 0, recording: 0, download: 0 },
    });
    const rows = readBrowserSessionRows(profile);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'task', task: 'done-no-capture', owner: 'claude@origin-box', sessionId: `sess-${profile}`,
      linkStatus: 'unresolved', machine: 'origin-box', startedAt: 1_000, latestMtimeMs: 5_000, artifacts: [],
      counts: { screenshot: 3, pdf: 0, recording: 0, download: 0 },
    });
  });

  it('reads a legacy-only browser_sessions row, and lets native history win field by field on overlap', () => {
    recordBrowserSession({ profile, task: 'legacy-only', sessionId: 'legacy-sess', actor: 'legacy-actor', startedAt: 2_000 });
    recordBrowserSession({ profile, task: 'both', sessionId: 'legacy-sess', actor: 'legacy-actor', startedAt: 2_000, capturesRemote: 'peer-a' });
    writer.put({ profile, task: 'both', sessionId: 'native-sess', machine: 'native-box', startedAt: 3_000, lastActivity: 9_000 });

    const history = readBrowserTaskHistory(profile);
    expect(history.map((h) => h.task).sort()).toEqual(['both', 'legacy-only']);
    expect(history.find((h) => h.task === 'legacy-only')).toMatchObject({ sessionId: 'legacy-sess', actor: 'legacy-actor' });
    expect(history.find((h) => h.task === 'both')).toMatchObject({
      sessionId: 'native-sess', machine: 'native-box', startedAt: 3_000, lastActivity: 9_000,
      actor: 'legacy-actor', capturesRemote: 'peer-a',
    });

    const rows = readBrowserSessionRows(profile);
    expect(rows.map((r) => r.task).sort()).toEqual(['both', 'legacy-only']);
    expect(rows.find((r) => r.task === 'both')).toMatchObject({ sessionId: 'native-sess', owner: 'legacy-actor' });
  });

  it('lists captures from a recorded capture dir outside the runtime tree, but not a remote one', () => {
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'native-captures-'));
    cleanup.push(local, getProfileRuntimeDir(profile));
    fs.writeFileSync(path.join(local, 'shot.png'), 'png');
    writer.put({ profile, task: 'local-caps', captureDir: local, startedAt: 1, lastActivity: 2 });
    writer.put({ profile, task: 'remote-caps', captureDir: local, capturesRemote: 'peer-b', startedAt: 1, lastActivity: 2,
      counts: { screenshot: 4, pdf: 0, recording: 0, download: 0 } });

    const rows = readBrowserSessionRows(profile);
    expect(rows.find((r) => r.task === 'local-caps')!.artifacts.map((a) => a.name)).toEqual(['shot.png']);
    const remote = rows.find((r) => r.task === 'remote-caps')!;
    expect(remote.artifacts).toEqual([]);
    expect(remote).toMatchObject({ capturesRemote: 'peer-b', counts: { screenshot: 4 } });
  });

  it('reads without writing: the history files and the legacy row are byte-identical afterwards', () => {
    writer.put({ profile, task: 'untouched', startedAt: 1, lastActivity: 2 });
    recordBrowserSession({ profile, task: 'untouched', sessionId: 'legacy-sess', startedAt: 1 });
    const file = nativeBrowserHistoryPath();
    const before = [sha(file), sha(`${file}-wal`)];
    const legacyBefore = getBrowserSessionRecord(profile, 'untouched');
    readBrowserSessionRows(profile);
    readBrowserSessionRows(profile);
    expect([sha(file), sha(`${file}-wal`)]).toEqual(before);
    expect(getBrowserSessionRecord(profile, 'untouched')).toEqual(legacyBefore);
  });

  it('throws on a record it cannot trust instead of dropping the task from the list', () => {
    writer.rawRecord(profile, 'corrupt', '{"profile":', 10);
    expect(() => readBrowserSessionRows(profile)).toThrow(/unreadable browser history record/);
    writer.rawRecord(profile, 'corrupt', JSON.stringify({ profile, task: 'corrupt', startedAt: 'yesterday' }), 10);
    expect(() => readNativeBrowserHistory()).toThrow(/needs profile, task and finite timestamps/);
    writer.rawRecord(profile, 'corrupt', JSON.stringify({ profile, task: 'corrupt', startedAt: 1, lastActivity: 10 }), 10);
  });

  it('throws on a history file that is not a database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-garbage-'));
    cleanup.push(dir);
    const garbage = path.join(dir, 'history.db');
    fs.writeFileSync(garbage, 'this is not sqlite '.repeat(64));
    expect(() => readNativeBrowserHistory(garbage)).toThrow();
    expect(readNativeBrowserHistory(path.join(dir, 'absent.db'))).toEqual([]);
  });
});
