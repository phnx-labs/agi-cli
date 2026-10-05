import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { emit, _resetForTest } from './feed/events.js';
import { appendActivityEvent } from './feed/activity.js';
import { readUnifiedEvents } from './event-stream.js';
import { parseFamilyList, applyFamilies } from './event-families.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-families-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {  }
  }
  tempDirs.length = 0;
  _resetForTest();
});

function setup(): { activityRoot: string } {
  const dir = makeTempDir();
  _resetForTest(path.join(dir, 'events.jsonl'));
  const activityRoot = path.join(dir, 'activity');
  fs.mkdirSync(activityRoot, { recursive: true });
  return { activityRoot };
}

describe('parseFamilyList', () => {
  it('parses comma-separated families', () => {
    expect(parseFamilyList('ops,runs', '--include')).toEqual(['ops', 'runs']);
  });
  it('rejects unknown families', () => {
    expect(() => parseFamilyList('nope', '--include')).toThrow(/Unknown family/);
  });
  it('rejects empty', () => {
    expect(() => parseFamilyList('  , ', '--include')).toThrow(/at least one/);
  });
});

describe('applyFamilies / readUnifiedEvents', () => {
  it('--exclude commands drops command.start/end', () => {
    setup();
    emit('command.end', { module: 'sessions', command: 'sessions' });
    emit('secrets.get', { module: 'secrets', bundle: 'share' });
    const rows = readUnifiedEvents({
      excludeFamilies: ['commands'],
      includeActivity: false,
      limit: 50,
    });
    expect(rows.some((r) => r.event === 'command.end')).toBe(false);
    expect(rows.some((r) => r.event === 'secrets.get')).toBe(true);
  });

  it('--include runs keeps run-dispatch outcomes AND the pre-launch marker', () => {
    setup();
    emit('run.dispatched', { module: 'run', agent: 'claude', version: '1', mode: 'plan', outcome: 'ok', exitCode: 0 });
    emit('run.launch', { module: 'run', agent: 'claude', version: '2.1.219', strategy: 'balanced', signedIn: false, launchedLoggedOut: true, email: null });
    emit('secrets.get', { module: 'secrets' });
    emit('command.end', { module: 'run', command: 'run claude' });
    const rows = readUnifiedEvents({
      includeFamilies: ['runs'],
      limit: 50,
    });
    const events = rows.map((r) => r.event).sort();
    expect(events).toEqual(['run.dispatched', 'run.launch']);
    const launch = rows.find((r) => r.event === 'run.launch')!;
    expect(launch.launchedLoggedOut).toBe(true);
  });

  it('--include activity skips ops', () => {
    const { activityRoot } = setup();
    emit('secrets.get', { module: 'secrets' });
    appendActivityEvent(
      {
        ts: new Date().toISOString(),
        event: 'pr.opened',
        sessionId: 's1',
        mailboxId: 's1',
        host: 'zion',
        runtime: 'headless',
        agent: 'claude',
        detail: 'pr',
      },
      activityRoot,
    );
    const rows = readUnifiedEvents({
      includeFamilies: ['activity'],
      activityRoot,
      limit: 50,
    });
    expect(rows.every((r) => r.event === 'pr.opened' || r.module === 'activity')).toBe(true);
    expect(rows.some((r) => r.event === 'secrets.get')).toBe(false);
  });

  it('--include ops skips activity', () => {
    const { activityRoot } = setup();
    emit('secrets.get', { module: 'secrets' });
    appendActivityEvent(
      {
        ts: new Date().toISOString(),
        event: 'pr.opened',
        sessionId: 's1',
        mailboxId: 's1',
        host: 'zion',
        runtime: 'headless',
        agent: 'claude',
        detail: 'pr',
      },
      activityRoot,
    );
    const rows = readUnifiedEvents({
      includeFamilies: ['ops'],
      activityRoot,
      limit: 50,
    });
    expect(rows.some((r) => r.event === 'secrets.get')).toBe(true);
    expect(rows.some((r) => r.event === 'pr.opened')).toBe(false);
  });

  it('--include and --exclude are mutually exclusive', () => {
    expect(() =>
      applyFamilies({ includeFamilies: ['ops'], excludeFamilies: ['commands'] }),
    ).toThrow(/mutually exclusive/);
  });

  it('--include runs ∩ --event secrets.get yields empty (no silent widen)', () => {
    setup();
    emit('run.dispatched', { module: 'run', agent: 'claude', version: '1', mode: 'plan', outcome: 'ok', exitCode: 0 });
    emit('secrets.get', { module: 'secrets' });
    const rows = readUnifiedEvents({
      includeFamilies: ['runs'],
      eventTypes: ['secrets.get'],
      limit: 50,
    });
    expect(rows.length).toBe(0);
  });

  it('--include security,runs is a union (does not shrink to runs-only)', () => {
    setup();
    emit('run.dispatched', { module: 'run', agent: 'claude', version: '1', mode: 'plan', outcome: 'ok', exitCode: 0 });
    emit('secrets.get', { module: 'secrets' });
    emit('browser.navigate', { module: 'browser', url: 'https://example.com' });
    const securityOnly = readUnifiedEvents({
      includeFamilies: ['security'],
      limit: 50,
    });
    const securityAndRuns = readUnifiedEvents({
      includeFamilies: ['security', 'runs'],
      limit: 50,
    });
    expect(securityOnly.some((r) => r.event === 'secrets.get')).toBe(true);
    expect(securityOnly.some((r) => r.event === 'run.dispatched')).toBe(true);
    expect(securityAndRuns.some((r) => r.event === 'secrets.get')).toBe(true);
    expect(securityAndRuns.some((r) => r.event === 'run.dispatched')).toBe(true);
    expect(securityAndRuns.some((r) => r.event === 'browser.navigate')).toBe(false);
  });

  it('--include ops,runs stays full ops (runs is a subset of the ops stream)', () => {
    setup();
    emit('run.dispatched', { module: 'run', agent: 'claude', version: '1', mode: 'plan', outcome: 'ok', exitCode: 0 });
    emit('secrets.get', { module: 'secrets' });
    emit('command.end', { module: 'run', command: 'run claude' });
    const rows = readUnifiedEvents({
      includeFamilies: ['ops', 'runs'],
      limit: 50,
    });
    expect(rows.some((r) => r.event === 'secrets.get')).toBe(true);
    expect(rows.some((r) => r.event === 'run.dispatched')).toBe(true);
    expect(rows.some((r) => r.event === 'command.end')).toBe(true);
  });

  it('--include commands,runs is the type-set union', () => {
    setup();
    emit('run.dispatched', { module: 'run', agent: 'claude', version: '1', mode: 'plan', outcome: 'ok', exitCode: 0 });
    emit('command.end', { module: 'run', command: 'run claude' });
    emit('secrets.get', { module: 'secrets' });
    const rows = readUnifiedEvents({
      includeFamilies: ['commands', 'runs'],
      limit: 50,
    });
    expect(rows.some((r) => r.event === 'run.dispatched')).toBe(true);
    expect(rows.some((r) => r.event === 'command.end')).toBe(true);
    expect(rows.some((r) => r.event === 'secrets.get')).toBe(false);
  });

  it('--exclude ops,activity does not re-open activity', () => {
    const { activityRoot } = setup();
    emit('secrets.get', { module: 'secrets' });
    appendActivityEvent(
      {
        ts: new Date().toISOString(),
        event: 'pr.opened',
        sessionId: 's1',
        mailboxId: 's1',
        host: 'zion',
        runtime: 'headless',
        agent: 'claude',
        detail: 'pr',
      },
      activityRoot,
    );
    const rows = readUnifiedEvents({
      excludeFamilies: ['ops', 'activity'],
      activityRoot,
      limit: 50,
    });
    expect(rows.length).toBe(0);
  });
});
