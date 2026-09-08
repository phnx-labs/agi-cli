import { describe, expect, it } from 'vitest';
import { isReadQuery } from './sessions-client.js';

describe('isReadQuery', () => {
  it('sends list/search/id to the standalone', () => {
    expect(isReadQuery(['auth middleware', '--json', '--limit', '5'])).toBe(true);
    expect(isReadQuery(['--json', '--limit', '5'])).toBe(true);
    expect(isReadQuery(['a1b2c3d4', '--json'])).toBe(true);
    expect(isReadQuery(['--local', '--limit', '20'])).toBe(true);
  });

  it('keeps lifecycle verbs and live flags on the in-repo engine', () => {
    expect(isReadQuery(['resume', 'a1b2c3d4'])).toBe(false);
    expect(isReadQuery(['--active'])).toBe(false);
    expect(isReadQuery(['--markdown', 'a1b2c3d4'])).toBe(false);
    expect(isReadQuery(['watch', '--json'])).toBe(false);
    expect(isReadQuery(['--device', 'mac-mini'])).toBe(false);
  });
});
