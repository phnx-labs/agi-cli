import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hasKeychainTokenSync,
  listKeychainItems,
  readBundleSync,
  secretsKeychainItem,
  setKeychainTokenSync,
  storeGetSync,
  writeBundleWithItemsSync,
} from './secrets-client.js';
import { standaloneKeychainIsFileBacked, useFreshSecretsHome } from '../../tests/secrets-standalone.js';
import { readMeta, updateMeta, getUserAgentsDir, getDeviceMetaPath, getVersionsDir } from './state.js';
import { invalidateInstalledVersionsCache } from './installations/store.js';
import {
  addAccount,
  addNativeAccount,
  bindAccount,
  findNativeAccountByIdentity,
  findUnifiedAccount,
  inspectAccount,
  labelNativeAccount,
  listNativeAccounts,
  nativeAccountHome,
  readAccountRegistry,
  removeAccount,
  renameAccount,
  resolveAccountSelection,
  resolveCredentialAccount,
  resolveSpawnAccount,
  setAccountSecret,
  setDefaultAccountIfAbsent,
  type AccountRegistryDocument,
} from './account-registry.js';

describe('findUnifiedAccount does not touch the provider store for a native lookup', () => {
  // A registry whose every access throws — stands in for a device whose provider
  // bundle read / legacy migration / keychain decrypt would fail (the real crash).
  const poisoned = new Proxy({} as AccountRegistryDocument, {
    get() { throw new Error('provider registry accessed'); },
  });
  const meta = {
    accounts: { native: { 'id-1': { id: 'id-1', name: 'work', agent: 'claude' as const, identityKey: 'claude:user=1', scope: 'version' as const } } },
  };

  it('returns a native account without reading the provider registry', () => {
    expect(findUnifiedAccount('work', meta, poisoned)).toMatchObject({ kind: 'native', name: 'work', agent: 'claude' });
    expect(findUnifiedAccount('id-1', meta, poisoned)).toMatchObject({ kind: 'native', id: 'id-1' });
  });

  it('reaches the provider registry only when the name is not a native account', () => {
    expect(() => findUnifiedAccount('not-native', meta, poisoned)).toThrow('provider registry accessed');
  });
});

describe('native account labels', () => {
  beforeEach(() => updateMeta(meta => ({ ...meta, accounts: { ...meta.accounts, native: {} } })));
  afterEach(() => updateMeta(meta => ({ ...meta, accounts: { ...meta.accounts, native: {} } })));

  it('writes and resolves a manual label and the implicit email label', () => {
    const original = labelNativeAccount('codex', 'codex:user=1', 'user@example.com', 'work', 'version');
    expect(findUnifiedAccount('work', readMeta())).toMatchObject({ id: original.id, identityKey: 'codex:user=1' });
    const relabeled = labelNativeAccount('codex', 'codex:user=1', 'user@example.com', undefined, 'version');
    expect(relabeled.id).toBe(original.id);
    expect(findUnifiedAccount('user@example.com', readMeta())).toMatchObject({ id: original.id, name: 'user@example.com' });
  });

  it('requires a manual label when the harness exposes no email', () => {
    expect(() => labelNativeAccount('kimi', 'kimi:opaque=1', undefined, undefined, 'version')).toThrow('pass a manual label');
  });

  // PHNX-3887: one human identity signed into several harnesses must be able to
  // carry the SAME label on each. A global namespace let the first harness
  // labelled squat the good name and forced prefixes (cxicloud, gkicloud).
  it('lets separate harnesses share one label name', () => {
    const claude = labelNativeAccount('claude', 'claude:user=1', 'me@example.com', 'icloud', 'version');
    const codex = labelNativeAccount('codex', 'codex:user=1', 'me@example.com', 'icloud', 'version');
    const grok = labelNativeAccount('grok', 'grok:user=1', 'me@example.com', 'icloud', 'version');
    expect(new Set([claude.id, codex.id, grok.id]).size).toBe(3);
    // `<harness>#<label>` resolves to that harness's own row, not whichever
    // happened to be written first.
    expect(findUnifiedAccount('icloud', readMeta(), undefined, 'claude')).toMatchObject({ id: claude.id, agent: 'claude' });
    expect(findUnifiedAccount('icloud', readMeta(), undefined, 'codex')).toMatchObject({ id: codex.id, agent: 'codex' });
    expect(findUnifiedAccount('icloud', readMeta(), undefined, 'grok')).toMatchObject({ id: grok.id, agent: 'grok' });
  });

  it('still rejects a duplicate label within the same harness', () => {
    labelNativeAccount('codex', 'codex:user=1', 'first@example.com', 'work', 'version');
    expect(() => labelNativeAccount('codex', 'codex:user=2', 'second@example.com', 'work', 'version'))
      .toThrow("Account 'work' already exists for the codex harness.");
  });

  // PHNX-3988: rename/remove/view must honor the same per-harness namespace that
  // connect/label already do. A fleet-wide uniqueness check refused Codex
  // renaming `cxicloud` → `icloud` because Claude already owned `icloud`.
  it('lets a harness take a name another harness already uses', () => {
    labelNativeAccount('claude', 'claude:user=1', 'me@example.com', 'icloud', 'version');
    labelNativeAccount('codex', 'codex:user=1', 'me@example.com', 'cxicloud', 'version');
    renameAccount('cxicloud', 'icloud');
    expect(findUnifiedAccount('icloud', readMeta(), undefined, 'claude')).toMatchObject({ agent: 'claude', name: 'icloud' });
    expect(findUnifiedAccount('icloud', readMeta(), undefined, 'codex')).toMatchObject({ agent: 'codex', name: 'icloud' });
    expect(findUnifiedAccount('cxicloud', readMeta())).toBeNull();
  });

  it('still refuses a rename onto a name taken within the same harness', () => {
    labelNativeAccount('codex', 'codex:user=1', 'first@example.com', 'icloud', 'version');
    labelNativeAccount('codex', 'codex:user=2', 'second@example.com', 'work', 'version');
    expect(() => renameAccount('work', 'icloud'))
      .toThrow("Account 'icloud' already exists for the codex harness.");
  });

  it('refuses a bare name shared by several harnesses; a harness selector scopes rename and remove', () => {
    const claude = labelNativeAccount('claude', 'claude:user=1', 'me@example.com', 'icloud', 'version');
    const codex = labelNativeAccount('codex', 'codex:user=1', 'me@example.com', 'icloud', 'version');
    const ambiguous = "Account 'icloud' exists for several harnesses (claude, codex). Pick one with <harness>#icloud, e.g. claude#icloud.";
    expect(() => renameAccount('icloud', 'cloud')).toThrow(ambiguous);
    expect(() => removeAccount('icloud')).toThrow(ambiguous);

    renameAccount('codex#icloud', 'cloud');
    const afterRename = listNativeAccounts(readMeta());
    expect(afterRename.filter(account => account.agent === 'claude')).toEqual([
      expect.objectContaining({ id: claude.id, name: 'icloud' }),
    ]);
    expect(afterRename.filter(account => account.agent === 'codex')).toEqual([
      expect.objectContaining({ id: codex.id, name: 'cloud' }),
    ]);

    removeAccount('claude#icloud');
    const afterRemove = listNativeAccounts(readMeta());
    expect(afterRemove.filter(account => account.agent === 'claude')).toEqual([]);
    expect(afterRemove.filter(account => account.agent === 'codex')).toEqual([
      expect.objectContaining({ id: codex.id, name: 'cloud' }),
    ]);
  });

  it('scopes a shared-name defaults sweep to the renamed harness', () => {
    labelNativeAccount('claude', 'claude:user=1', 'me@example.com', 'icloud', 'version');
    labelNativeAccount('codex', 'codex:user=1', 'me@example.com', 'icloud', 'version');
    const previousDefaults = readMeta().accounts?.defaults;
    try {
      updateMeta(meta => ({
        ...meta,
        accounts: { ...meta.accounts, defaults: { claude: 'icloud', codex: 'icloud' } },
      }));
      renameAccount('codex#icloud', 'cloud');
      const defaults = readMeta().accounts?.defaults;
      expect(defaults?.codex).toBe('cloud');
      expect(defaults?.claude).toBe('icloud');
    } finally {
      updateMeta(meta => ({ ...meta, accounts: { ...meta.accounts, defaults: previousDefaults } }));
    }
  });

  it('throws for an unknown harness selector and a harness-scoped miss', () => {
    expect(() => renameAccount('nope#x', 'y')).toThrow("Unknown agent 'nope'.");
    expect(() => removeAccount('nope#x')).toThrow("Unknown agent 'nope'.");
    expect(() => renameAccount('codex#icloud', 'cloud')).toThrow("Unknown codex account 'icloud'.");
    expect(() => removeAccount('codex#icloud')).toThrow("Unknown codex account 'icloud'.");
  });

  it('removeAccount deletes every central row for the resolved (agent, identityKey)', () => {
    // Two independently labeled boxes merge via git into two UUID rows for one identity.
    const identityKey = 'codex:account=dup:user=x:org=y';
    const row = (id: string) => ({
      id,
      name: 'personal',
      agent: 'codex' as const,
      identityKey,
      identityLabel: 'x@example.com',
      scope: 'version' as const,
    });
    updateMeta(meta => ({
      ...meta,
      accounts: {
        ...meta.accounts,
        native: {
          'uuid-from-box-a': row('uuid-from-box-a'),
          'uuid-from-box-b': row('uuid-from-box-b'),
        },
      },
    }));
    expect(findUnifiedAccount('personal', readMeta())).toMatchObject({ name: 'personal', identityKey });

    removeAccount('personal');

    expect(findUnifiedAccount('personal', readMeta())).toBeNull();
    expect(findUnifiedAccount('uuid-from-box-a', readMeta())).toBeNull();
    expect(findUnifiedAccount('uuid-from-box-b', readMeta())).toBeNull();
    expect(listNativeAccounts(readMeta()).filter(account => account.identityKey === identityKey)).toEqual([]);
  });

  it('renameAccount and labelNativeAccount rewrite every sibling row for the identity', () => {
    const identityKey = 'codex:account=dup:user=x:org=y';
    const row = (id: string, name: string) => ({
      id,
      name,
      agent: 'codex' as const,
      identityKey,
      identityLabel: 'x@example.com',
      scope: 'version' as const,
    });
    updateMeta(meta => ({
      ...meta,
      accounts: {
        ...meta.accounts,
        native: {
          'uuid-from-box-a': row('uuid-from-box-a', 'personal'),
          'uuid-from-box-b': row('uuid-from-box-b', 'personal'),
        },
      },
    }));

    renameAccount('personal', 'home');
    expect(findUnifiedAccount('personal', readMeta())).toBeNull();
    const renamed = listNativeAccounts(readMeta()).filter(account => account.identityKey === identityKey);
    expect(renamed).toHaveLength(2);
    expect(renamed.every(account => account.name === 'home')).toBe(true);

    labelNativeAccount('codex', identityKey, 'x@example.com', 'desk', 'version');
    const relabeled = listNativeAccounts(readMeta()).filter(account => account.identityKey === identityKey);
    expect(relabeled).toHaveLength(2);
    expect(relabeled.every(account => account.name === 'desk')).toBe(true);
    expect(findUnifiedAccount('home', readMeta())).toBeNull();
  });
});

// Account bundles carry no explicit backend, so on a headed macOS box the real
// standalone would write them to the operator's login keychain; the bundle
// suites run where keychain items are file-backed (headless Linux/Windows, CI).
const fileBacked = await standaloneKeychainIsFileBacked();

/** The raw bundle-metadata blob the standalone stored for `name` (identity vars, no secret). */
function metadataBlob(name: string): string {
  const bundle = readBundleSync(name);
  return storeGetSync(bundle.backend ?? 'keychain', `agents-cli.bundles.${name}`);
}

describe.skipIf(!fileBacked)('credential account registry (bundle-canonical)', () => {
  let root: string;
  useFreshSecretsHome();
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-accounts-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stores the account as a never-policy bundle with the secret out of the metadata', async () => {
    addAccount('work', 'openrouter', 'api-key', 'sk-or-secret', root);
    // No accounts.yaml is written — the bundle is the canonical store.
    expect(fs.existsSync(path.join(root, 'accounts.yaml'))).toBe(false);
    expect(await listKeychainItems('agents-cli.bundles.')).toEqual(['agents-cli.bundles.work']);
    const blob = metadataBlob('work');
    const meta = JSON.parse(blob);
    expect(meta.tier).toBe('none'); // policy 'never' → no biometry ACL → syncs without Touch ID
    expect(meta.vars.PROVIDER).toBe('openrouter');
    expect(meta.vars.AUTH_TYPE).toBe('api-key');
    expect(meta.vars.API_KEY).toBe('keychain:API_KEY');
    expect(typeof meta.vars.ACCOUNT_ID).toBe('string');
    expect(blob).not.toContain('sk-or-secret'); // secret bytes never in metadata
    expect(hasKeychainTokenSync(secretsKeychainItem('work', 'API_KEY'))).toBe(true);
  });

  it('refuses to overwrite an ordinary secrets bundle with the same name', () => {
    const otherItem = secretsKeychainItem('prod', 'OTHER');
    writeBundleWithItemsSync({ name: 'prod', vars: { OTHER: 'keychain:OTHER' } }, new Map([[otherItem, 'keep-me']]));
    expect(() => addAccount('prod', 'openrouter', 'api-key', 'sk-new', root)).toThrow("Secrets bundle 'prod' already exists");
    expect(hasKeychainTokenSync(otherItem)).toBe(true);
  });

  it('resolves one account across compatible hosts', () => {
    addAccount('work', 'openrouter', 'api-key', 'sk-or-secret', root);
    expect(resolveCredentialAccount('work', 'claude', undefined, root).env).toEqual({
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: 'sk-or-secret',
    });
    expect(resolveCredentialAccount('work', 'codex', undefined, root).env).toEqual({
      OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENAI_API_KEY: 'sk-or-secret',
    });
  });

  it('resolves a policy-never account when the optional secrets broker is disabled', () => {
    const previousConfigDir = process.env.AGENTS_DAEMON_CONFIG_DIR;
    const configDir = fs.mkdtempSync(path.join(root, 'daemon-config-'));
    fs.writeFileSync(path.join(configDir, 'services.yaml'), 'services:\n  secrets-broker: false\n', 'utf8');
    process.env.AGENTS_DAEMON_CONFIG_DIR = configDir;
    try {
      addAccount('headless', 'openrouter', 'api-key', 'sk-or-secret', root);
      expect(resolveCredentialAccount('headless', 'claude', undefined, root).env.ANTHROPIC_AUTH_TOKEN).toBe('sk-or-secret');
    } finally {
      if (previousConfigDir === undefined) delete process.env.AGENTS_DAEMON_CONFIG_DIR;
      else process.env.AGENTS_DAEMON_CONFIG_DIR = previousConfigDir;
    }
  });

  it('injects a per-account BASE_URL override over the provider default', () => {
    addAccount('gw', 'openrouter', 'api-key', 'sk-or-secret', root, { baseUrl: 'https://gateway.internal/api' });
    expect(inspectAccount('gw', root).baseUrl).toBe('https://gateway.internal/api');
    expect(resolveCredentialAccount('gw', 'claude', undefined, root).env).toEqual({
      ANTHROPIC_BASE_URL: 'https://gateway.internal/api',
      ANTHROPIC_AUTH_TOKEN: 'sk-or-secret',
    });
  });

  it('injects an OpenAI BASE_URL override into Codex', () => {
    addAccount('openai-proxy', 'openai', 'api-key', 'sk-secret', root, { baseUrl: 'https://gateway.internal/v1' });
    expect(resolveCredentialAccount('openai-proxy', 'codex', undefined, root).env).toEqual({
      OPENAI_BASE_URL: 'https://gateway.internal/v1',
      OPENAI_API_KEY: 'sk-secret',
    });
  });

  it('fails loud when a host cannot apply the stored BASE_URL override', () => {
    addAccount('google-proxy', 'google', 'api-key', 'secret', root, { baseUrl: 'https://gateway.internal/v1' });
    expect(() => resolveCredentialAccount('google-proxy', 'gemini', undefined, root)).toThrow(
      "provider 'google' cannot apply it to the gemini harness",
    );
  });

  it('prefers explicit selection, then a per-harness default', () => {
    const meta = { accounts: { defaults: { claude: 'default-work' } } };
    expect(resolveAccountSelection('one-run', 'claude', meta)).toEqual({ id: 'one-run', source: 'explicit' });
    expect(resolveAccountSelection(undefined, 'claude', meta)).toEqual({ id: 'default-work', source: 'default' });
    expect(resolveAccountSelection(undefined, 'codex', meta)).toBeUndefined();
    expect(resolveAccountSelection(undefined, 'claude', meta, { useDefault: false })).toBeUndefined();
    expect(resolveAccountSelection('profile-override', 'claude', meta, { useDefault: false })).toEqual({ id: 'profile-override', source: 'explicit' });
  });

  it('resolves exact installation and device-scoped bindings before a harness default', () => {
    const meta = {
      accounts: {
        defaults: { claude: 'default-work' },
        bindings: { 'claude@2.1.220': 'native-work', cursor: 'cursor-device' },
      },
    };
    expect(resolveAccountSelection(undefined, 'claude', meta, { target: 'claude@2.1.220' })).toEqual({ id: 'native-work', source: 'binding' });
    expect(resolveAccountSelection(undefined, 'claude', meta, { target: 'claude@2.1.225' })).toEqual({ id: 'default-work', source: 'default' });
    expect(resolveAccountSelection(undefined, 'cursor', meta, { target: 'cursor@latest' })).toEqual({ id: 'cursor-device', source: 'binding' });
    expect(resolveAccountSelection('one-run', 'claude', meta, { target: 'claude@2.1.220' })).toEqual({ id: 'one-run', source: 'explicit' });
  });

  it('resolveSpawnAccount classifies provider (with env) vs native (no keychain read), following bindings', () => {
    addAccount('prov', 'cursor', 'api-key', 'device-key', root);
    // Provider selection resolves the injected env at spawn time.
    const provider = resolveSpawnAccount('prov', 'cursor', '1.0.0', { accounts: {} }, { base: root });
    expect(provider).toMatchObject({ kind: 'provider', name: 'prov' });
    expect(provider?.kind === 'provider' && provider.env).toEqual({ CURSOR_API_KEY: 'device-key' });

    // An exact agent@version binding selects a native account, classified from
    // meta alone — no provider bundle / keychain read (base is a temp home).
    const meta = {
      accounts: {
        native: { n1: { id: 'n1', name: 'work', agent: 'claude' as const, identityKey: 'claude:user=1', scope: 'version' as const } },
        bindings: { 'claude@2.1.220': 'n1' },
      },
    };
    const native = resolveSpawnAccount(undefined, 'claude', '2.1.220', meta, { base: root });
    expect(native).toMatchObject({ kind: 'native', name: 'work', agent: 'claude', identityKey: 'claude:user=1', scope: 'version' });
    // A different version is not covered by the exact binding → nothing selected.
    expect(resolveSpawnAccount(undefined, 'claude', '2.1.225', meta, { base: root })).toBeNull();
  });

  it('resolveSpawnAccount binds a custom harness by its raw profile name, not agent@version', () => {
    addAccount('or', 'openrouter', 'api-key', 'sk-or', root);
    const doc = readAccountRegistry(root);
    const account = doc.accounts[Object.keys(doc.accounts)[0]];
    // A profile named 'deepseek' running on the claude host, bound by profile name.
    const meta = { accounts: { bindings: { deepseek: account.id } } };
    // With the profile target, the deepseek binding is found...
    const viaProfile = resolveSpawnAccount(undefined, 'claude', '2.1.220', meta, { base: root, target: 'deepseek' });
    expect(viaProfile).toMatchObject({ kind: 'provider', name: 'or' });
    // ...while the same run keyed on agent@version (no profile) sees no binding.
    expect(resolveSpawnAccount(undefined, 'claude', '2.1.220', meta, { base: root })).toBeNull();
  });

  it('resolveSpawnAccount refuses a native account on a provider-backed harness (explicit --account override)', () => {
    // `agents run deepseek --account work`: deepseek hosts on claude with an
    // OpenRouter provider, so a native claude login must be rejected before spawn
    // — otherwise the provider env would still be injected under a native claim.
    const meta = {
      accounts: { native: { n1: { id: 'n1', name: 'work', agent: 'claude' as const, identityKey: 'claude:user=1', scope: 'version' as const } } },
    };
    expect(() => resolveSpawnAccount('work', 'claude', '2.1.220', meta, { base: root, provider: 'openrouter' }))
      .toThrow('cannot run under a provider-backed harness (openrouter)');
    // Without a provider (a bare native run) the same account resolves fine.
    expect(resolveSpawnAccount('work', 'claude', '2.1.220', meta, { base: root })).toMatchObject({ kind: 'native', name: 'work' });
  });

  it('resolveSpawnAccount refuses a native account bound to a different harness', () => {
    const meta = {
      accounts: {
        native: { n1: { id: 'n1', name: 'work', agent: 'claude' as const, identityKey: 'k', scope: 'version' as const } },
        bindings: { codex: 'n1' },
      },
    };
    expect(() => resolveSpawnAccount(undefined, 'codex', '1.0.0', meta, { base: root }))
      .toThrow('is a claude login and cannot authenticate the codex harness');
  });

  it('findUnifiedAccount without preferAgent still returns the first match (management lookups unchanged)', () => {
    // Identity-label collisions still fall through to store order: rename/remove/view
    // refuse an ambiguous *name* before calling findUnifiedAccount, but an email
    // that several harnesses share is a legitimate un-scoped lookup. That path
    // must behave exactly as it did before preferAgent existed.
    const meta = {
      accounts: {
        native: {
          c1: { id: 'c1', name: 'personal', agent: 'codex' as const, identityKey: 'codex:user=1', identityLabel: 'muqsitnawaz@gmail.com', scope: 'version' as const },
          c2: { id: 'c2', name: 'gmail', agent: 'claude' as const, identityKey: 'claude:user=2', identityLabel: 'muqsitnawaz@gmail.com', scope: 'version' as const },
        },
      },
    };
    expect(findUnifiedAccount('muqsitnawaz@gmail.com', meta)).toMatchObject({ name: 'personal', agent: 'codex' });
    // ...and naming either row explicitly is unaffected by the collision.
    expect(findUnifiedAccount('gmail', meta)).toMatchObject({ name: 'gmail', agent: 'claude' });
  });

  it('resolveSpawnAccount picks the launched harness when one identity selector matches several logins', () => {
    // `identityLabel` defaults to the login's email, so the SAME selector matches a
    // codex login and a claude login. `agents run claude#muqsitnawaz@gmail.com` used
    // to resolve whichever row the store ordered first and die with "is a codex
    // login and cannot authenticate the claude harness".
    const meta = {
      accounts: {
        native: {
          c1: { id: 'c1', name: 'personal', agent: 'codex' as const, identityKey: 'codex:user=1', identityLabel: 'muqsitnawaz@gmail.com', scope: 'version' as const },
          c2: { id: 'c2', name: 'gmail', agent: 'claude' as const, identityKey: 'claude:user=2', identityLabel: 'muqsitnawaz@gmail.com', scope: 'version' as const },
        },
      },
    };
    expect(resolveSpawnAccount('muqsitnawaz@gmail.com', 'claude', '2.1.226', meta, { base: root }))
      .toMatchObject({ kind: 'native', agent: 'claude', name: 'gmail' });
    // The same selector on the other harness still resolves to that harness's login.
    expect(resolveSpawnAccount('muqsitnawaz@gmail.com', 'codex', '0.146.0', meta, { base: root }))
      .toMatchObject({ kind: 'native', agent: 'codex', name: 'personal' });
  });

  it('resolveSpawnAccount still refuses when the identity has no login for the launched harness', () => {
    // Scoping must not soften the cross-harness guard: with only a codex login for
    // this identity, a claude run has nothing to authenticate with and must fail loud
    // rather than silently borrowing the codex row.
    const meta = {
      accounts: {
        native: { c1: { id: 'c1', name: 'personal', agent: 'codex' as const, identityKey: 'codex:user=1', identityLabel: 'solo@example.com', scope: 'version' as const } },
      },
    };
    expect(() => resolveSpawnAccount('solo@example.com', 'claude', '2.1.226', meta, { base: root }))
      .toThrow('is a codex login and cannot authenticate the claude harness');
  });

  it('resolveSpawnAccount warns and falls back when the configured default is dangling', () => {
    const danglingId = 'd4a2d110-17fe-4341-a1c5-b1222ed91557';
    const meta = { accounts: { defaults: { claude: danglingId } } };
    const writes: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; };
    try {
      const result = resolveSpawnAccount(undefined, 'claude', '2.1.220', meta, { base: root });
      expect(result).toBeNull();
      const warning = writes.join('');
      expect(warning).toContain(`default account '${danglingId}' for claude no longer exists`);
      expect(warning).toContain('falling back to balanced selection');
      expect(warning).toContain('agents accounts clear-default claude');
    } finally {
      process.stderr.write = original;
    }
  });

  it('resolveSpawnAccount fails loud when a stale binding shares an id with a stale default', () => {
    const danglingId = 'd4a2d110-17fe-4341-a1c5-b1222ed91557';
    const meta = {
      accounts: {
        defaults: { claude: danglingId },
        bindings: { 'claude@2.1.220': danglingId },
      },
    };
    expect(() => resolveSpawnAccount(undefined, 'claude', '2.1.220', meta, { base: root }))
      .toThrow(`Unknown account '${danglingId}' for claude harness. The binding for claude@2.1.220 points at an account that no longer exists.`);
  });

  it('resolveSpawnAccount resolves a name-based default and still accepts legacy uuid defaults', () => {
    const account = addAccount('by-name', 'openrouter', 'api-key', 'sk-or', root);
    const byName = resolveSpawnAccount(undefined, 'claude', '2.1.220', { accounts: { defaults: { claude: 'by-name' } } }, { base: root });
    expect(byName).toMatchObject({ kind: 'provider', name: 'by-name', agent: 'claude' });

    const byLegacyId = resolveSpawnAccount(undefined, 'claude', '2.1.220', { accounts: { defaults: { claude: account.id } } }, { base: root });
    expect(byLegacyId).toMatchObject({ kind: 'provider', name: 'by-name', agent: 'claude' });
  });

  it('rotates a credential without changing the stable id or name', () => {
    const before = addAccount('work', 'cursor', 'api-key', 'old-key', root);
    setAccountSecret('work', 'new-key', root);
    const after = inspectAccount('work', root);
    expect(after.id).toBe(before.id);
    expect(after.name).toBe('work');
    expect(resolveCredentialAccount('work', 'cursor', undefined, root).env).toEqual({ CURSOR_API_KEY: 'new-key' });
  });

  it('renames the account, preserving its stable id, and rewires profile references', () => {
    const before = addAccount('work', 'openrouter', 'api-key', 'secret', root);
    fs.mkdirSync(path.join(root, 'profiles'));
    fs.writeFileSync(path.join(root, 'profiles', 'deepseek.yml'), 'name: deepseek\nhost:\n  agent: claude\nenv: {}\nprovider: openrouter\naccount: work\n');
    renameAccount('work', 'company', root);
    expect(fs.readFileSync(path.join(root, 'profiles', 'deepseek.yml'), 'utf8')).toContain('account: company');
    const renamed = inspectAccount('company', root);
    expect(renamed.id).toBe(before.id); // ACCOUNT_ID survives the rename
    expect(resolveCredentialAccount('company', 'claude', undefined, root).env.ANTHROPIC_AUTH_TOKEN).toBe('secret');
    expect(() => removeAccount('company', root)).toThrow('used by harness: deepseek');
  });

  it('renameAccount sweeps per-harness defaults that point to the old name or id', () => {
    const before = addAccount('work', 'openrouter', 'api-key', 'secret', root);
    updateMeta(meta => ({
      ...meta,
      accounts: {
        ...meta.accounts,
        defaults: { claude: 'work', codex: before.id },
      },
    }));
    renameAccount('work', 'company', root);
    const meta = readMeta();
    expect(meta.accounts?.defaults).toEqual({ claude: 'company', codex: 'company' });
    expect(resolveSpawnAccount(undefined, 'claude', '2.1.220', meta, { base: root })).toMatchObject({ kind: 'provider', name: 'company', agent: 'claude' });
  });

  it('removes the account and its device-local credential', () => {
    addAccount('work', 'cursor', 'api-key', 'old-key', root);
    removeAccount('work', root);
    expect(Object.values(readAccountRegistry(root).accounts).some(account => account.name === 'work')).toBe(false);
    expect(() => inspectAccount('work', root)).toThrow("Unknown account 'work'");
  });

  it('refuses to remove an account that is still the per-harness default (by name or legacy id)', () => {
    const account = addAccount('default-ref', 'cursor', 'api-key', 'key', root);
    updateMeta(meta => ({ ...meta, accounts: { ...meta.accounts, defaults: { ...meta.accounts?.defaults, cursor: 'default-ref' } } }));
    expect(() => removeAccount('default-ref', root)).toThrow("still referenced by: default cursor");

    updateMeta(meta => ({ ...meta, accounts: { ...meta.accounts, defaults: { ...meta.accounts?.defaults, cursor: account.id } } }));
    expect(() => removeAccount('default-ref', root)).toThrow("still referenced by: default cursor");
  });

  it('validates setup-token shape before storing it', async () => {
    expect(() => addAccount('claude-work', 'anthropic', 'setup-token', 'not-a-setup-token', root)).toThrow('sk-ant-oat01-');
    expect(await listKeychainItems('agents-cli.')).toEqual([]);
  });

  it('rejects setup tokens on non-Claude harnesses before injection', () => {
    addAccount('claude-work', 'anthropic', 'setup-token', 'sk-ant-oat01-valid', root);
    expect(() => resolveCredentialAccount('claude-work', 'codex', undefined, root)).toThrow('cannot use a setup-token with the codex harness');
  });
});

describe.skipIf(!fileBacked)('legacy accounts.yaml migration', () => {
  let root: string;
  useFreshSecretsHome();
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-accounts-mig-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('transactionally migrates v2 accounts into bundles, preserving the UUID, and archives only after success', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const legacyItem = `agents-cli.accounts.${id}.credential`;
    setKeychainTokenSync(legacyItem, 'sk-or-legacy');
    fs.writeFileSync(path.join(root, 'accounts.yaml'), [
      'version: 2',
      'accounts:',
      `  ${id}:`,
      `    id: ${id}`,
      '    name: work',
      '    provider: openrouter',
      '    auth: api-key',
      `    secretRef: ${legacyItem}`,
      '',
    ].join('\n'));

    const doc = readAccountRegistry(root);
    // UUID preserved as the account's stable id.
    expect(doc.accounts[id]).toMatchObject({ id, name: 'work', provider: 'openrouter', auth: 'api-key' });
    // Archived only after success; the live file is gone, the credential moved.
    expect(fs.existsSync(path.join(root, 'accounts.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'accounts.migrated.yaml'))).toBe(true);
    expect(hasKeychainTokenSync(legacyItem)).toBe(false); // old per-account item retired
    expect(resolveCredentialAccount('work', 'claude', undefined, root).env.ANTHROPIC_AUTH_TOKEN).toBe('sk-or-legacy');

    // Idempotent: a second read does nothing (no live file to migrate).
    expect(readAccountRegistry(root).accounts[id]).toMatchObject({ id, name: 'work' });
  });

  it('archives version-bound labels instead of converting them into fake credential accounts', () => {
    fs.writeFileSync(path.join(root, 'accounts.yaml'), 'labels:\n  work:\n    agent: claude\n    fingerprint: abc\n');
    expect(Object.values(readAccountRegistry(root).accounts).some(account => account.name === 'work')).toBe(false);
    expect(fs.existsSync(path.join(root, 'accounts.legacy-labels.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'accounts.yaml'))).toBe(false);
  });

  it('does not archive or delete a legacy account when its name collides with an unrelated bundle', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const legacyItem = `agents-cli.accounts.${id}.credential`;
    setKeychainTokenSync(legacyItem, 'sk-or-legacy');
    const otherItem = secretsKeychainItem('work', 'OTHER');
    writeBundleWithItemsSync({ name: 'work', vars: { OTHER: 'keychain:OTHER' } }, new Map([[otherItem, 'keep-me']]));
    fs.writeFileSync(path.join(root, 'accounts.yaml'), [
      'version: 2',
      'accounts:',
      `  ${id}:`,
      `    id: ${id}`,
      '    name: work',
      '    provider: openrouter',
      '    auth: api-key',
      `    secretRef: ${legacyItem}`,
      '',
    ].join('\n'));

    expect(() => readAccountRegistry(root)).toThrow("a different secrets bundle already uses that name");
    expect(fs.existsSync(path.join(root, 'accounts.yaml'))).toBe(true);
    expect(hasKeychainTokenSync(legacyItem)).toBe(true);
  });
});

describe('native account device-scoping (PHNX-3315)', () => {
  const prevMid = process.env.AGENTS_SYNC_MACHINE_ID;
  const clear = () => updateMeta(m => ({ ...m, accounts: { ...m.accounts, native: {}, bindings: {} }, deviceAccounts: undefined }));
  beforeEach(() => { process.env.AGENTS_SYNC_MACHINE_ID = 'accbox'; clear(); });
  afterEach(() => {
    clear();
    if (prevMid === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = prevMid;
  });

  const central = () => {
    const p = path.join(getUserAgentsDir(), 'agents.yaml');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  };
  const deviceDoc = () => (fs.existsSync(getDeviceMetaPath()) ? fs.readFileSync(getDeviceMetaPath(), 'utf8') : '');

  it("routes a scope:'device' login to this box's device doc, keeping identity PII off central", () => {
    addNativeAccount('opencode-login', 'opencode', 'opencode:user=1', 'me@example.com', 'device');

    // Visible through the effective list (central version natives + this box's device natives).
    expect(listNativeAccounts(readMeta()).map(a => a.name)).toContain('opencode-login');
    // Its identity PII lives in the device doc, never the fleet-shared central file.
    expect(deviceDoc()).toContain('opencode:user=1');
    expect(deviceDoc()).toContain('me@example.com');
    expect(central()).not.toContain('opencode:user=1');
    expect(central()).not.toContain('me@example.com');
  });

  it("keeps a scope:'version' login in the fleet-shared central store", () => {
    addNativeAccount('codex-login', 'codex', 'codex:user=2', 'you@example.com', 'version');
    expect(central()).toContain('codex:user=2');
    expect(deviceDoc()).not.toContain('codex:user=2');
    expect(listNativeAccounts(readMeta()).map(a => a.name)).toContain('codex-login');
  });

  it('resolves a device login by name across both stores (findUnifiedAccount)', () => {
    const acct = addNativeAccount('droid-login', 'droid', 'droid:user=3', undefined, 'device');
    const found = findUnifiedAccount('droid-login', readMeta());
    expect(found).toMatchObject({ kind: 'native', id: acct.id, agent: 'droid', scope: 'device' });
  });

  // PHNX-3940: leftover `homes` labels stay device-scoped; nativeAccountHome
  // is the read path T5/T7 still use for legacy `acct-*` installs.
  it('reads the device-scoped home label and drops it when the account is removed', () => {
    const created = addNativeAccount('work', 'claude', 'claude:user=1', 'work@example.com', 'version');
    const entry = readMeta().accounts?.native?.[created.id];
    expect(entry && 'installationLabel' in entry).toBe(false);

    updateMeta(current => ({
      ...current,
      deviceAccounts: {
        ...current.deviceAccounts,
        homes: { ...current.deviceAccounts?.homes, [created.id]: 'acct-home' },
      },
    }));
    expect(nativeAccountHome(created.id, readMeta())).toBe('acct-home');

    removeAccount('work');
    expect(nativeAccountHome(created.id, readMeta())).toBeNull();
  });

  it('setDefaultAccountIfAbsent sets only when unset and never overrides', () => {
    updateMeta(meta => ({ ...meta, accounts: { ...meta.accounts, defaults: {} } }));
    expect(setDefaultAccountIfAbsent('claude', 'work')).toBe(true);
    expect(readMeta().accounts?.defaults?.claude).toBe('work');
    expect(setDefaultAccountIfAbsent('claude', 'other')).toBe(false);
    expect(readMeta().accounts?.defaults?.claude).toBe('work');
  });

  it('bindAccount persists to the harness passed via preferAgent when an identity selector collides', () => {
    // Same email signed into codex AND claude. `attach <email> claude@x` validated
    // the claude row but bindAccount used to re-resolve un-scoped and could persist
    // the binding to the codex row (review of PHNX cross-harness scoping).
    const codex = addNativeAccount('personal', 'codex', 'codex:user=1', 'dup@example.com', 'version');
    const claude = addNativeAccount('gmail', 'claude', 'claude:user=2', 'dup@example.com', 'version');
    expect(codex.id).not.toBe(claude.id);

    bindAccount('dup@example.com', 'claude@9.9.9', 'claude');
    expect(readMeta().accounts?.bindings?.['claude@9.9.9']).toBe(claude.id);

    bindAccount('dup@example.com', 'codex@9.9.9', 'codex');
    expect(readMeta().accounts?.bindings?.['codex@9.9.9']).toBe(codex.id);
  });

  it('round-trips additive v2 native fields (workerCredential, provisioning, createdOn)', () => {
    const created = addNativeAccount('minted', 'claude', 'claude:user=slot-fields', 'm@example.com', 'version');
    updateMeta((m) => {
      const native = { ...m.accounts?.native };
      const row = native[created.id];
      if (!row) throw new Error('missing native row');
      native[created.id] = {
        ...row,
        workerCredential: {
          bundle: '__claude__',
          key: `CLAUDE_CODE_OAUTH_TOKEN_${created.id}`,
          kind: 'setup-token',
          mintedAt: '2026-09-06T00:00:00.000Z',
        },
        provisioning: 'portable',
        createdOn: 'laptop',
      };
      return { ...m, accounts: { ...m.accounts, native } };
    });
    const read = listNativeAccounts(readMeta()).find((a) => a.id === created.id);
    expect(read).toMatchObject({
      name: 'minted',
      provisioning: 'portable',
      createdOn: 'laptop',
      workerCredential: { bundle: '__claude__', kind: 'setup-token' },
    });
    labelNativeAccount('claude', 'claude:user=slot-fields', 'm@example.com', 'relabeled', 'version');
    const relabeled = listNativeAccounts(readMeta()).find((a) => a.id === created.id);
    expect(relabeled).toMatchObject({
      name: 'relabeled',
      provisioning: 'portable',
      createdOn: 'laptop',
      workerCredential: { bundle: '__claude__', kind: 'setup-token' },
    });
    removeAccount('relabeled');
  });
});

describe('discoverUnregisteredNativeAccount fallback (resolveSpawnAccount)', () => {
  const testVersionLabel = `test-unregistered-${process.pid}`;
  let versionHome: string;
  let root: string;

  beforeEach(() => {
    const versionDir = path.join(getVersionsDir(), 'claude', testVersionLabel);
    versionHome = path.join(versionDir, 'home');
    // Plant a .claude.json identity in the version home.
    fs.mkdirSync(path.join(versionHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(versionHome, '.claude', '.claude.json'), JSON.stringify({
      oauthAccount: {
        emailAddress: 'test-discover@example.com',
        accountUuid: 'acct-uuid-test',
        organizationUuid: 'org-uuid-test',
      },
    }));
    // Plant a minimal npm package so isVersionInstalled recognises this version.
    const pkgDir = path.join(versionDir, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ bin: { claude: 'bin/claude.js' } }));
    fs.writeFileSync(path.join(pkgDir, 'bin', 'claude.js'), '');
    invalidateInstalledVersionsCache('claude');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-discover-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    const versionDir = path.join(getVersionsDir(), 'claude', testVersionLabel);
    fs.rmSync(versionDir, { recursive: true, force: true });
    invalidateInstalledVersionsCache('claude');
  });

  it('discovers an unregistered native account when the email matches a version home identity', () => {
    // Empty native registry — the pre-fix code would throw "Unknown account".
    const meta = { accounts: { native: {} } };
    const result = resolveSpawnAccount('test-discover@example.com', 'claude', '2.1.260', meta, { base: root });
    expect(result).toMatchObject({ kind: 'native', name: 'test-discover@example.com', agent: 'claude' });
  });

  it('is case-insensitive on the email match', () => {
    const meta = { accounts: { native: {} } };
    const result = resolveSpawnAccount('Test-Discover@Example.COM', 'claude', '2.1.260', meta, { base: root });
    expect(result).toMatchObject({ kind: 'native', name: 'Test-Discover@Example.COM' });
  });

  it('rejects a discovered native account on a provider-backed harness', () => {
    const meta = { accounts: { native: {} } };
    expect(() => resolveSpawnAccount('test-discover@example.com', 'claude', '2.1.260', meta, { base: root, provider: 'openrouter' }))
      .toThrow('cannot run under a provider-backed harness (openrouter)');
  });

  it('returns null for a non-claude agent even when the email would match', () => {
    // discoverUnregisteredNativeAccount only supports claude.
    const meta = { accounts: { native: {} } };
    expect(() => resolveSpawnAccount('test-discover@example.com', 'codex', '0.146.0', meta, { base: root }))
      .toThrow("Unknown account 'test-discover@example.com'");
  });

  it('still throws for a non-@ selector that is not in the registry', () => {
    const meta = { accounts: { native: {} } };
    expect(() => resolveSpawnAccount('work', 'claude', '2.1.260', meta, { base: root }))
      .toThrow("Unknown account 'work'");
  });
});

describe('findNativeAccountByIdentity', () => {
  const meta = {
    accounts: {
      native: {
        'acct-work': { id: 'acct-work', name: 'work', agent: 'claude' as const, identityKey: 'claude:account=a1:org=o1', identityLabel: 'person@example.com', scope: 'device' as const },
        'acct-muse': { id: 'acct-muse', name: 'muse-main', agent: 'muse' as const, identityKey: 'person@example.com', scope: 'device' as const },
      },
    },
  };

  it('matches on the stable accountKey first, scoped to the harness', () => {
    const info = { accountKey: 'claude:account=a1:org=o1', email: 'Person@Example.com' };
    expect(findNativeAccountByIdentity(meta, 'claude', info)?.name).toBe('work');
    expect(findNativeAccountByIdentity(meta, 'codex', info)).toBeNull();
  });

  it('falls back to the lowercased email for a key-less login, and never matches nothing', () => {
    expect(findNativeAccountByIdentity(meta, 'muse', { accountKey: null, email: 'Person@Example.com' })?.name).toBe('muse-main');
    expect(findNativeAccountByIdentity(meta, 'muse', { accountKey: null, email: null })).toBeNull();
    expect(findNativeAccountByIdentity(meta, 'claude', null)).toBeNull();
    expect(findNativeAccountByIdentity({ accounts: {} }, 'claude', { accountKey: 'claude:account=a1:org=o1' })).toBeNull();
  });
});
