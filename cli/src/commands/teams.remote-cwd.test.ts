/** `teams add --remote-cwd` is a no-op trap: it rides the shared --device options but `teams add`
 * treats --device as placement and never reads it. The command rejects it with guidance; these pin
 * that guidance against regressing to a bare error. */
import { describe, it, expect } from 'vitest';
import { remoteCwdOnAddError } from './teams.js';

describe('remoteCwdOnAddError', () => {
  it('states the flag has no effect on teams add', () => {
    const msg = remoteCwdOnAddError('wave-cli');
    expect(msg).toContain('--remote-cwd');
    expect(msg).toMatch(/no effect on 'teams add'/);
  });

  it('points at --device for placement and create --repo for the code', () => {
    const msg = remoteCwdOnAddError('wave-cli');
    expect(msg).toContain('--device');
    expect(msg).toContain('agents teams create wave-cli --repo');
  });

  it('threads the actual team name into the suggested commands', () => {
    expect(remoteCwdOnAddError('wave-mono')).toContain('agents teams create wave-mono --repo');
    expect(remoteCwdOnAddError('wave-mono')).toContain('agents teams add wave-mono');
  });
});
