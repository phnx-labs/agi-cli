import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hostNeedsRestart } from './client.js';
import { acquireHostLock } from './host.js';
import { ensureLeadDir } from './paths.js';

describe('Lead host lifecycle', () => {
  it('restarts a host whose CLI version or model differs from the caller', () => {
    const want = { version: '1.2.3', model: 'sonnet' };
    expect(hostNeedsRestart({ version: '1.2.3', model: 'sonnet' }, want)).toBe(false);
    expect(hostNeedsRestart({ version: '1.2.2', model: 'sonnet' }, want)).toBe(true);
    expect(hostNeedsRestart({ version: '1.2.3', model: 'haiku' }, want)).toBe(true);
    expect(hostNeedsRestart(null, want)).toBe(true);
  });

  it('refuses a lock held by a live process and takes over a dead one', () => {
    const paths = ensureLeadDir('lock-demo');
    fs.writeFileSync(paths.lock, String(process.ppid));
    expect(() => acquireHostLock(paths)).toThrow(/holds/);
    fs.writeFileSync(paths.lock, '2147483646');
    acquireHostLock(paths);
    expect(fs.readFileSync(paths.lock, 'utf-8')).toBe(String(process.pid));
    fs.rmSync(paths.lock);
  });
});
