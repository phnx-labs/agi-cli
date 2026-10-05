/** RUSH-2022: a session that ran on another device must never resume here. Real path, no mocks:
 * `sessionOwnerDevice` reads `isSelfHost()`, and tests drive it through the
 * `AGENTS_SYNC_MACHINE_ID` override. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sessionOwnerDevice } from './resume-owner.js';
import { resetSelfHostCache } from '../devices/self-host.js';

const SELF = 'test-owner-box';

beforeEach(() => {
  process.env.AGENTS_SYNC_MACHINE_ID = SELF;
  resetSelfHostCache();
});

afterEach(() => {
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  resetSelfHostCache();
});

describe('sessionOwnerDevice', () => {
  it('names the peer for a session whose transcript originated elsewhere', () => {
    // The exact shape of a synced mirror row: machine-tagged, readable here.
    expect(sessionOwnerDevice({ machine: 'zion' })).toBe('zion');
  });

  it('is case- and domain-insensitive about this machine', () => {
    expect(sessionOwnerDevice({ machine: SELF })).toBeUndefined();
    expect(sessionOwnerDevice({ machine: SELF.toUpperCase() })).toBeUndefined();
  });

  it('leaves an untagged row alone rather than inventing a target', () => {
    expect(sessionOwnerDevice({})).toBeUndefined();
    expect(sessionOwnerDevice({ machine: '' })).toBeUndefined();
    expect(sessionOwnerDevice({ machine: '   ' })).toBeUndefined();
  });
});
