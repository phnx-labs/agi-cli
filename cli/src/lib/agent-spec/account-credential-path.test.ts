import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getAccountInfo } from './agents.js';
import { slotDir } from '../accounts/slots.js';

describe('resolveAccountCredentialPath — slot first (PHNX-3940 T5)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't5-cred-'));
  const prevReal = process.env.AGENTS_REAL_HOME;
  const id = `cred-${Date.now()}`;
  const slot = slotDir('grok', id);

  afterEach(() => {
    if (prevReal === undefined) delete process.env.AGENTS_REAL_HOME;
    else process.env.AGENTS_REAL_HOME = prevReal;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(slot, { recursive: true, force: true });
  });

  it('does not inherit another account from AGENTS_REAL_HOME when the home is a slot', async () => {
    process.env.AGENTS_REAL_HOME = tmp;
    fs.mkdirSync(path.join(tmp, '.grok'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.grok', 'auth.json'), JSON.stringify({ email: 'leaked@example.com' }));
    fs.mkdirSync(path.join(slot, '.grok'), { recursive: true });
    const info = await getAccountInfo('grok', slot);
    expect(info.email).not.toBe('leaked@example.com');
    expect(info.signedIn).toBe(false);
  });

  it('does not borrow the shared ~/.grok login for a version home the launcher pins with GROK_HOME', async () => {
    process.env.AGENTS_REAL_HOME = tmp;
    fs.mkdirSync(path.join(tmp, '.grok'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.grok', 'auth.json'), JSON.stringify({ email: 'shared@example.com', refresh_token: 'rt' }));
    const versionHome = fs.mkdtempSync(path.join(tmp, 'grok-version-home-'));
    fs.mkdirSync(path.join(versionHome, '.grok'), { recursive: true });
    const info = await getAccountInfo('grok', versionHome);
    expect(info.email).toBeNull();
    expect(info.signedIn).toBe(false);
  });

  it('still falls back to the shared home for a harness the launcher does not pin', async () => {
    process.env.AGENTS_REAL_HOME = tmp;
    fs.mkdirSync(path.join(tmp, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.cursor', 'cli-config.json'), JSON.stringify({ authInfo: { email: 'shared@example.com' } }));
    fs.writeFileSync(path.join(tmp, '.cursor', 'auth.json'), JSON.stringify({ accessToken: 'tok' }));
    const versionHome = fs.mkdtempSync(path.join(tmp, 'cursor-version-home-'));
    const info = await getAccountInfo('cursor', versionHome);
    expect(info.email).toBe('shared@example.com');
  });
});
