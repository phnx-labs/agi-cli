import { describe, it, expect } from 'vitest';
import { secretsBrokerHealthLine } from './daemon.js';

// Strip ANSI so the assertions hold whether or not chalk colorizes.
const plain = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');

describe('secretsBrokerHealthLine (PHNX-4116)', () => {
  it('a file-backed worker with no broker reads INFO, not down/unreachable', () => {
    const line = plain(secretsBrokerHealthLine({
      reachable: false, fileBacked: true, socketPath: null, heldBundles: null, record: null,
    }));
    expect(line).toContain('info');
    expect(line).toContain('secrets agent not running (file-backed stores)');
    expect(line).not.toContain('down');
    expect(line).not.toContain('unreachable');
  });

  it('a keychain-backed box with no broker is a real fault: down (unreachable)', () => {
    const line = plain(secretsBrokerHealthLine({
      reachable: false, fileBacked: false, socketPath: null, heldBundles: null, record: null,
    }));
    expect(line).toContain('down');
    expect(line).toContain('unreachable');
    expect(line).not.toContain('info');
  });

  it('a reachable broker reads healthy with its held-bundle count', () => {
    const line = plain(secretsBrokerHealthLine({
      reachable: true, fileBacked: false, socketPath: null, heldBundles: 3, record: null,
    }));
    expect(line).toContain('healthy');
    expect(line).toContain('3 bundle(s) held');
  });
});
