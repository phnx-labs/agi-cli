import { describe, it, expect } from 'vitest';
import { buildRunFinishNotification } from './run-notify.js';
import { buildMenubarNotifyArgs } from './menubar/notify-desktop.js';

describe('run finish notification', () => {
  it('names the run by its --name slug and reports success', () => {
    const n = buildRunFinishNotification(
      {
        agent: 'claude',
        name: 'it-seems-like-the-to',
        prompt: 'Fix the Kimi to-do parsing in the session preview',
        cwd: '/Users/muqsit/src/github.com/muqsitnawaz/agents-cli',
      },
      0,
    );
    expect(n.title).toBe('it-seems-like-the-to finished');
    expect(n.body).toBe('Fix the Kimi to-do parsing in the session preview');
    expect(n.subtitle).toBe('agents-cli');
  });

  it('carries the harness through to the companion argv as the right-hand avatar', () => {
    // The title is the --name slug, which says nothing about which harness ran —
    // the avatar is what identifies it, so `agent` must survive to the one-shot.
    const n = buildRunFinishNotification(
      { agent: 'codex', name: 'it-seems-like-the-to', prompt: 'p' },
      0,
    );
    expect(n.agent).toBe('codex');
    const args = buildMenubarNotifyArgs(n);
    expect(args[args.indexOf('--agent') + 1]).toBe('codex');
  });

  it('reports a non-zero exit as failed and falls back to the agent name', () => {
    const n = buildRunFinishNotification({ agent: 'codex', prompt: 'ship it' }, 1);
    expect(n.title).toBe('codex failed');
    expect(n.body).toBe('ship it');
    expect(n.subtitle).toBeUndefined();
  });

  it('names the box for an off-box dispatch', () => {
    const n = buildRunFinishNotification(
      { agent: 'claude', prompt: 'p', cwd: '/repos/agents-cli', host: 'yosemite-s0' },
      0,
    );
    expect(n.subtitle).toBe('agents-cli · yosemite-s0');
  });

  it('collapses a multi-line prompt and caps the body', () => {
    const n = buildRunFinishNotification(
      { agent: 'claude', prompt: `line one\n  line two\n\n${'x'.repeat(300)}` },
      0,
    );
    expect(n.body).not.toContain('\n');
    expect(n.body.length).toBeLessThanOrEqual(120);
    expect(n.body.endsWith('…')).toBe(true);
  });

  it('carries a clickable URL through to the helper argv', () => {
    const n = buildRunFinishNotification(
      { agent: 'claude', name: 'kimi-todo', prompt: 'p', url: 'https://github.com/phnx-labs/agents-cli/pull/1690' },
      0,
    );
    expect(n.action).toBe('url:https://github.com/phnx-labs/agents-cli/pull/1690');
    expect(buildMenubarNotifyArgs(n)).toEqual([
      '--notify',
      '--title', 'kimi-todo finished',
      '--body', 'p',
      '--action', 'url:https://github.com/phnx-labs/agents-cli/pull/1690',
      '--agent', 'claude',
      '--category', 'done',
      '--choice', 'open-pr=Open PR',
    ]);
  });

  it('a clean finish is the done category and carries the session id', () => {
    const n = buildRunFinishNotification(
      { agent: 'claude', prompt: 'p', sessionId: 'sess-42' },
      0,
    );
    expect(n.category).toBe('done');
    expect(n.sessionId).toBe('sess-42');
  });

  it('a failed run is the failure category', () => {
    const n = buildRunFinishNotification({ agent: 'codex', prompt: 'p' }, 1);
    expect(n.category).toBe('failure');
  });

  it('a report path becomes the open: action and an open-report choice', () => {
    const n = buildRunFinishNotification(
      { agent: 'claude', prompt: 'p', reportPath: '/tmp/run/report.md', url: 'https://example.com/pr/1' },
      0,
    );
    expect(n.action).toBe('open:/tmp/run/report.md');
    expect(n.choices).toEqual([
      { id: 'open-report', label: 'Open report' },
      { id: 'open-pr', label: 'Open PR' },
    ]);
  });
});
