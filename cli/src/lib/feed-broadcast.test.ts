import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Meta } from './types.js';
import { mailboxDir, peek } from './mailbox.js';
import { registerBuiltinProviders } from './channels/providers/index.js';
import {
  registerChannelProvider,
  resolveChannelProvider,
  type ChannelProvider,
} from './channels/registry.js';
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
  ...over,
});

/** The config an operator would actually write for this stack. */
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
    // No ticket on the session — commenting on nothing is worse than not
    // commenting, so the sink does not run at all.
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
  // PHNX-3698: a plain sink cannot render a labeled link and a dumped naked URL
  // reads as noise, so the plain message is the human sentence with NO URLs —
  // the crumb and ticket keys turn blue only on a Slack (mrkdwn) sink.
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
    // Plain sink: the human sentence, no CLI command and no trailing URL line.
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
    expect(msg).toContain('Session summary'); // title (headline) preserved
    expect(msg).toContain('line 1 of the session summary');
    expect(msg).toContain('line 8 of the session summary');
    expect(msg).not.toContain('line 9 of the session summary'); // capped at 8 body lines
    expect(msg).toContain('… (full in feed)'); // plain pointer, not a CLI command
    expect(msg).not.toContain('agents focus');
  });

  it('truncates a very long single-line body by character count', () => {
    const wall = 'x'.repeat(900);
    const msg = composeBroadcastMessage(ctx({ title: 'Big update', text: wall }));
    expect(msg).toContain('Big update');
    expect(msg).toContain('… (full in feed)');
    // The forwarded copy is far shorter than the 900-char body.
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
    // The crumb reads as `claude/c854ae60` but taps through to the console page.
    expect(msg).toContain(
      'Sent from <https://prix.dev/console/sessions/c854ae60-0bde-4049-bc8a-0b9674aeabd0|claude/c854ae60> on yosemite-s1',
    );
    // No trailing naked URL line: every http(s) reference is inside a `<url|label>`.
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
    // The key itself becomes the blue link, in place — never a trailing URL line.
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
    // The one prose mention is the one labeled link; the session's own ticketUrl
    // is not dumped separately, so the URL appears exactly once.
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
  it('plans the owner alias without requiring `to`, carrying its ctx for per-destination compose', () => {
    // The owner alias fans out to every policy channel, each with its own
    // provider, so it carries the ctx + template to re-render per destination
    // (Slack mrkdwn vs iMessage plain — PHNX-3698). `text` is the plain default.
    const planned = planFeedBroadcast({ owner: { channel: 'owner' } }, ctx());
    expect(planned).toEqual([
      {
        name: 'owner',
        channel: 'owner',
        to: undefined,
        text: composeBroadcastMessage(ctx()),
        ctx: ctx(),
        messageTemplate: '{message}',
      },
    ]);
  });

  it('does NOT attach ctx to a direct channel sink — its one provider resolves the format at plan time', () => {
    const [planned] = planFeedBroadcast({ tg: { channel: 'telegram', to: '12345' } }, ctx());
    expect(planned.ctx).toBeUndefined();
    expect(planned.messageTemplate).toBeUndefined();
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

  it('a Slack sink gets a mrkdwn labeled crumb; an owner/iMessage sink stays plain (PHNX-3698)', () => {
    const config: FeedBroadcastConfig = {
      slackling: { channel: 'slack', to: 'C0' },
      phone: { channel: 'owner' },
    };
    const [slackSink, ownerSink] = planFeedBroadcast(config, ctx());
    // The Slack sink's crumb is a labeled console link; the owner sink is the bare sentence.
    expect(slackSink.text).toContain(
      'Sent from <https://prix.dev/console/sessions/c854ae60-0bde-4049-bc8a-0b9674aeabd0|claude/c854ae60> on yosemite-s1',
    );
    expect(ownerSink.text).toContain('Sent from claude/c854ae60 on yosemite-s1');
    expect(ownerSink.text).not.toContain('<https://');
    expect(ownerSink.text).not.toContain('/console/sessions/');
  });

  it('keys format off the RESOLVED provider — a channel aliased to slack via notify.transports gets mrkdwn', () => {
    // The format decision must match delivery: `eng-alerts` delivers through the
    // real slack provider, so it must compose mrkdwn even though its declared
    // channel name is not literally "slack" (PHNX-3698, review).
    const meta = { notify: { transports: { 'eng-alerts': 'slack' } } } as Meta;
    const config: FeedBroadcastConfig = { eng: { channel: 'eng-alerts', to: 'C0' } };
    const [sink] = planFeedBroadcast(config, ctx(), meta);
    expect(sink.text).toContain(
      'Sent from <https://prix.dev/console/sessions/c854ae60-0bde-4049-bc8a-0b9674aeabd0|claude/c854ae60> on yosemite-s1',
    );
  });

  it('keys format off the RESOLVED provider — the literal name "slack" remapped away stays plain', () => {
    // Remapping `slack` -> a non-mrkdwn transport must NOT emit `<url|label>`
    // markup the recipient would see literally.
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

describe('effectiveBroadcastConfig — the implicit owner fallback', () => {
  const ownerMeta = { notify: { owner: { channel: 'mailbox', to: 'agents-feed-fallback-test' } } } as Meta;

  it('falls back to notify.owner when feed.broadcast is unset/empty and the post is important', () => {
    expect(effectiveBroadcastConfig(undefined, 'important', ownerMeta)).toEqual({ owner: { channel: 'owner' } });
    expect(effectiveBroadcastConfig({}, 'important', ownerMeta)).toEqual({ owner: { channel: 'owner' } });
  });

  it('stays record-only for a routine milestone post even with notify.owner configured', () => {
    expect(effectiveBroadcastConfig(undefined, 'milestone', ownerMeta)).toBeUndefined();
  });

  it('does not fall back when notify.owner is not configured either', () => {
    expect(effectiveBroadcastConfig(undefined, 'important', metaEmpty)).toBeUndefined();
  });

  it('never layers on top of an operator-declared feed.broadcast — the config always wins outright', () => {
    expect(effectiveBroadcastConfig(CONFIG, 'important', ownerMeta)).toBe(CONFIG);
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
    // The operator's own sinks survive intact.
    expect(merged?.ticket).toEqual(CONFIG.ticket);
    expect(merged?.message).toEqual(CONFIG.message);
  });

  it('never clobbers an operator sink that shares the reserved name — both fire', () => {
    const operatorNotify = { command: ['my-notifier', '{message}'] };
    const merged = withDesktopNotify({ [DESKTOP_NOTIFY_SINK]: operatorNotify }, true);
    // The operator's `notify` sink is untouched; the banner lands under `notify-2`.
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
    // An operator with an important-only phone sink, plus --notify on a milestone.
    const config = withDesktopNotify(
      { phone: { channel: 'mailbox', to: 'x', minLevel: 'important' } },
      true,
    );
    const planned = planFeedBroadcast(config, ctx({ level: 'milestone' }));
    // Only the desktop banner plans; the phone sink is gated out at milestone.
    expect(planned.map((p) => p.name)).toEqual([DESKTOP_NOTIFY_SINK]);
  });
});

describe('channel delivery — real provider registry, no mocking', () => {
  // Unique throwaway mailbox box in the real spool (repo rule: real services,
  // no mocking — same pattern as channels/providers/mailbox.test.ts).
  const BOX = `agents-feed-broadcast-test-${process.pid}`;

  afterEach(() => {
    try {
      fs.rmSync(mailboxDir(BOX), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('delivers an owner-alias channel sink through the real mailbox provider', async () => {
    const meta = { notify: { owner: { channel: 'mailbox', to: BOX } } } as Meta;
    const postCtx = ctx({ level: 'important' });
    const planned = planFeedBroadcast({ owner: { channel: 'owner' } }, postCtx);
    const outcomes = await runFeedBroadcast(planned, meta);
    expect(outcomes).toEqual([{ name: 'owner', ok: true }]);

    const pending = peek(mailboxDir(BOX), BOX);
    expect(pending.map((m) => m.text)).toContain(composeBroadcastMessage(postCtx));
  });

  // RUSH-2123: before effectiveBroadcastConfig, this exact scenario
  // (notify.owner set, feed.broadcast never written) returned [] from
  // broadcastBlock and the block reached nobody, even though blockDeliveryFailure
  // would have reported it undelivered — nothing in the outbound stack knew
  // notify.owner existed. Now it delivers.
  it('was silent before RUSH-2123: --blocked with notify.owner set and no feed.broadcast now delivers', async () => {
    const meta = { notify: { owner: { channel: 'mailbox', to: BOX } } } as Meta;
    const postCtx = ctx({ level: 'important' });
    const config = effectiveBroadcastConfig(undefined, 'important', meta);
    expect(config).toBeDefined();

    const outcomes = await runFeedBroadcast(planFeedBroadcast(config!, postCtx), meta);
    expect(outcomes).toEqual([{ name: 'owner', ok: true }]);
    expect(peek(mailboxDir(BOX), BOX)).toHaveLength(1);
  });

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

/**
 * PHNX-3303 integration: the feed owner sink must actually INVOKE the SSH
 * forward when local owner delivery fails on a box with no working provider —
 * not just leave the pure `owner-forward.ts` functions correct in isolation.
 *
 * Real path, no mocking of the logic: the owner channel is the macOS-only rush
 * `imessage` transport, `rush` is absent from PATH so the local send genuinely
 * fails its `which rush` preflight, a real device registry names a macOS peer,
 * and a fake `ssh` on PATH stands in for the transport (the same kind of on-PATH
 * fake the notify/openclaw tests use) and returns the peer's `agents send --json`
 * result. POSIX-only: the fake `ssh`/absent-`rush` rig needs `which` + `#!/bin/sh`.
 */
describe.skipIf(process.platform === 'win32')('feed owner sink forwards over SSH on local failure (PHNX-3303)', () => {
  let tmp: string;
  let sshRecord: string;
  const saved = {
    PATH: process.env.PATH,
    devicesDir: process.env.AGENTS_DEVICES_DIR,
    machineId: process.env.AGENTS_SYNC_MACHINE_ID,
    humans: process.env.AGENTS_HUMANS_FILE,
    sshRecord: process.env.SSH_RECORD,
    guard: process.env.AGENTS_OWNER_NO_FORWARD,
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-owner-forward-'));
    // A real device registry naming one reachable macOS peer.
    const devicesDir = path.join(tmp, 'devices');
    fs.mkdirSync(devicesDir, { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(devicesDir, 'registry.json'), JSON.stringify({
      'mac-test': {
        name: 'mac-test', platform: 'macos', shell: 'posix',
        address: { via: 'manual', dnsName: 'mac-test.example' },
        auth: { method: 'key' }, createdAt: now, updatedAt: now,
      },
    }));
    process.env.AGENTS_DEVICES_DIR = devicesDir;
    process.env.AGENTS_SYNC_MACHINE_ID = 'linux-self'; // not the mac peer
    process.env.AGENTS_HUMANS_FILE = path.join(tmp, 'humans.yaml'); // absent -> meta.notify.owner wins

    // A fake `ssh` that records its argv and returns the peer's send result.
    // No `rush` on PATH, so the LOCAL imessage send fails its `which rush` preflight.
    sshRecord = path.join(tmp, 'ssh.log');
    process.env.SSH_RECORD = sshRecord;
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const ssh = path.join(bin, 'ssh');
    fs.writeFileSync(ssh, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$SSH_RECORD"\nprintf '%s\\n' '{"ok":true,"channel":"imessage","id":"+18055551234"}'\nexit 0\n`);
    fs.chmodSync(ssh, 0o755);
    process.env.PATH = `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    delete process.env.AGENTS_OWNER_NO_FORWARD;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries({
      PATH: saved.PATH, AGENTS_DEVICES_DIR: saved.devicesDir, AGENTS_SYNC_MACHINE_ID: saved.machineId,
      AGENTS_HUMANS_FILE: saved.humans, SSH_RECORD: saved.sshRecord, AGENTS_OWNER_NO_FORWARD: saved.guard,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('delivers the important post via the macOS peer when this box has no rush', async () => {
    const meta = { notify: { owner: { channel: 'imessage', to: '+18055551234' } } } as Meta;
    const planned = planFeedBroadcast({ owner: { channel: 'owner' } }, ctx({ level: 'important' }));
    const outcomes = await runFeedBroadcast(planned, meta);

    // Local rush send failed, but the owner sink forwarded and reports success.
    expect(outcomes).toEqual([{ name: 'owner', ok: true }]);
    // The forward really ran `agents send --to owner` on the peer over SSH,
    // carrying the loop guard so the peer never forwards onward.
    const log = fs.readFileSync(sshRecord, 'utf-8');
    expect(log).toContain('mac-test.example');
    expect(log).toContain('AGENTS_OWNER_NO_FORWARD');
    expect(log).toContain('send');
  });

  it('forwards an explicit Slack sink to the macOS peer', async () => {
    const meta = { config: { interactiveHost: 'mac-test' } } as Meta;
    const planned = planFeedBroadcast(
      { engineering: { channel: 'slack', to: 'CENGINEERING' } },
      ctx({ level: 'important' }),
    );
    const outcomes = await runFeedBroadcast(planned, meta);

    expect(outcomes).toEqual([{ name: 'engineering', ok: true }]);
    const log = fs.readFileSync(sshRecord, 'utf-8');
    expect(log).toContain('mac-test.example');
    expect(log).toContain('slack');
    expect(log).toContain('CENGINEERING');
    expect(log).toContain('AGENTS_OWNER_NO_FORWARD');
  });

  it('keeps the clean local failure when no capable peer exists', async () => {
    fs.writeFileSync(path.join(process.env.AGENTS_DEVICES_DIR!, 'registry.json'), JSON.stringify({}));
    const meta = { notify: { owner: { channel: 'imessage', to: '+18055551234' } } } as Meta;
    const planned = planFeedBroadcast({ owner: { channel: 'owner' } }, ctx({ level: 'important' }));
    const outcomes = await runFeedBroadcast(planned, meta);

    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].error).toContain('rush CLI not found on PATH');
    expect(fs.existsSync(sshRecord)).toBe(false); // never dialed a peer
  });
});

/**
 * PHNX-3698 — the RUNTIME half of the important-`feed post` → owner fan-out.
 * The planning tests above prove `ctx`/`messageTemplate` land on the owner-alias
 * sink; this proves the sink, once RUN, re-renders the body PER destination so a
 * Slack channel in the owner policy gets mrkdwn labeled links while iMessage
 * stays plain — the same two-different-bodies guarantee notify.test.ts asserts
 * for `agents send --to owner`, but through the `feed post` entry point. Real path, no
 * mocking of the composer: spy providers stand in for the rush `imessage`/`slack`
 * transports and capture the exact body each was handed.
 */
describe('runFeedBroadcast owner fan-out composes per destination (PHNX-3698)', () => {
  const savedHumans = process.env.AGENTS_HUMANS_FILE;
  const savedWorkspace = process.env.LINEAR_WORKSPACE;
  const captured: Record<string, string> = {};
  let tmp: string;
  let realImessage: ChannelProvider | undefined;
  let realSlack: ChannelProvider | undefined;

  const spy = (name: string): ChannelProvider => ({
    name,
    async send(text, opts) {
      captured[name] = text;
      return { ok: true, channel: name, id: opts.target };
    },
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-owner-perchan-'));
    process.env.AGENTS_HUMANS_FILE = path.join(tmp, 'humans.yaml');
    fs.writeFileSync(
      process.env.AGENTS_HUMANS_FILE,
      `version: 1\nowner:\n  channels:\n    - id: imessage\n      transport: rush\n      to: phone-owner\n    - id: slack\n      transport: rush\n      to: C0SLACKOWNER\n  policy:\n    normal: [imessage, slack]\n`,
    );
    process.env.LINEAR_WORKSPACE = 'getrush';
    // Overlay spies AFTER the guard is set, so sendToOwner's internal
    // registerBuiltinProviders() is a no-op and cannot restore the real ones.
    registerBuiltinProviders();
    realImessage = resolveChannelProvider('imessage');
    realSlack = resolveChannelProvider('slack');
    registerChannelProvider(spy('imessage'));
    registerChannelProvider(spy('slack'));
  });

  afterEach(() => {
    if (realImessage) registerChannelProvider(realImessage);
    if (realSlack) registerChannelProvider(realSlack);
    if (savedHumans === undefined) delete process.env.AGENTS_HUMANS_FILE;
    else process.env.AGENTS_HUMANS_FILE = savedHumans;
    if (savedWorkspace === undefined) delete process.env.LINEAR_WORKSPACE;
    else process.env.LINEAR_WORKSPACE = savedWorkspace;
    for (const k of Object.keys(captured)) delete captured[k];
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('delivers a mrkdwn body to the Slack owner channel and a plain one to iMessage', async () => {
    const post = ctx({
      level: 'important',
      title: undefined,
      text: 'Deploy never ran. PHNX-3689 is the root cause.',
      ticket: undefined,
    });
    const planned = planFeedBroadcast({ owner: { channel: 'owner' } }, post);
    const outcomes = await runFeedBroadcast(planned, metaEmpty);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].ok).toBe(true);
    // Slack: the named ticket key is an inline labeled link.
    expect(captured.slack).toContain('<https://linear.app/getrush/issue/PHNX-3689|PHNX-3689>');
    // iMessage: the same key as bare text, no angle-bracket markup, no URL.
    expect(captured.imessage).toContain('PHNX-3689');
    expect(captured.imessage).not.toContain('<https://');
    expect(captured.imessage).not.toContain('http');
    // Two destinations, two different bodies from the one post.
    expect(captured.slack).not.toEqual(captured.imessage);
  });
});
