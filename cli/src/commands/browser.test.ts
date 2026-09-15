import { describe, expect, it } from 'vitest';
import { BROWSER_PASSTHROUGH_VERBS, peekDevice } from './browser.js';

// The verb catalog is agents-cli's half of the contract with the standalone
// `browser` engine: it is what `agents browser --help` lists and what the help
// groups index. A verb dropped here silently disappears from the surface even
// though the engine still implements it, so the catalog is pinned. `sessions` is
// deliberately NOT in the passthrough set — it is agents-cli's own reader.
describe('BROWSER_PASSTHROUGH_VERBS', () => {
  const names = BROWSER_PASSTHROUGH_VERBS.map((v) => v.name);

  it('covers the standalone browser verb surface, minus the agents-owned `sessions`', () => {
    expect(names).toEqual([
      'use', 'start', 'done', 'status', 'prune', 'stream',
      'navigate', 'tabs', 'screenshot', 'evaluate', 'click', 'type', 'press', 'wait',
      'console', 'errors', 'requests', 'responsebody', 'record', 'pdf', 'logs',
      'history', 'refs',
      'profiles', 'remote-control', 'stop', 'show', 'tab', 'ps', 'tasks', 'hover',
      'scroll', 'upload', 'set', 'devices', 'download', 'waitdownload',
    ]);
  });

  it('never lists `sessions` — that verb reads agents-cli\'s own history, not the engine', () => {
    expect(names).not.toContain('sessions');
  });

  it('every verb carries a one-line description for `agents browser --help`', () => {
    for (const verb of BROWSER_PASSTHROUGH_VERBS) {
      expect(verb.description.length, verb.name).toBeGreaterThan(0);
    }
  });
});

// `--device` is resolved (only on `start`) to the fd-3 fleet target, then
// forwarded VERBATIM so the engine matches its own `--device <alias>` against the
// context. peekDevice reads it without consuming it.
describe('peekDevice', () => {
  it('reads --device <name>', () => {
    expect(peekDevice(['start', '--profile', 'work', '--device', 'box'])).toBe('box');
  });

  it('reads --device=<name>', () => {
    expect(peekDevice(['start', '--device=box', '--profile', 'work'])).toBe('box');
  });

  it('returns undefined when no --device is present (a local invocation)', () => {
    expect(peekDevice(['navigate', 'https://example.com'])).toBeUndefined();
  });

  it('reads `local` verbatim — the engine forces this machine on that value', () => {
    expect(peekDevice(['start', '--device', 'local'])).toBe('local');
  });
});
