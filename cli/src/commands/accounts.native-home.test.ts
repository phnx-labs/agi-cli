import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('native logout home safety', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'logout-home-'));
    vi.stubEnv('HOME', root);
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

  async function setup() {
    const state = await import('../lib/state.js');
    const versions = await import('../lib/installations/versions.js');
    const registry = await import('../lib/account-registry.js');
    const commands = await import('./accounts.js');
    const dir = versions.getVersionHomePath('codex', 'personal');
    fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
    const binDir = path.join(versions.getVersionDir('codex', 'personal'), 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\necho codex-cli 0.153.4\n', { mode: 0o755 });
    if (process.platform === 'win32') fs.writeFileSync(path.join(binDir, 'codex.cmd'), '@echo codex-cli 0.153.4\r\n');
    versions.invalidateInstalledVersionsCache('codex');
    const payload = Buffer.from(JSON.stringify({ email: 'personal@example.com', 'https://api.openai.com/auth': {
      chatgpt_account_id: 'personal', chatgpt_user_id: 'user1',
    } })).toString('base64url');
    fs.writeFileSync(path.join(dir, '.codex', 'auth.json'), JSON.stringify({ tokens: { id_token: `fixture.${payload}.unsigned` } }));
    versions.setGlobalDefault('codex', 'personal');
    const work = registry.addNativeAccount('work', 'codex', 'codex:account=work:user=user1', 'work@example.com', 'version');
    return { state, versions, registry, commands, work, dir };
  }

  it('refuses a named account missing locally rather than signing out the global default', async () => {
    const { commands, dir } = await setup();
    const credential = fs.readFileSync(path.join(dir, '.codex', 'auth.json'), 'utf8');
    await expect(commands.resolveLogoutTarget('codex#work')).rejects.toThrow(/no installed/);
    expect(fs.readFileSync(path.join(dir, '.codex', 'auth.json'), 'utf8')).toBe(credential);
  });

  it('rejects a stale recorded home containing another identity', async () => {
    const { commands, state, work } = await setup();
    const meta = state.readMeta();
    state.updateMeta({
      deviceAccounts: { ...meta.deviceAccounts, homes: { [work.id]: 'personal' } },
    });
    await expect(commands.resolveLogoutTarget('codex#work')).rejects.toThrow(/no installed/);
  });

  it('honors the account default and never silently substitutes the installation default', async () => {
    const { commands, state, dir } = await setup();
    const meta = state.readMeta();
    state.updateMeta({ accounts: { ...meta.accounts, defaults: { codex: 'work' } } });
    await expect(commands.resolveLogoutTarget('codex')).rejects.toThrow(/no installed/);
    // An explicit installation label resolves to THAT version home (PHNX-3940:
    // the target now carries the resolved home + its source, not just a label).
    await expect(commands.resolveLogoutTarget('codex@personal')).resolves.toEqual({
      agent: 'codex', version: 'personal', home: dir, source: 'legacy-home',
    });
  });

  it('rejects empty explicit selectors before any account can be selected', async () => {
    const { parseLogoutTarget } = await import('./accounts.js');
    expect(() => parseLogoutTarget('codex#')).toThrow(/Select an account/);
    expect(() => parseLogoutTarget('codex@')).toThrow(/Select an installation/);
  });
});
