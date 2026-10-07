import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Meta } from './types.js';
import {
  composeBroadcastMessage,
  effectiveBroadcastConfig,
  parseFeedPostLevel,
  planFeedBroadcast,
  renderSinkArgv,
  renderSinkMessage,
  runFeedBroadcast,
  withDesktopNotify,
  DESKTOP_NOTIFY_SINK,
  type FeedBroadcastConfig,
  type FeedBroadcastContext,
} from './feed-broadcast.js';

const ctx = (over: Partial<FeedBroadcastContext> = {}): FeedBroadcastContext => ({
  title: 'CI green, merging',
  text: 'PR #1690 open, waiting on prix-cloud',
  level: 'milestone',
  project: 'agents-cli',
  agent: 'claude',
  host: 'yosemite-s1',
  session: 'c854ae60-0bde-4049-bc8a-0b9674aeabd0',
  eventKey: 'c854ae60-0bde-4049-bc8a-0b9674aeabd0:2026-10-06T12:00:00.000Z',
  ...over,
});

const CONFIG: FeedBroadcastConfig = {
  ticket: { command: ['linear', 'update', '{ticket}', '--comment', '{text}'] },
  message: { command: ['rush', 'message', 'send', '--text', '{message}'], minLevel: 'important' },
};

const metaEmpty = {} as Meta;

describe('feed post level', () => {
  it('defaults to milestone and accepts important', () => {
    expect(parseFeedPostLevel(undefined)).toBe('milestone');
    expect(parseFeedPostLevel('important')).toBe('important');
  });

  it('rejects an unknown level instead of silently downgrading it', () => {
    expect(() => parseFeedPostLevel('urgent')).toThrow(/Unknown --level 'urgent'/);
  });
});

describe('sink argv rendering', () => {
  it('substitutes every placeholder the post can supply', () => {
    const argv = renderSinkArgv(
      ['linear', 'update', '{ticket}', '--comment', '{project}: {text}'],
      ctx({ ticket: 'RUSH-2081' }),
    );
    expect(argv).toEqual([
      'linear', 'update', 'RUSH-2081',
      '--comment', 'agents-cli: PR #1690 open, waiting on prix-cloud',
    ]);
  });

  it('skips a template whose placeholder this post cannot fill', () => {
    expect(renderSinkArgv(['linear', 'update', '{ticket}', '--comment', '{text}'], ctx())).toBeUndefined();
  });

  it('keeps post text as one argv element, never shell syntax', () => {
    const argv = renderSinkArgv(['echo', '{text}'], ctx({ text: 'done; rm -rf / && echo pwned' }));
    expect(argv).toEqual(['echo', 'done; rm -rf / && echo pwned']);
  });
});

describe('channel message rendering', () => {
  it('renders ticket-aware channel copy from the same placeholder context', () => {
    const rendered = renderSinkMessage(
      '{message}\nhttps://linear.app/getrush/issue/{ticket}',
      ctx({
        ticket: 'PHNX-3572',
        ticketUrl: 'https://linear.app/getrush/issue/PHNX-3572',
      }),
    );
    expect(rendered).toContain('https://linear.app/getrush/issue/PHNX-3572');
    expect(rendered?.match(/https:\/\/linear\.app\/getrush\/issue\/PHNX-3572/g)).toHaveLength(1);
  });

  it('skips a channel template when required ticket context is absent', () => {
    expect(renderSinkMessage('{message}\nTicket: {ticket}', ctx())).toBeUndefined();
  });

  it('exposes the canonical tracker URL as a template variable', () => {
    expect(renderSinkMessage(
      '{ticket_url}',
      ctx({ ticket: 'PHNX-3572', ticketUrl: 'https://linear.app/getrush/issue/PHNX-3572' }),
    )).toBe('https://linear.app/getrush/issue/PHNX-3572');
  });
});

describe('message composition (plain — iMessage / owner / command sinks)', () => {
  it('is the human sentence with no trailing URL line — title, body, Sent from footer', () => {
    expect(composeBroadcastMessage(ctx({ links: ['https://github.com/phnx-labs/agents-cli/pull/1690'] })))
      .toBe(
        'CI green, merging\n' +
          '\n' +
          'PR #1690 open, waiting on prix-cloud\n' +
          '\n' +
          'Sent from claude/c854ae60 on yosemite-s1',
      );
  });

  it('never dumps the console session URL on a plain sink', () => {
    expect(composeBroadcastMessage(ctx({ links: undefined }))).not.toContain('/console/sessions/');
    expect(composeBroadcastMessage(ctx({ links: undefined }))).not.toContain('http');
  });

  it('leaves a ticket key as bare text on a plain sink (no angle-bracket markup, no URL)', () => {
    const msg = composeBroadcastMessage(
      ctx({ text: 'PHNX-3689 is the root cause', ticket: 'PHNX-3689' }),
    );
    expect(msg).toContain('PHNX-3689 is the root cause');
    expect(msg).not.toContain('<');
    expect(msg).not.toContain('http');
  });

  it('scrubs em-dashes from title and body', () => {
    const msg = composeBroadcastMessage(
      ctx({
        title: 'Halfway done — CI',
        text: 'watching merge — then ship',
        agent: 'grok',
        host: 'mac-mini',
        session: 'a02da0e2-a8c0-455f-95c3-12f75f16579f',
      }),
    );
    expect(msg).not.toMatch(/\u2014|\u2013/);
    expect(msg).toContain('Halfway done - CI');
    expect(msg).toContain('watching merge - then ship');
    expect(msg).toContain('Sent from grok/a02da0e2 on mac-mini');
  });

  it('falls back to body-only when there is no title', () => {
    expect(
      composeBroadcastMessage(
        ctx({ title: undefined, text: 'legacy body only', agent: undefined, host: undefined, session: undefined }),
      ),
    ).toBe('legacy body only');
  });

  it('footer skips the uninformative default agent label', () => {
    const msg = composeBroadcastMessage(
      ctx({ agent: 'agent', host: 'mac-mini', session: 'aabbccdd-1111-2222-3333-444444444444' }),
    );
    expect(msg).toContain('Sent from aabbccdd on mac-mini');
    expect(msg).not.toContain('Sent from agent/');
  });

  it('does NOT put the focus CLI command in the phone message (unusable from a phone)', () => {
    const msg = composeBroadcastMessage(
      ctx({
        focus: 'agents focus c854ae60',
        links: ['https://example.com/p'],
      }),
    );
    expect(msg).toBe(
      'CI green, merging\n' +
        '\n' +
        'PR #1690 open, waiting on prix-cloud\n' +
        '\n' +
        'Sent from claude/c854ae60 on yosemite-s1',
    );
    expect(msg).not.toContain('agents focus');
    expect(msg).not.toContain('http');
  });

  it('renders options + default as the phone-actionable reply for a block', () => {
    const msg = composeBroadcastMessage(
      ctx({ options: ['publish', 'wait'], safeDefault: 'wait', timeoutMinutes: 15 }),
    );
    expect(msg).toContain('Options: publish / wait');
    expect(msg).toContain('Default in 15 min: wait');
    expect(msg).not.toContain('agents focus');
  });

  it('truncates a many-line body to a phone excerpt, keeping the title', () => {
    const wall = Array.from({ length: 18 }, (_, i) => `line ${i + 1} of the session summary`).join('\n');
    const msg = composeBroadcastMessage(ctx({ title: 'Session summary', text: wall }));
    expect(msg).toContain('Session summary');
    expect(msg).toContain('line 1 of the session summary');
    expect(msg).toContain('line 8 of the session summary');
    expect(msg).not.toContain('line 9 of the session summary');
    expect(msg).toContain('… (full in feed)');
    expect(msg).not.toContain('agents focus');
  });

  it('truncates a very long single-line body by character count', () => {
    const wall = 'x'.repeat(900);
    const msg = composeBroadcastMessage(ctx({ title: 'Big update', text: wall }));
    expect(msg).toContain('Big update');
    expect(msg).toContain('… (full in feed)');
    expect(msg.length).toBeLessThan(700);
  });

  it('truncates a no-title long body too (body becomes the head)', () => {
    const wall = Array.from({ length: 12 }, (_, i) => `row ${i + 1}`).join('\n');
    const msg = composeBroadcastMessage(
      ctx({ title: undefined, text: wall, agent: undefined, host: undefined, session: undefined }),
    );
    expect(msg).toContain('row 1');
    expect(msg).toContain('row 8');
    expect(msg).not.toContain('row 9');
    expect(msg).toContain('… (full in feed)');
  });

  it('leaves a short body untouched (no truncation marker)', () => {
    const msg = composeBroadcastMessage(ctx({ title: 'CI green', text: 'PR #1690 merged, no action.' }));
    expect(msg).toContain('PR #1690 merged, no action.');
    expect(msg).not.toContain('full in feed');
  });
});

describe('Slack mrkdwn labeled links (PHNX-3698)', () => {
  const savedEnv = process.env.LINEAR_WORKSPACE;
  beforeEach(() => {
    process.env.LINEAR_WORKSPACE = 'getrush';
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.LINEAR_WORKSPACE;
    else process.env.LINEAR_WORKSPACE = savedEnv;
  });

  it('turns the session crumb into a labeled console link, keeping the human sentence', () => {
    const msg = composeBroadcastMessage(ctx(), 'mrkdwn');
    expect(msg).toContain(
      'Sent from <https://prix.dev/console/sessions/c854ae60-0bde-4049-bc8a-0b9674aeabd0|claude/c854ae60> on yosemite-s1',
    );
    for (const line of msg.split('\n')) {
      expect(line.trim()).not.toMatch(/^https?:\/\/\S+$/i);
    }
  });

  it('labels the console link for a native non-uuid session id (e.g. OpenCode ses_…)', () => {
    const msg = composeBroadcastMessage(ctx({ session: 'ses_fields0000000000000000' }), 'mrkdwn');
    expect(msg).toContain('<https://prix.dev/console/sessions/ses_fields0000000000000000|claude/');
  });

  it('leaves the crumb unlinked when the session id is absent, a bare 8-char crumb, or path-unsafe', () => {
    expect(composeBroadcastMessage(ctx({ session: undefined }), 'mrkdwn')).not.toContain('/console/sessions/');
    expect(composeBroadcastMessage(ctx({ session: 'c854ae60' }), 'mrkdwn')).not.toContain('/console/sessions/');
    expect(composeBroadcastMessage(ctx({ session: 'a/b/../c' }), 'mrkdwn')).not.toContain('/console/sessions/');
  });

  it('linkifies a ticket key the body only NAMES, in place, with no session.ticketId on the row', () => {
    const msg = composeBroadcastMessage(
      ctx({ title: 'Deploy blocked', text: 'PHNX-3689 is the root cause.', ticket: undefined, ticketUrl: undefined }),
      'mrkdwn',
    );
    expect(msg).toContain('<https://linear.app/getrush/issue/PHNX-3689|PHNX-3689> is the root cause.');
  });

  it('linkifies a key mentioned only in the title', () => {
    const msg = composeBroadcastMessage(ctx({ title: 'RUSH-42 landed', text: 'no action', ticket: undefined }), 'mrkdwn');
    expect(msg).toContain('<https://linear.app/getrush/issue/RUSH-42|RUSH-42> landed');
  });

  it('linkifies a repeated key once per occurrence and never as a trailing line', () => {
    const url = 'https://linear.app/getrush/issue/PHNX-3572';
    const msg = composeBroadcastMessage(
      ctx({ ticket: 'PHNX-3572', ticketUrl: url, text: 'still blocked on PHNX-3572' }),
      'mrkdwn',
    );
    expect(msg.match(new RegExp(url.replace(/[/.]/g, '\\$&'), 'g'))).toHaveLength(1);
    expect(msg).toContain('still blocked on <https://linear.app/getrush/issue/PHNX-3572|PHNX-3572>');
  });

  it('does not linkify a denylisted unit string that looks like a key', () => {
    const msg = composeBroadcastMessage(ctx({ title: 'Encoding', text: 'switched to UTF-8', ticket: undefined }), 'mrkdwn');
    expect(msg).not.toContain('/issue/UTF-8');
    expect(msg).toContain('switched to UTF-8');
  });

  it('a plain sink gets no labeled links even when the same key is named', () => {
    const msg = composeBroadcastMessage(ctx({ title: 'Deploy blocked', text: 'PHNX-3689 is the root cause.' }), 'plain');
    expect(msg).toContain('PHNX-3689 is the root cause.');
    expect(msg).not.toContain('<https://');
    expect(msg).not.toContain('linear.app');
  });
});

describe('broadcast planning', () => {
  it('plans nothing when no sinks are configured', () => {
    expect(planFeedBroadcast(undefined, ctx())).toEqual([]);
    expect(planFeedBroadcast({}, ctx())).toEqual([]);
  });

  it('holds an important-only sink back from a routine post', () => {
    const planned = planFeedBroadcast(CONFIG, ctx({ ticket: 'RUSH-2081' }));
    expect(planned.map((p) => p.name)).toEqual(['ticket']);
  });

  it('reaches the messaging sink once the post is important', () => {
    const planned = planFeedBroadcast(CONFIG, ctx({ ticket: 'RUSH-2081', level: 'important' }));
    expect(planned.map((p) => p.name)).toEqual(['ticket', 'message']);
    expect(planned[1].argv[0]).toBe('rush');
    expect(planned[1].argv[3]).toBe('--text');
    expect(planned[1].argv[4]).toContain('CI green, merging');
    expect(planned[1].argv[4]).toContain('Sent from claude/c854ae60 on yosemite-s1');
  });

  it('ignores a malformed sink rather than crashing the post', () => {
    const planned = planFeedBroadcast(
      { broken: { command: [] }, ok: { command: ['true'] } } as FeedBroadcastConfig,
      ctx(),
    );
    expect(planned.map((p) => p.name)).toEqual(['ok']);
  });
});

describe('running sinks', () => {
  it.skipIf(process.platform === 'win32')('runs a real command and reports success', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-broadcast-'));
    const out = path.join(dir, 'sink.txt');
    const planned = planFeedBroadcast(
      { file: { command: ['sh', '-c', `printf '%s' "$1" > ${out}`, 'sh', '{text}'] } },
      ctx(),
    );
    expect(await runFeedBroadcast(planned, metaEmpty)).toEqual([{ name: 'file', ok: true }]);
    expect(fs.readFileSync(out, 'utf8')).toBe('PR #1690 open, waiting on prix-cloud');
  });

  it.skipIf(process.platform === 'win32')('reports a failing sink without throwing — the post already stands', async () => {
    const [outcome] = await runFeedBroadcast(
      [{ name: 'nope', argv: ['sh', '-c', 'echo boom >&2; exit 3'] }],
      metaEmpty,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('boom');
  });

  it('reports a sink whose program is not installed', async () => {
    const [outcome] = await runFeedBroadcast(
      [{ name: 'missing', argv: ['agents-cli-no-such-binary-42', 'x'] }],
      metaEmpty,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/ENOENT|not found|spawnSync/i);
  });
});

describe('channel sink planning', () => {
  it('plans the owner alias without requiring `to`, as one account notification with a plain body and its own title', () => {
    const [planned] = planFeedBroadcast({ owner: { channel: 'owner' } }, ctx());
    expect(planned).toMatchObject({
      name: 'owner',
      channel: 'owner',
      owner: {
        event: 'message',
        title: 'CI green, merging',
        body: composeBroadcastMessage(ctx({ title: undefined })),
        sessionId: 'c854ae60-0bde-4049-bc8a-0b9674aeabd0',
        dedupKey: 'feed:c854ae60-0bde-4049-bc8a-0b9674aeabd0:2026-10-06T12:00:00.000Z',
        source: { device: 'yosemite-s1', agent: 'claude' },
      },
    });
  });

  it('a blocked post plans the owner sink as needs_you keyed on the block', () => {
    const [planned] = planFeedBroadcast({ owner: { channel: 'owner' } }, ctx({ blockId: 'blk-9', level: 'important' }));
    expect(planned.owner).toMatchObject({ event: 'needs_you', dedupKey: 'block:blk-9' });
  });

  it('does NOT build an owner notification for a direct channel sink', () => {
    const [planned] = planFeedBroadcast({ tg: { channel: 'telegram', to: '12345' } }, ctx());
    expect(planned.owner).toBeUndefined();
  });

  it('skips a non-owner channel sink with no recipient rather than sending with a hole in it', () => {
    expect(planFeedBroadcast({ tg: { channel: 'telegram' } }, ctx())).toEqual([]);
  });

  it('plans an explicit channel + recipient', () => {
    const planned = planFeedBroadcast({ tg: { channel: 'telegram', to: '12345' } }, ctx());
    expect(planned).toEqual([
      { name: 'tg', channel: 'telegram', to: '12345', text: composeBroadcastMessage(ctx()) },
    ]);
  });

  it('uses a custom channel message and gates it on ticket context', () => {
    const config: FeedBroadcastConfig = {
      engineering: {
        channel: 'slack',
        to: 'C01234567',
        minLevel: 'important',
        message: '{message}\nhttps://linear.app/getrush/issue/{ticket}',
      },
    };
    expect(planFeedBroadcast(config, ctx({ level: 'important' }))).toEqual([]);

    const [planned] = planFeedBroadcast(
      config,
      ctx({ level: 'important', ticket: 'PHNX-3572' }),
    );
    expect(planned).toMatchObject({
      name: 'engineering',
      channel: 'slack',
      to: 'C01234567',
    });
    expect(planned.text).toContain('https://linear.app/getrush/issue/PHNX-3572');
  });

  it('a Slack sink gets a mrkdwn labeled crumb; the owner notification body stays plain (PHNX-3698)', () => {
    const config: FeedBroadcastConfig = {
      slackling: { channel: 'slack', to: 'C0' },
      phone: { channel: 'owner' },
    };
    const [slackSink, ownerSink] = planFeedBroadcast(config, ctx());
    expect(slackSink.text).toContain(
      'Sent from <https://prix.dev/console/sessions/c854ae60-0bde-4049-bc8a-0b9674aeabd0|claude/c854ae60> on yosemite-s1',
    );
    expect(ownerSink.owner?.body).toContain('Sent from claude/c854ae60 on yosemite-s1');
    expect(ownerSink.owner?.body).not.toContain('<https://');
    expect(ownerSink.owner?.body).not.toContain('/console/sessions/');
  });

  it('keys format off the RESOLVED provider — a channel aliased to slack via notify.transports gets mrkdwn', () => {
    const meta = { notify: { transports: { 'eng-alerts': 'slack' } } } as Meta;
    const config: FeedBroadcastConfig = { eng: { channel: 'eng-alerts', to: 'C0' } };
    const [sink] = planFeedBroadcast(config, ctx(), meta);
    expect(sink.text).toContain(
      'Sent from <https://prix.dev/console/sessions/c854ae60-0bde-4049-bc8a-0b9674aeabd0|claude/c854ae60> on yosemite-s1',
    );
  });

  it('keys format off the RESOLVED provider — the literal name "slack" remapped away stays plain', () => {
    const meta = { notify: { transports: { slack: 'mailbox' } } } as Meta;
    const config: FeedBroadcastConfig = { s: { channel: 'slack', to: 'box' } };
    const [sink] = planFeedBroadcast(config, ctx(), meta);
    expect(sink.text).toContain('Sent from claude/c854ae60 on yosemite-s1');
    expect(sink.text).not.toContain('<https://');
  });

  it('gates a channel sink by minLevel exactly like a command sink', () => {
    const config: FeedBroadcastConfig = { owner: { channel: 'owner', minLevel: 'important' } };
    expect(planFeedBroadcast(config, ctx())).toEqual([]);
    expect(planFeedBroadcast(config, ctx({ level: 'important' })).map((p) => p.name)).toEqual(['owner']);
  });
});

describe('effectiveBroadcastConfig — the implicit owner sink', () => {
  it('routes an important post to the owner when feed.broadcast is unset or empty', () => {
    expect(effectiveBroadcastConfig(undefined, 'important')).toEqual({ owner: { channel: 'owner' } });
    expect(effectiveBroadcastConfig({}, 'important')).toEqual({ owner: { channel: 'owner' } });
  });

  it('stays record-only for a routine milestone post', () => {
    expect(effectiveBroadcastConfig(undefined, 'milestone')).toBeUndefined();
  });

  it('never layers on top of an operator-declared feed.broadcast — the config always wins outright', () => {
    expect(effectiveBroadcastConfig(CONFIG, 'important')).toBe(CONFIG);
  });
});

describe('withDesktopNotify — feed post --notify', () => {
  const desktopSink = { channel: 'desktop', to: 'local' };

  it('is a no-op when --notify is off — returns the config unchanged, undefined included', () => {
    expect(withDesktopNotify(undefined, false)).toBeUndefined();
    expect(withDesktopNotify(CONFIG, false)).toBe(CONFIG);
  });

  it('adds a desktop sink from nothing when the post has no other broadcast', () => {
    expect(withDesktopNotify(undefined, true)).toEqual({ [DESKTOP_NOTIFY_SINK]: desktopSink });
  });

  it('layers the desktop sink ON TOP of configured sinks — never replaces them', () => {
    const merged = withDesktopNotify(CONFIG, true);
    expect(merged).toEqual({ ...CONFIG, [DESKTOP_NOTIFY_SINK]: desktopSink });
    expect(merged?.ticket).toEqual(CONFIG.ticket);
    expect(merged?.message).toEqual(CONFIG.message);
  });

  it('never clobbers an operator sink that shares the reserved name — both fire', () => {
    const operatorNotify = { command: ['my-notifier', '{message}'] };
    const merged = withDesktopNotify({ [DESKTOP_NOTIFY_SINK]: operatorNotify }, true);
    expect(merged?.[DESKTOP_NOTIFY_SINK]).toEqual(operatorNotify);
    expect(merged?.[`${DESKTOP_NOTIFY_SINK}-2`]).toEqual(desktopSink);
  });

  it('fires on a milestone post — the desktop banner carries no minLevel, so it plans at any level', () => {
    const planned = planFeedBroadcast(withDesktopNotify(undefined, true), ctx({ level: 'milestone' }));
    expect(planned.map((p) => p.name)).toEqual([DESKTOP_NOTIFY_SINK]);
    expect(planned[0]).toMatchObject({ channel: 'desktop', to: 'local' });
    expect(planned[0].text).toBe(composeBroadcastMessage(ctx({ level: 'milestone' })));
  });

  it('banners locally without buzzing the phone on a milestone — the important-gated owner sink stays skipped', () => {
    const config = withDesktopNotify(
      { phone: { channel: 'mailbox', to: 'x', minLevel: 'important' } },
      true,
    );
    const planned = planFeedBroadcast(config, ctx({ level: 'milestone' }));
    expect(planned.map((p) => p.name)).toEqual([DESKTOP_NOTIFY_SINK]);
  });
});

describe('channel delivery — real provider registry, no mocking', () => {
  it('reports an unregistered channel provider without throwing — a bad config must not kill the fan-out', async () => {
    const planned = planFeedBroadcast(
      { tg: { channel: 'not-a-real-channel-42', to: 'x' } },
      ctx({ level: 'important' }),
    );
    const outcomes = await runFeedBroadcast(planned, metaEmpty);
    expect(outcomes).toEqual([
      { name: 'tg', ok: false, error: expect.stringContaining('No channel provider') },
    ]);
  });
});
