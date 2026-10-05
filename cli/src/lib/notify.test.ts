import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildOpenClawNotifyArgs,
  formatUrgentBlockMessage,
  notifyUrgentBlock,
  sendToOwner,
} from './notify.js';
import { ownerMessageComposer } from './owner-message.js';
import type { Meta } from './types.js';
import type { OpenBlock } from './feed/feed.js';

describe('buildOpenClawNotifyArgs', () => {
  it('builds message-send argv with the caller-supplied target (no hardcoded number)', () => {
    const args = buildOpenClawNotifyArgs('hello', { target: 'chat-42' });
    expect(args).toEqual([
      'message',
      'send',
      '--channel',
      'telegram',
      '--account',
      'default',
      '--target',
      'chat-42',
      '--message',
      'hello',
    ]);
    expect(args).not.toContain('--text');
  });

  it('has no numeric-literal recipient default baked into the source', () => {
    const src = fs.readFileSync(new URL('./notify.ts', import.meta.url), 'utf-8');
    expect(src).not.toMatch(/\?\?\s*['"]\d{5,}['"]/);
  });
});

describe('formatUrgentBlockMessage', () => {
  it('formats urgent feed notifications without emoji', () => {
    const message = formatUrgentBlockMessage({
      blockId: 'block-a',
      sessionId: 'a',
      mailboxId: 'a',
      host: 'zion',
      runtime: 'headless',
      ts: '2026-07-21T12:00:00.000Z',
      blockClass: 'decision',
      costOfDelay: 'high',
      questions: [{ header: 'Deploy', text: 'Production deploy?' }],
    });

    expect(message).toBe('URGENT DECISION on zion: [Deploy] Production deploy? (cost: high, id: block-a)');
    expect(message).not.toContain(String.fromCodePoint(0x1f6a8));
  });
});

describe.skipIf(process.platform === 'win32')('sendToOwner (owner resolution + provider routing)', () => {
  let tmp: string;
  let record: string;
  const savedPath = process.env.PATH;
  const savedRecord = process.env.OPENCLAW_RECORD;

  function metaWithOwner(to: string): Meta {
    return {
      notify: {
        owner: { channel: 'telegram', to },
        transports: { telegram: 'openclaw-telegram' },
      },
    } as Meta;
  }

  function installFakeOpenclaw(): void {
    const bin = path.join(tmp, 'openclaw');
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$OPENCLAW_RECORD"\nexit 0\n`);
    fs.chmodSync(bin, 0o755);
    process.env.PATH = `${tmp}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  }

  function pathWithoutOpenclaw(): void {
    process.env.PATH = `${tmp}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-'));
    record = path.join(tmp, 'argv.log');
    process.env.OPENCLAW_RECORD = record;
    process.env.AGENTS_HUMANS_FILE = path.join(tmp, 'humans.yaml');
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedRecord === undefined) delete process.env.OPENCLAW_RECORD;
    else process.env.OPENCLAW_RECORD = savedRecord;
    delete process.env.AGENTS_HUMANS_FILE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves the recipient from notify.owner.to and hands it to the provider', async () => {
    installFakeOpenclaw();
    const result = await sendToOwner('ping', { meta: metaWithOwner('owner-chat-1') });
    expect(result.ok).toBe(true);
    expect(result.channel).toBe('openclaw-telegram');
    expect(result.id).toBe('owner-chat-1');
    const argv = fs.readFileSync(record, 'utf-8');
    expect(argv).toContain('--target owner-chat-1');
    expect(argv).toContain('--message ping');
  });

  it('follows a change to notify.owner.to (one source of truth)', async () => {
    installFakeOpenclaw();
    await sendToOwner('a', { meta: metaWithOwner('first') });
    await sendToOwner('b', { meta: metaWithOwner('second') });
    const argv = fs.readFileSync(record, 'utf-8');
    expect(argv).toContain('--target first');
    expect(argv).toContain('--target second');
  });

  it('fans out every normal-policy owner channel and reports per-channel results', async () => {
    installFakeOpenclaw();
    fs.writeFileSync(
      process.env.AGENTS_HUMANS_FILE!,
      `version: 1\nowner:\n  channels:\n    - id: imessage\n      transport: rush\n      to: phone-owner\n    - id: slack\n      transport: rush\n      to: slack-owner\n  policy:\n    normal: [imessage, slack]\n`,
    );
    const meta = { notify: { transports: { imessage: 'openclaw-telegram', slack: 'openclaw-telegram' } } } as Meta;
    const result = await sendToOwner('fan out', { meta });
    expect(result.ok).toBe(true);
    expect(result.channel).toBe('owner');
    expect(result.deliveries).toHaveLength(2);
    expect(result.deliveries?.every((delivery) => delivery.ok)).toBe(true);
    const argv = fs.readFileSync(record, 'utf-8');
    expect(argv).toContain('--target phone-owner');
    expect(argv).toContain('--target slack-owner');
  });

  it('surfaces one failed channel without suppressing the successful delivery', async () => {
    installFakeOpenclaw();
    fs.writeFileSync(
      process.env.AGENTS_HUMANS_FILE!,
      `version: 1\nowner:\n  channels:\n    - id: working\n      transport: test\n      to: owner-ok\n    - id: broken\n      transport: test\n      to: owner-fail\n  policy:\n    normal: [working, broken]\n`,
    );
    const meta = { notify: { transports: { working: 'openclaw-telegram', broken: 'missing-provider' } } } as Meta;
    const result = await sendToOwner('partial', { meta });
    expect(result.ok).toBe(true);
    expect(result.deliveries?.map((delivery) => delivery.ok)).toEqual([true, false]);
    expect(result.error).toContain('broken:');
    expect(fs.readFileSync(record, 'utf-8')).toContain('--target owner-ok');
  });

  it('honours a dry-run without exec, echoing the resolved target', async () => {
    installFakeOpenclaw();
    const result = await sendToOwner('ping', { meta: metaWithOwner('owner-chat-2'), dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.id).toBe('owner-chat-2');
    expect(fs.existsSync(record)).toBe(false);
  });

  it('fails loud (not ENOENT) when the provider binary is missing', async () => {
    pathWithoutOpenclaw();
    const result = await sendToOwner('ping', { meta: metaWithOwner('owner-chat-3') });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('openclaw CLI not found on PATH');
    expect(result.error).not.toMatch(/ENOENT/);
  });

  it('fails loud when notify.owner is unset (no hardcoded fallback)', async () => {
    const result = await sendToOwner('ping', { meta: {} as Meta });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('notify.owner');
  });

  it('returns ok:false on an unresolvable channel — never process.exit()', async () => {
    let exited: number | undefined;
    const realExit = process.exit;
    process.exit = ((code?: number) => {
      exited = code ?? 0;
      throw new Error(`process.exit(${exited})`);
    }) as typeof process.exit;
    try {
      const result = await sendToOwner('ping', {
        meta: { notify: { owner: { channel: 'typo-channel', to: 'owner-chat-4' } } } as Meta,
      });
      expect(exited).toBeUndefined();
      expect(result.ok).toBe(false);
      expect(result.channel).toBe('typo-channel');
      expect(result.id).toBe('owner-chat-4');
      expect(result.error).toMatch(/No channel provider 'typo-channel'/);
    } finally {
      process.exit = realExit;
    }
  });
});

describe('sendToOwner composes per destination (PHNX-3698)', () => {
  const savedHumans = process.env.AGENTS_HUMANS_FILE;
  const savedWorkspace = process.env.LINEAR_WORKSPACE;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-perchan-'));
    process.env.AGENTS_HUMANS_FILE = path.join(tmp, 'humans.yaml');
    fs.writeFileSync(
      process.env.AGENTS_HUMANS_FILE,
      `version: 1\nowner:\n  channels:\n    - id: imessage\n      transport: rush\n      to: phone-owner\n    - id: slack\n      transport: rush\n      to: C0SLACKOWNER\n  policy:\n    normal: [imessage, slack]\n`,
    );
    process.env.LINEAR_WORKSPACE = 'getrush';
  });

  afterEach(() => {
    if (savedHumans === undefined) delete process.env.AGENTS_HUMANS_FILE;
    else process.env.AGENTS_HUMANS_FILE = savedHumans;
    if (savedWorkspace === undefined) delete process.env.LINEAR_WORKSPACE;
    else process.env.LINEAR_WORKSPACE = savedWorkspace;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('gives the Slack destination mrkdwn labeled links and iMessage the plain sentence', async () => {
    const raw = 'Deploy never ran. PHNX-3689 is the root cause of the drift.';
    const compose = ownerMessageComposer(raw);
    const result = await sendToOwner(compose('plain'), {
      meta: {} as Meta,
      dryRun: true,
      composeForFormat: compose,
    });
    expect(result.ok).toBe(true);
    expect(result.deliveries).toHaveLength(2);
    const body = Object.fromEntries(result.deliveries!.map((d) => [d.channel, d.body ?? '']));

    expect(body.slack).toContain('<https://linear.app/getrush/issue/PHNX-3689|PHNX-3689>');
    expect(body.imessage).toContain('PHNX-3689');
    expect(body.imessage).not.toContain('<https://');
    expect(body.imessage).not.toContain('http');
    expect(body.slack).not.toEqual(body.imessage);
  });

  it('without a composer, delivers the one verbatim body to every destination', async () => {
    const result = await sendToOwner('plain summary, no links', { meta: {} as Meta, dryRun: true });
    expect(result.deliveries).toHaveLength(2);
    for (const d of result.deliveries!) expect(d.body).toBe('plain summary, no links');
  });
});

describe.skipIf(process.platform === 'win32')('notifyUrgentBlock (feed urgent-block dispatch resolves the owner)', () => {
  let tmp: string;
  let record: string;
  const savedPath = process.env.PATH;
  const savedRecord = process.env.OPENCLAW_RECORD;

  function block(): OpenBlock {
    return {
      blockId: 'b1',
      sessionId: 's1',
      mailboxId: 'm1',
      host: 'zion',
      runtime: 'headless',
      ts: '2026-07-21T12:00:00.000Z',
      questions: [{ header: 'Deploy', text: 'Ship it?' }],
    };
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-block-'));
    record = path.join(tmp, 'argv.log');
    process.env.OPENCLAW_RECORD = record;
    process.env.AGENTS_HUMANS_FILE = path.join(tmp, 'humans.yaml');
    const bin = path.join(tmp, 'openclaw');
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$OPENCLAW_RECORD"\nexit 0\n`);
    fs.chmodSync(bin, 0o755);
    process.env.PATH = `${tmp}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedRecord === undefined) delete process.env.OPENCLAW_RECORD;
    else process.env.OPENCLAW_RECORD = savedRecord;
    delete process.env.AGENTS_HUMANS_FILE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('sends the urgent block to notify.owner.to, not a hardcoded number', async () => {
    const meta = {
      notify: { owner: { channel: 'telegram', to: 'urgent-owner' }, transports: { telegram: 'openclaw-telegram' } },
    } as Meta;
    const result = await notifyUrgentBlock(block(), { meta });
    expect(result.ok).toBe(true);
    const argv = fs.readFileSync(record, 'utf-8');
    expect(argv).toContain('--target urgent-owner');
    expect(argv).toContain('URGENT');
  });

  it('skips an already-notified block without touching the provider', async () => {
    const meta = {
      notify: { owner: { channel: 'telegram', to: 'urgent-owner' }, transports: { telegram: 'openclaw-telegram' } },
    } as Meta;
    const result = await notifyUrgentBlock({ ...block(), notifiedAt: '2026-07-21T12:00:00.000Z' }, { meta });
    expect(result.skipped).toBe(true);
    expect(fs.existsSync(record)).toBe(false);
  });
});

describe.skipIf(process.platform !== 'linux')('sendToOwner forwards over SSH on local failure (PHNX-3303)', () => {
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
  const ownerMeta = { notify: { owner: { channel: 'imessage', to: '+18055551234' } } } as Meta;

  function writeRegistry(reg: object): void {
    fs.writeFileSync(path.join(process.env.AGENTS_DEVICES_DIR!, 'registry.json'), JSON.stringify(reg));
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sendtoowner-forward-'));
    const devicesDir = path.join(tmp, 'devices');
    fs.mkdirSync(devicesDir, { recursive: true });
    process.env.AGENTS_DEVICES_DIR = devicesDir;
    const now = new Date().toISOString();
    writeRegistry({
      'mac-test': {
        name: 'mac-test', platform: 'macos', shell: 'posix',
        address: { via: 'manual', dnsName: 'mac-test.example' },
        auth: { method: 'key' }, createdAt: now, updatedAt: now,
      },
    });
    process.env.AGENTS_SYNC_MACHINE_ID = 'linux-self';
    process.env.AGENTS_HUMANS_FILE = path.join(tmp, 'humans.yaml');

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

  it('hands off to the macOS peer when this box cannot send iMessage', async () => {
    const result = await sendToOwner('ship it', { meta: ownerMeta });
    expect(result.ok).toBe(true);
    const log = fs.readFileSync(sshRecord, 'utf-8');
    expect(log).toContain('mac-test.example');
    expect(log).toContain('AGENTS_OWNER_NO_FORWARD');
    expect(log).toContain('send');
    expect(log).toContain('--channel');
    expect(log).toContain('imessage');
    expect(log).toContain('--to');
    expect(log).toContain('+18055551234');
  });

  it('forwards each policy destination explicitly without re-expanding owner on the peer', async () => {
    fs.writeFileSync(
      process.env.AGENTS_HUMANS_FILE!,
      `version: 1\nowner:\n  channels:\n    - id: imessage\n      transport: rush\n      to: phone-owner\n    - id: slack\n      transport: rush\n      to: slack-owner\n  policy:\n    normal: [imessage, slack]\n`,
    );
    const result = await sendToOwner('ship everywhere', { meta: {} as Meta });
    expect(result.ok).toBe(true);
    expect(result.deliveries).toHaveLength(2);
    const log = fs.readFileSync(sshRecord, 'utf-8');
    expect(log.match(/mac-test\.example/g)).toHaveLength(2);
    expect(log).toContain('imessage');
    expect(log).toContain('phone-owner');
    expect(log).toContain('slack');
    expect(log).toContain('slack-owner');
    expect(log).not.toContain('--to owner');
  });

  it('keeps the clean local error (never dials a peer) when no capable peer exists', async () => {
    writeRegistry({});
    const result = await sendToOwner('ship it', { meta: ownerMeta });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('iMessage requires macOS (peer-forward handles Linux delivery)');
    expect(fs.existsSync(sshRecord)).toBe(false);
  });

  it('fails loud instead of claiming a cross-device attachment was delivered', async () => {
    const result = await sendToOwner('ship it', { meta: ownerMeta, attachments: ['/tmp/evidence.png'] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('attachments cannot be forwarded');
    expect(fs.existsSync(sshRecord)).toBe(false);
  });

  it('does not forward for a Linux-capable transport — only the rush family hops', async () => {
    const meta = {
      notify: { owner: { channel: 'telegram', to: 'c1' }, transports: { telegram: 'openclaw-telegram' } },
    } as Meta;
    const result = await sendToOwner('ship it', { meta });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('openclaw CLI not found on PATH');
    expect(fs.existsSync(sshRecord)).toBe(false);
  });
});
