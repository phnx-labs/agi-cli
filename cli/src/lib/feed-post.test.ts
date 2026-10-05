import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildAttachment,
  buildAttachments,
  normalizeStatusText,
  normalizeStatusTitle,
  postFeedStatus,
  resolvePostIdentity,
  scrubDashes,
  walkPidRegistry,
  STATUS_POST_MAX_CHARS,
  STATUS_TITLE_MAX_CHARS,
} from './feed-post.js';
import { appendActivityEvent, readSessionActivity, tierForEvent } from './feed/activity.js';
import type { PidSessionEntry } from './session/pid-registry.js';

function tmpActivityDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-post-'));
}

let emptyDefsDir: string;
beforeEach(() => {
  emptyDefsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-post-defs-'));
  process.env.AGENTS_PROJECTS_DIR = emptyDefsDir;
});
afterEach(() => {
  delete process.env.AGENTS_PROJECTS_DIR;
  fs.rmSync(emptyDefsDir, { recursive: true, force: true });
});

describe('normalizeStatusText / title', () => {
  it('collapses whitespace and rejects empty', () => {
    expect(normalizeStatusText('  hello   world  ')).toBe('hello world');
    expect(normalizeStatusText(' \n\t ')).toBe('');
  });

  it('caps length with an ellipsis', () => {
    const long = 'x'.repeat(STATUS_POST_MAX_CHARS + 50);
    const out = normalizeStatusText(long);
    expect(out.length).toBe(STATUS_POST_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });

  it('scrubs em/en dashes from title and body', () => {
    expect(scrubDashes('Halfway done \u2014 CI')).toBe('Halfway done - CI');
    expect(normalizeStatusTitle('Force push \u2013 denied')).toBe('Force push - denied');
    expect(normalizeStatusText('watching merge \u2014 then ship')).toBe('watching merge - then ship');
  });

  it('caps title length with an ellipsis', () => {
    const long = 'w'.repeat(STATUS_TITLE_MAX_CHARS + 20);
    const out = normalizeStatusTitle(long);
    expect(out.length).toBe(STATUS_TITLE_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('resolvePostIdentity', () => {
  it('prefers explicit session over env', () => {
    const id = resolvePostIdentity({
      sessionId: 'sess-explicit',
      env: {
        AGENT_SESSION_ID: 'sess-env',
        AGENTS_AGENT_NAME: 'claude',
        AGENTS_RUNTIME: 'teams',
        AGENTS_SYNC_MACHINE_ID: 'zion',
      },
    });
    expect(id?.sessionId).toBe('sess-explicit');
    expect(id?.agent).toBe('claude');
    expect(id?.runtime).toBe('teams');
    expect(id?.host).toBe('zion');
  });

  it('resolves session from AGENTS_MAILBOX_DIR basename', () => {
    const id = resolvePostIdentity({
      env: {
        AGENTS_MAILBOX_DIR: '/home/u/.agents/.history/mailbox/sess-from-box',
        AGENTS_AGENT_NAME: 'grok',
      },
    });
    expect(id?.sessionId).toBe('sess-from-box');
    expect(id?.mailboxId).toBe('sess-from-box');
    expect(id?.agent).toBe('grok');
  });

  it('matches AGENT_LAUNCH_ID in the pid registry', () => {
    const entries: PidSessionEntry[] = [
      {
        pid: 4242,
        agent: 'claude',
        sessionId: 'sess-launch',
        launchId: 'launch-abc',
        cwd: '/repo',
        tmuxPane: '%3',
        startedAtMs: 1,
      },
    ];
    const id = resolvePostIdentity({
      env: { AGENT_LAUNCH_ID: 'launch-abc' },
      listEntries: () => entries,
      readEntry: () => undefined,
      startPid: 1,
    });
    expect(id?.sessionId).toBe('sess-launch');
    expect(id?.pid).toBe(4242);
    expect(id?.launchId).toBe('launch-abc');
    expect(id?.tmuxPane).toBe('%3');
    expect(id?.cwd).toBe('/repo');
  });

  it('recovers the session from activity when AGENT_SESSION_ID is empty', () => {
    const activityRoot = tmpActivityDir();
    appendActivityEvent({
      ts: '2026-08-05T10:00:00.000Z',
      event: 'bash.executed',
      sessionId: 'sess-from-activity',
      mailboxId: 'sess-from-activity',
      host: 'zion',
      runtime: 'codex',
      agent: 'codex',
      cwd: '/repo/from-activity',
      launchId: 'launch-from-activity',
      terminalId: 'term-1',
    }, activityRoot);

    const id = resolvePostIdentity({
      env: { AGENT_SESSION_ID: '', AGENT_LAUNCH_ID: 'launch-from-activity' },
      activityRoot,
      listEntries: () => [],
      readEntry: () => undefined,
      startPid: 1,
    });

    expect(id).toMatchObject({
      sessionId: 'sess-from-activity',
      launchId: 'launch-from-activity',
      host: 'zion',
      runtime: 'codex',
      agent: 'codex',
      cwd: '/repo/from-activity',
      terminalId: 'term-1',
    });
  });

  it('walks parent pids to find a registry entry', () => {
    const entries = new Map<number, PidSessionEntry>([
      [100, { pid: 100, agent: 'codex', sessionId: 'sess-parent', cwd: '/w', startedAtMs: 1 }],
    ]);
    const parents = new Map<number, number>([[200, 100], [100, 1]]);
    const id = resolvePostIdentity({
      env: {},
      startPid: 200,
      getParentPid: (p) => parents.get(p),
      readEntry: (p) => entries.get(p),
      listEntries: () => [],
    });
    expect(id?.sessionId).toBe('sess-parent');
    expect(id?.agent).toBe('codex');
    expect(id?.pid).toBe(100);
  });

  it('returns undefined when nothing resolves', () => {
    expect(resolvePostIdentity({
      env: {},
      startPid: 1,
      getParentPid: () => undefined,
      readEntry: () => undefined,
      listEntries: () => [],
    })).toBeUndefined();
  });
});

describe('walkPidRegistry', () => {
  it('returns the first ancestor with a sessionId', () => {
    const entries = new Map<number, PidSessionEntry>([
      [50, { pid: 50, agent: 'claude', startedAtMs: 1 }],
      [10, { pid: 10, agent: 'claude', sessionId: 's10', startedAtMs: 1 }],
    ]);
    const parents = new Map<number, number>([[90, 50], [50, 10], [10, 1]]);
    const hit = walkPidRegistry(90, (p) => parents.get(p), (p) => entries.get(p));
    expect(hit?.sessionId).toBe('s10');
  });
});

describe('postFeedStatus', () => {
  it('writes a status.posted milestone with auto identity', () => {
    const dir = tmpActivityDir();
    const { event } = postFeedStatus({
      title: 'Track complete',
      text: '  All three surfaces green  ',
      sessionId: 'sess-post-1',
      activityRoot: dir,
      env: {
        AGENTS_AGENT_NAME: 'grok',
        AGENTS_RUNTIME: 'teams',
        AGENTS_SYNC_MACHINE_ID: 'yosemite-s1',
        AGENTS_CWD: '/repo/foreman',
        AGENT_LAUNCH_ID: 'launch-1',
      },
      ts: '2026-07-31T12:00:00.000Z',
      listEntries: () => [],
      readEntry: () => undefined,
      startPid: 1,
    });

    expect(event.event).toBe('status.posted');
    expect(tierForEvent(event.event)).toBe('milestone');
    expect(event.title).toBe('Track complete');
    expect(event.detail).toBe('All three surfaces green');
    expect(event.sessionId).toBe('sess-post-1');
    expect(event.agent).toBe('grok');
    expect(event.runtime).toBe('teams');
    expect(event.host).toBe('yosemite-s1');
    expect(event.cwd).toBe('/repo/foreman');
    expect(event.tool).toBe('feed.post');
    expect(event.launchId).toBe('launch-1');
    expect(event.tier).toBe('milestone');

    const stored = readSessionActivity('sess-post-1', dir);
    expect(stored).toHaveLength(1);
    expect(stored[0].event).toBe('status.posted');
    expect(stored[0].title).toBe('Track complete');
    expect(stored[0].detail).toBe('All three surfaces green');
    expect(stored[0].agent).toBe('grok');
    expect(stored[0].launchId).toBe('launch-1');
  });

  it('throws on empty title', () => {
    expect(() => postFeedStatus({
      title: '   ',
      text: 'body is fine',
      sessionId: 's',
      activityRoot: tmpActivityDir(),
    })).toThrow(/Title is empty/i);
  });

  it('throws on empty text', () => {
    expect(() => postFeedStatus({
      title: 'Subject here',
      text: '   ',
      sessionId: 's',
      activityRoot: tmpActivityDir(),
    })).toThrow(/empty/i);
  });

  it('throws when session cannot be resolved', () => {
    expect(() => postFeedStatus({
      title: 'Hello',
      text: 'hello',
      activityRoot: tmpActivityDir(),
      env: {},
      startPid: 1,
      getParentPid: () => undefined,
      readEntry: () => undefined,
      listEntries: () => [],
    })).toThrow(/No session id/i);
  });

  it('does not invent domain-specific meta fields', () => {
    const dir = tmpActivityDir();
    const { event } = postFeedStatus({
      title: 'Done',
      text: 'done',
      sessionId: 'sess-no-meta',
      activityRoot: dir,
      env: { AGENTS_AGENT_NAME: 'claude' },
      listEntries: () => [],
      readEntry: () => undefined,
      startPid: 1,
    });
    expect(event).not.toHaveProperty('meta');
    expect(event).not.toHaveProperty('ticket');
    expect(event).not.toHaveProperty('url');
  });
});

describe('buildAttachment', () => {
  const ctx = { sessionId: 's', updateId: 'u' };

  it('classifies a remote URL as a link, media by extension', () => {
    const link = buildAttachment('https://x.dev/thread/1', ctx);
    expect(link).toEqual({ kind: 'link', href: 'https://x.dev/thread/1', name: '1' });
    const vid = buildAttachment('https://x.dev/preview.mp4', ctx);
    expect(vid?.kind).toBe('video');
    expect(vid?.mediaType).toBe('video/mp4');
  });

  it('classifies + copies a local file, and stat sizes it', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-attach-src-'));
    const copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-attach-store-'));
    const wav = path.join(src, 'draft.wav');
    fs.writeFileSync(wav, 'RIFFxxxx');

    const att = buildAttachment(wav, { sessionId: 'sess-a', updateId: 'up-1', copyRoot });
    expect(att?.kind).toBe('audio');
    expect(att?.mediaType).toBe('audio/wav');
    expect(att?.name).toBe('draft.wav');
    expect(att?.bytes).toBe(8);
    expect(att?.href).toBe(path.join(copyRoot, 'sess-a', 'up-1', 'draft.wav'));
    expect(fs.existsSync(att!.href)).toBe(true);
  });

  it('drops a missing local file / blank token (fail-open)', () => {
    expect(buildAttachment('/no/such/file.png', ctx)).toBeUndefined();
    expect(buildAttachment('   ', ctx)).toBeUndefined();
  });

  it('buildAttachments filters out the failures', () => {
    const list = buildAttachments(['https://a/b', '/no/such.png'], ctx);
    expect(list).toHaveLength(1);
    expect(list[0].href).toBe('https://a/b');
    expect(buildAttachments(undefined, ctx)).toEqual([]);
  });
});

describe('postFeedStatus attachments + project', () => {
  it('writes one line with both attachments and project, round-trips', () => {
    const dir = tmpActivityDir();
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-attach-store-'));
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-attach-src-'));
    const wav = path.join(src, 'take.wav');
    fs.writeFileSync(wav, 'RIFF');

    const { event } = postFeedStatus({
      title: 'Listen',
      text: 'take ready for review',
      sessionId: 'sess-attach',
      activityRoot: dir,
      attachmentsRoot: store,
      attach: [wav, 'https://x/preview.mp4'],
      cwd: '/repo/song-factory',
      env: { AGENTS_AGENT_NAME: 'grok', AGENTS_SYNC_MACHINE_ID: 'yosemite-s1' },
      ts: '2026-07-31T12:00:00.000Z',
      listEntries: () => [],
      readEntry: () => undefined,
      startPid: 1,
    });

    expect(event.project).toBe('song-factory');
    expect(event.attachments).toHaveLength(2);
    expect(event.attachments?.[0].kind).toBe('audio');
    expect(event.attachments?.[1]).toMatchObject({ kind: 'video', href: 'https://x/preview.mp4' });

    const stored = readSessionActivity('sess-attach', dir);
    expect(stored).toHaveLength(1);
    expect(stored[0].project).toBe('song-factory');
    expect(stored[0].attachments).toHaveLength(2);
    expect(stored[0].attachments?.[0].name).toBe('take.wav');
  });

  it('stamps the canonical defined-project name, not the repo key', () => {
    const dir = tmpActivityDir();
    const defsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-proj-defs-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-proj-repo-'));
    fs.writeFileSync(path.join(defsDir, 'song-suite.yaml'), `name: song-suite\nroot: ${repo}\n`);
    process.env.AGENTS_PROJECTS_DIR = defsDir;
    try {
      const { event } = postFeedStatus({
        title: 'Mastered',
        text: 'final mix landed',
        sessionId: 'sess-canonical',
        activityRoot: dir,
        cwd: path.join(repo, 'apps', 'studio'),
        env: { AGENTS_AGENT_NAME: 'grok', AGENTS_SYNC_MACHINE_ID: 'yosemite-s1' },
        ts: '2026-07-31T12:00:00.000Z',
        listEntries: () => [],
        readEntry: () => undefined,
        startPid: 1,
      });
      expect(event.project).toBe('song-suite');
    } finally {
      delete process.env.AGENTS_PROJECTS_DIR;
    }
  });

  it('omits attachments when none given', () => {
    const dir = tmpActivityDir();
    const { event } = postFeedStatus({
      title: 'No attachments',
      text: 'plain status only',
      sessionId: 'sess-noattach',
      activityRoot: dir,
      cwd: '/repo/foo',
      env: { AGENTS_AGENT_NAME: 'claude' },
      listEntries: () => [],
      readEntry: () => undefined,
      startPid: 1,
    });
    expect(event).not.toHaveProperty('attachments');
    expect(readSessionActivity('sess-noattach', dir)[0].attachments).toBeUndefined();
  });
});
