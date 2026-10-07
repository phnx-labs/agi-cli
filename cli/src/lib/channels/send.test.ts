import { describe, expect, it } from 'vitest';
import type { Meta } from '../types.js';
import {
  composeSendText,
  isOwnerAlias,
  resolveSendEnvelope,
  sendMessage,
} from './send.js';

const metaEmpty = {} as Meta;

describe('isOwnerAlias', () => {
  it('matches owner case-insensitively', () => {
    expect(isOwnerAlias('owner')).toBe(true);
    expect(isOwnerAlias('Owner')).toBe(true);
    expect(isOwnerAlias(' OWNER ')).toBe(true);
  });
  it('rejects other destinations', () => {
    expect(isOwnerAlias('+1805')).toBe(false);
    expect(isOwnerAlias(undefined)).toBe(false);
    expect(isOwnerAlias('')).toBe(false);
  });
});

describe('composeSendText', () => {
  it('returns trimmed text alone', () => {
    expect(composeSendText('  hello  ')).toBe('hello');
  });
  it('appends urls on new lines', () => {
    expect(composeSendText('see', ['https://a.example', 'https://b.example'])).toBe(
      'see\nhttps://a.example\nhttps://b.example',
    );
  });
  it('skips urls already in the body', () => {
    expect(composeSendText('see https://a.example', ['https://a.example', 'https://b.example'])).toBe(
      'see https://a.example\nhttps://b.example',
    );
  });
  it('allows url-only messages', () => {
    expect(composeSendText('', ['https://a.example'])).toBe('https://a.example');
  });
});

describe('resolveSendEnvelope', () => {
  it('accepts flag-first send with explicit channel and to', () => {
    const r = resolveSendEnvelope(
      { text: 'hi', channel: 'desktop', to: 'local' },
      metaEmpty,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope).toMatchObject({
      text: 'hi',
      channel: 'desktop',
      to: 'local',
    });
  });

  it('accepts positional text for compat', () => {
    const r = resolveSendEnvelope(
      { positionalText: 'legacy', channel: 'desktop', to: 'local' },
      metaEmpty,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.text).toBe('legacy');
  });

  it('rejects conflicting positional and --text', () => {
    const r = resolveSendEnvelope(
      { positionalText: 'a', text: 'b', channel: 'desktop', to: 'local' },
      metaEmpty,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/once/i);
  });

  it('refuses --to owner as an envelope: the owner path goes through the account, not a channel', () => {
    const r = resolveSendEnvelope({ text: 'ping', to: 'owner' }, metaEmpty);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/cannot be combined with --channel/) });
  });

  it('requires channel and to for non-owner destinations', () => {
    const r = resolveSendEnvelope({ text: 'x', to: '+1' }, metaEmpty);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/--channel/);
  });

  it('folds --url into the body', () => {
    const r = resolveSendEnvelope(
      { text: 'plan', channel: 'desktop', to: 'local', urls: ['https://example.com/p'] },
      metaEmpty,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.text).toBe('plan\nhttps://example.com/p');
  });

  it('carries attachments and dryRun', () => {
    const r = resolveSendEnvelope(
      {
        text: 'shot',
        channel: 'desktop',
        to: 'local',
        attachments: ['./a.png'],
        dryRun: true,
      },
      metaEmpty,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.attachments).toEqual(['./a.png']);
    expect(r.envelope.dryRun).toBe(true);
  });

  it('keeps the session channel text verbatim, including whitespace-only and explicitly empty text', () => {
    for (const text of ['  spaced\n', '   ', '']) {
      const r = resolveSendEnvelope({ text, channel: 'session', to: 'abc' }, metaEmpty);
      expect(r.ok, JSON.stringify(text)).toBe(true);
      if (r.ok) expect(r.envelope.text).toBe(text);
    }
    const positional = resolveSendEnvelope({ positionalText: ' p ', channel: 'session', to: 'abc' }, metaEmpty);
    expect(positional.ok && positional.envelope.text).toBe(' p ');
    const withUrl = resolveSendEnvelope({ text: ' see ', urls: ['https://x.test'], channel: 'session', to: 'abc' }, metaEmpty);
    expect(withUrl.ok && withUrl.envelope.text).toBe(' see \nhttps://x.test');

    const trimmed = resolveSendEnvelope({ text: ' hi ', channel: 'desktop', to: 'local' }, metaEmpty);
    expect(trimmed.ok && trimmed.envelope.text).toBe('hi');
    const blank = resolveSendEnvelope({ text: '   ', channel: 'desktop', to: 'local' }, metaEmpty);
    expect(!blank.ok && blank.error).toMatch(/empty/i);
  });

  it('treats a session alias from notify.transports as the session channel', () => {
    const meta = { notify: { transports: { nudge: 'session' } } } as Meta;
    const r = resolveSendEnvelope({ text: ' x ', channel: 'nudge', to: 'abc', terminal: { enter: false } }, meta);
    expect(r.ok && r.envelope).toMatchObject({ text: ' x ', terminal: { enter: false } });
  });

  it('rejects a session send with no message and differing verbatim --text and positional', () => {
    const absent = resolveSendEnvelope({ channel: 'session', to: 'abc' }, metaEmpty);
    expect(!absent.ok && absent.error).toMatch(/empty/i);
    const differ = resolveSendEnvelope({ text: 'a ', positionalText: 'a', channel: 'session', to: 'abc' }, metaEmpty);
    expect(!differ.ok && differ.error).toMatch(/once/i);
  });

  it('lets --pane stand in for --to and refuses a conflicting --to', () => {
    const pane = resolveSendEnvelope({ text: 'x', channel: 'session', terminal: { pane: '%3', socket: '/s' } }, metaEmpty);
    expect(pane.ok && pane.envelope).toMatchObject({ to: '%3', terminal: { pane: '%3', socket: '/s' } });
    const conflict = resolveSendEnvelope({ text: 'x', channel: 'session', to: 'abc', terminal: { pane: '%3' } }, metaEmpty);
    expect(!conflict.ok && conflict.error).toMatch(/different targets/);
  });

  it('refuses terminal options outside the session channel, including owner fan-out, before delivery', async () => {
    const desktop = await sendMessage({ text: 'x', channel: 'desktop', to: 'local', dryRun: true, terminal: { enter: false } }, metaEmpty);
    expect(desktop).toEqual({ error: expect.stringContaining('only apply to --channel session') });
    const owner = await sendMessage({ text: 'x', to: 'owner', dryRun: true, terminal: { combined: true } }, metaEmpty);
    expect(owner).toEqual({ error: expect.stringContaining('only apply to --channel session') });
  });

  it('allows url-only body', () => {
    const r = resolveSendEnvelope(
      { channel: 'desktop', to: 'local', urls: ['https://x.test'] },
      metaEmpty,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.text).toBe('https://x.test');
  });
});
