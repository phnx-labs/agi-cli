import { describe, it, expect } from 'vitest';
import { shouldOpenInteractiveBrowserSessions } from './browser-sessions-picker.js';


describe('shouldOpenInteractiveBrowserSessions', () => {
  it('opens on a bare TTY invocation', () => {
    expect(shouldOpenInteractiveBrowserSessions({}, true)).toBe(true);
  });

  it('never opens off a TTY, regardless of flags', () => {
    expect(shouldOpenInteractiveBrowserSessions({}, false)).toBe(false);
  });

  it('--json always falls through to the static printer', () => {
    expect(shouldOpenInteractiveBrowserSessions({ json: true }, true)).toBe(false);
  });

  it('--open (bare or with a selector) always falls through', () => {
    expect(shouldOpenInteractiveBrowserSessions({ open: true }, true)).toBe(false);
    expect(shouldOpenInteractiveBrowserSessions({ open: 'latest' }, true)).toBe(false);
  });

  it('--no-interactive (interactive: false) opts out even on a TTY with no other flags', () => {
    expect(shouldOpenInteractiveBrowserSessions({ interactive: false }, true)).toBe(false);
  });

  it('interactive: true is a no-op — TTY + no disqualifying flags still governs', () => {
    expect(shouldOpenInteractiveBrowserSessions({ interactive: true }, true)).toBe(true);
    expect(shouldOpenInteractiveBrowserSessions({ interactive: true }, false)).toBe(false);
  });
});
