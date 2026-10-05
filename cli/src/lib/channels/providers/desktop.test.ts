import { describe, expect, it } from 'vitest';
import * as os from 'os';
import { desktopProvider, desktopNotifier, desktopDeliverable, splitDesktopMessage } from './desktop.js';
import { spawnSync } from 'child_process';
import { registerBuiltinProviders } from './index.js';
import { resolveChannelProvider, listChannelProviders } from '../registry.js';

describe('splitDesktopMessage', () => {
  it('puts the first line in the title and the link underneath', () => {
    const { title, body } = splitDesktopMessage(
      'agents-cli · release blocked: npm token expired\nhttps://github.com/x/y/pull/1',
    );
    expect(title).toBe('agents-cli · release blocked: npm token expired');
    expect(body).toBe('https://github.com/x/y/pull/1');
  });

  it('keeps a short single-line message whole in the title', () => {
    const { title, body } = splitDesktopMessage('force-push denied on PR #1749');
    expect(title).toBe('force-push denied on PR #1749');
    expect(body).toBe('');
  });

  it('carries the remainder of a long single line into the body, losing nothing', () => {
    const text =
      'force-push denied by git-guard on PR #1749 and I need you to either grant the permission or push it yourself';
    const { title, body } = splitDesktopMessage(text);
    expect(title.length).toBeLessThanOrEqual(64);
    expect(body).not.toBe('');
    expect(`${title} ${body}`.split(/\s+/)).toEqual(text.split(/\s+/));
  });

  it('breaks on a word boundary rather than mid-word', () => {
    const text = `${'a'.repeat(20)} ${'b'.repeat(20)} ${'c'.repeat(40)}`;
    const { title } = splitDesktopMessage(text);
    expect(title.endsWith('-')).toBe(false);
    expect(title.split(/\s+/).every((w) => text.includes(w))).toBe(true);
  });
});

describe('desktopNotifier', () => {
  it('reports a notifier on the platforms notifyDesktop actually wires', () => {
    expect(desktopNotifier('darwin')).toBeTruthy();
    expect(desktopNotifier('linux')).toBeTruthy();
  });

  it('reports none where notifyDesktop is a no-op', () => {
    expect(desktopNotifier('win32')).toBeUndefined();
    expect(desktopNotifier('aix')).toBeUndefined();
  });
});

describe('desktopProvider', () => {
  it('registers as a channel named desktop alongside the other providers', () => {
    registerBuiltinProviders();
    expect(resolveChannelProvider('desktop')).toBeDefined();
    expect(listChannelProviders()).toContain('desktop');
  });

  it('dry-run resolves even where nothing could actually be delivered', async () => {
    const res = await desktopProvider.send('hi', { target: 'local', dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.channel).toBe('desktop');
    expect(res.id).toBe('local');
  });

  it('echoes the hostname when no target is given', async () => {
    const res = await desktopProvider.send('hi', { target: '', dryRun: true });
    expect(res.id).toBe(os.hostname());
  });

  it('refuses an empty message with the caller error, not the platform error', async () => {
    const res = await desktopProvider.send('   \n  ', { target: 'local', dryRun: true });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/empty/i);
    expect(res.error).not.toMatch(/notify-send|no desktop notifier/);
  });

  it('reports honestly for the current platform', async () => {
    const res = await desktopProvider.send('agents-cli test\nbody line', { target: 'local' });
    const deliverable = desktopDeliverable();
    expect(res.ok).toBe(deliverable.ok);
    if (!deliverable.ok) expect(res.error).toBe(deliverable.reason);
  });
});

describe('desktopDeliverable', () => {
  it('probes for notify-send on linux rather than trusting the platform', () => {
    const hasNotifySend = spawnSync('which', ['notify-send'], { stdio: 'ignore' }).status === 0;
    const verdict = desktopDeliverable('linux');
    expect(verdict.ok).toBe(hasNotifySend);
    if (!verdict.ok) expect(verdict.reason).toMatch(/notify-send not on PATH/);
  });

  it('needs no probe on darwin — osascript ships with the OS', () => {
    expect(desktopDeliverable('darwin')).toEqual({ ok: true });
  });

  it('fails loud where notifyDesktop is a no-op', () => {
    const verdict = desktopDeliverable('win32');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/no desktop notifier on win32/);
  });
});
