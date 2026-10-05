/** Guards one line with outsized blast radius: the spinner must be built with `discardStdin:
 * false`. ora's default raw-modes stdin and swallows Ctrl-C for the spinner's lifetime, trapping
 * the user during a long fleet sweep; a silent flip back has no other symptom. */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const oraSpy = vi.fn(() => ({ start: () => ({}) }));
vi.mock('ora', () => ({ default: (opts: unknown) => oraSpy(opts) }));

const { interruptibleSpinner } = await import('./spinner.js');

describe('interruptibleSpinner', () => {
  beforeEach(() => oraSpy.mockClear());

  it('always disables discardStdin so Ctrl-C keeps raising SIGINT', () => {
    interruptibleSpinner('Reaching other machines...');
    expect(oraSpy).toHaveBeenCalledTimes(1);
    const opts = oraSpy.mock.calls[0][0] as { discardStdin?: boolean; text?: string };
    expect(opts.discardStdin).toBe(false);
    expect(opts.text).toBe('Reaching other machines...');
  });

  it('forwards caller options but never lets them re-enable discarding', () => {
    // The type omits discardStdin, but a stray cast at a call site must not win.
    interruptibleSpinner('x', { color: 'cyan', discardStdin: true } as never);
    const opts = oraSpy.mock.calls[0][0] as { discardStdin?: boolean; color?: string };
    expect(opts.color).toBe('cyan');
    expect(opts.discardStdin).toBe(false);
  });

  it('omits text when none is given rather than forcing an empty label', () => {
    interruptibleSpinner();
    const opts = oraSpy.mock.calls[0][0] as { text?: string; discardStdin?: boolean };
    expect('text' in opts).toBe(false);
    expect(opts.discardStdin).toBe(false);
  });
});
