import type { AgentId, Meta } from './types.js';
import { resolveAgentName } from './agents.js';
import {
  AUTH_BUNDLE,
  claudeAccountTokenKey,
  isValidClaudeSetupToken,
  readClaudeAccountEmail,
  readReservedCredential,
  invalidateClaudeSetupTokenCache,
} from './claude-account-token.js';
import { addAccount, findAccount, listNativeAccounts, readAccountRegistry, setAccountSecret, type CredentialAccount } from './account-registry.js';
import {
  bundleBackendSync,
  isSecretsClientError,
  bundleExists,
  bundleExistsSync,
  keychainRef,
  pushBundleToHost,
  readBundleSync,
  rotateBundleSecretSync,
  secretsKeychainItem,
  writeBundleWithItemsSync,
} from './secrets-client.js';
import type { SecretsBundle } from './secrets-types.js';
import {
  assertStorableCredentialKind,
  reservedStoreName,
  type StorableCredentialKind,
} from './secrets-policy.js';
import { getBinaryPath, getGlobalDefault, getVersionHomePath, listInstalledVersions } from './installations/versions.js';
import { shellQuote } from './ssh-exec.js';
import {
  defaultTermDriver,
  type DriveOptions,
  type TermDriver,
} from './term-driver.js';
import { showUrl } from './open-url.js';
import { loadDevices } from './devices/registry.js';
import { isSelfHost } from './devices/self-host.js';
import { assertCredentialTransportHostPinned, resolveHostSshTarget } from './hosts/credential-transport.js';
import { resolveRemoteOsSync } from './hosts/remote-os.js';

export const CLAUDE_SETUP_TOKEN_CAPTURE_RE = /sk-ant-oat01-[A-Za-z0-9_-]+/;

const ACCOUNT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface MintFlow {
  harness: AgentId;
  provider: string;
  auth: 'setup-token' | 'api-key';
  mintArgs: string[] | null;
  apiKeyEnv?: string;
  verificationUrlRegex?: RegExp;
  tokenCapture?: RegExp;
}

export const MINT_FLOWS: Record<string, MintFlow> = {
  claude: {
    harness: 'claude',
    provider: 'anthropic',
    auth: 'setup-token',
    mintArgs: ['setup-token'],
    verificationUrlRegex: /(https:\/\/[^\s"'<>]+)/i,
    tokenCapture: CLAUDE_SETUP_TOKEN_CAPTURE_RE,
  },
  codex: { harness: 'codex', provider: 'openai', auth: 'api-key', mintArgs: null, apiKeyEnv: 'OPENAI_API_KEY' },
  grok: { harness: 'grok', provider: 'xai', auth: 'api-key', mintArgs: null, apiKeyEnv: 'XAI_API_KEY' },
  opencode: { harness: 'opencode', provider: 'opencode', auth: 'api-key', mintArgs: null, apiKeyEnv: 'OPENCODE_API_KEY' },
  cursor: { harness: 'cursor', provider: 'cursor', auth: 'api-key', mintArgs: null, apiKeyEnv: 'CURSOR_API_KEY' },
  droid: { harness: 'droid', provider: 'factory', auth: 'api-key', mintArgs: null, apiKeyEnv: 'FACTORY_API_KEY' },
};

export function listMintableHarnesses(): AgentId[] {
  return (Object.values(MINT_FLOWS) as MintFlow[]).filter((f) => f.auth === 'setup-token').map((f) => f.harness);
}

export function getMintFlow(harnessRaw: string): MintFlow {
  const harness = resolveAgentName(harnessRaw);
  if (!harness) {
    throw new Error(
      `Unknown harness '${harnessRaw}'. Interactive setup-token mint is implemented for: ${listMintableHarnesses().join(', ')}.`,
    );
  }
  const flow = MINT_FLOWS[harness];
  if (flow?.auth === 'setup-token') return flow;
  if (flow) {
    throw new Error(
      `'${harness}' has no derivable token — its durable credential is an API key (${flow.apiKeyEnv}). `
      + `Collect it with: agents accounts add ${harness} <name> --api-key <key>.`,
    );
  }
  throw new Error(unmintableMessage(harness));
}

export function unmintableMessage(harness: string): string {
  return [
    `Cannot mint a setup-token for '${harness}'.`,
    `Interactive setup-token mint is implemented for: ${listMintableHarnesses().join(', ')}.`,
    `A token-less harness like '${harness}' logs in per box — run it on that device and complete its native login.`,
    `API-key / pasted-token accounts use \`agents accounts add <name> --provider <provider> --auth api-key\`.`,
  ].join(' ');
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

export function extractClaudeSetupToken(screen: string): string | null {
  // Capture exactly one clean token; terminal output must never be guessed into a credential.
  const text = stripAnsi(screen);
  const matches = text.match(new RegExp(CLAUDE_SETUP_TOKEN_CAPTURE_RE.source, 'g')) ?? [];
  const unique = [...new Set(matches.filter(isValidClaudeSetupToken))];
  if (unique.length === 0) return null;
  if (unique.length > 1) {
    throw new Error(
      `Screen contained ${unique.length} distinct setup-tokens; refusing to guess. Re-run mint and capture a single sk-ant-oat01- token.`,
    );
  }
  return unique[0]!;
}

export function extractMintUrl(screen: string, flow: MintFlow): string | undefined {
  if (!flow.verificationUrlRegex) return undefined;
  const text = stripAnsi(screen);
  const m = text.match(flow.verificationUrlRegex);
  if (!m) return undefined;
  const raw = (m[1] ?? m[0]).trim();
  return raw.replace(/[.,;:]+$/, '') || undefined;
}

export function isEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

export function accountNameFromEmail(email: string): string {
  const slug = email
    .trim()
    .toLowerCase()
    .replace(/@/g, '-at-')
    .replace(/[^a-z0-9._-]/g, '-');
  if (!ACCOUNT_NAME_RE.test(slug)) {
    throw new Error(`Cannot derive an account name from email '${email}'. Pass --account <name>.`);
  }
  return slug;
}

export function assertValidSetupToken(token: string): string {
  const cleaned = token.trim();
  if (!isValidClaudeSetupToken(cleaned)) {
    throw new Error(
      'Not a Claude setup-token (expected a single-line sk-ant-oat01-… value). The #1767 capture stored the TTY banner as the token — that is not a token. Re-run `claude setup-token` and paste only the sk-ant-oat01- line.',
    );
  }
  return cleaned;
}

export interface ResolveMintIdentityInput {
  account?: string;
  email?: string;
  home?: string;
}

export interface ResolvedMintIdentity {
  accountName: string;
  email: string;
}

export function resolveMintIdentity(input: ResolveMintIdentityInput): ResolvedMintIdentity {
  // Worker credentials are per-account, so minting requires a concrete email identity.
  const accountRaw = input.account?.trim();
  const emailRaw = input.email?.trim();
  const fromHome = readClaudeAccountEmail(input.home);

  let email: string | undefined;
  let accountName: string | undefined;

  if (emailRaw) {
    if (!isEmail(emailRaw)) throw new Error(`--email '${emailRaw}' is not an email address.`);
    email = emailRaw;
  }
  if (accountRaw) {
    if (isEmail(accountRaw)) {
      if (email && email.toLowerCase() !== accountRaw.toLowerCase()) {
        throw new Error(`--account '${accountRaw}' and --email '${email}' name different emails.`);
      }
      email = accountRaw;
      accountName = accountNameFromEmail(accountRaw);
    } else {
      if (!ACCOUNT_NAME_RE.test(accountRaw)) {
        throw new Error(
          `Account name '${accountRaw}' must start with a letter or number and contain only letters, numbers, dot, underscore, or dash.`,
        );
      }
      accountName = accountRaw;
    }
  }
  if (!email) email = fromHome ?? undefined;
  if (!email) {
    throw new Error(
      "Cannot key a per-account setup-token without an email. Pass --account <email>, or --email, or sign in locally first so this version home's .claude.json has oauthAccount.emailAddress.",
    );
  }
  if (!accountName) accountName = accountNameFromEmail(email);
  return { accountName, email };
}

// The reserved auth bundle must be file-backed; a wrong backend fails loud instead of silently hiding a seeded token.
export function seedReservedAuthToken(email: string, token: string): { key: string } {
  const cleaned = assertValidSetupToken(token);
  const key = claudeAccountTokenKey(email);
  if (bundleExistsSync(AUTH_BUNDLE)) {
    const backend = bundleBackendSync(AUTH_BUNDLE);
    if (backend !== 'file') {
      throw new Error(
        `Reserved bundle '${AUTH_BUNDLE}' exists with backend '${backend}', but usage/probe only reads a FILE-backed auth bundle. Recreate it with: agents secrets create ${AUTH_BUNDLE} --backend file --policy never --i-understand --force`,
      );
    }
    const bundle = readBundleSync(AUTH_BUNDLE);
    if (key in bundle.vars) {
      rotateBundleSecretSync(bundle, key, { newValue: cleaned, meta: { type: 'token' } });
      invalidateClaudeSetupTokenCache();
      return { key };
    }
    const item = secretsKeychainItem(AUTH_BUNDLE, key);
    bundle.vars[key] = keychainRef(key);
    if (!bundle.meta) bundle.meta = {};
    bundle.meta[key] = { type: 'token' };
    writeBundleWithItemsSync(bundle, new Map([[item, cleaned]]));
    invalidateClaudeSetupTokenCache();
    return { key };
  }
  const item = secretsKeychainItem(AUTH_BUNDLE, key);
  const bundle: SecretsBundle = {
    name: AUTH_BUNDLE,
    backend: 'file',
    policy: 'never',
    description: 'Reserved per-account Claude setup-tokens for unattended usage/probe (never copy native OAuth).',
    vars: { [key]: keychainRef(key) },
    meta: { [key]: { type: 'token' } },
  };
  writeBundleWithItemsSync(bundle, new Map([[item, cleaned]]));
  invalidateClaudeSetupTokenCache();
  return { key };
}

// Return the portable worker credential env; harnesses with per-device login deliberately throw.
export function workerCredentialEnv(harness: AgentId): string {
  if (harness === 'claude') return 'CLAUDE_CODE_OAUTH_TOKEN';
  const flow = MINT_FLOWS[harness];
  if (flow?.auth === 'api-key' && flow.apiKeyEnv) return flow.apiKeyEnv;
  throw new Error(`No portable worker credential env for '${harness}' — it logs in per box.`);
}

/**
 * The reserved-store key for one account's worker credential:
 * `<ENV>_<accountId>` — keyed by account id, never by name or email, so a
 * rename or an email change never breaks the key. Hyphens are stripped because
 * the bundle key grammar (`BUNDLE_KEY_PATTERN`) is env-var-shaped.
 */
export function workerCredentialStoreKey(harness: AgentId, accountId: string): string {
  const slug = accountId.replace(/-/g, '');
  if (!/^[A-Za-z0-9_]+$/.test(slug) || !slug) {
    throw new Error(`Invalid account id '${accountId}' for a worker credential key.`);
  }
  return `${workerCredentialEnv(harness)}_${slug}`;
}

/**
 * Write (or rotate) one account's worker credential in the reserved
 * `__<harness>__` store (PHNX-3940). Only non-rotating kinds may enter
 * (`assertStorableCredentialKind` refuses a rotating OAuth/session credential at
 * this boundary — RUSH-1958). FILE-backed, policy `never`, same contract as the
 * legacy `auth` bundle: a keychain- or vault-backed store of this name fails
 * loud, since worker provisioning reads the file backend.
 */
export function seedReservedStoreKey(
  harness: AgentId,
  kind: StorableCredentialKind,
  key: string,
  value: string,
): { bundle: string; key: string } {
  // Reserved worker bundles are real file-backed policy-never stores, never rotating OAuth/session credentials.
  assertStorableCredentialKind(kind, harness);
  const name = reservedStoreName(harness);
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`Empty ${kind} for reserved store '${name}' key ${key}.`);
  const item = secretsKeychainItem(name, key);
  try {
    if (bundleExistsSync(name)) {
      const backend = bundleBackendSync(name);
      if (backend !== 'file') {
        throw new Error(
          `Reserved store '${name}' exists with backend '${backend}', but worker provisioning only reads a FILE-backed store. Recreate it with: agents secrets delete ${name} --yes`,
        );
      }
      const bundle = readBundleSync(name);
      if (key in bundle.vars) {
        rotateBundleSecretSync(bundle, key, { newValue: cleaned, meta: { type: 'token' } });
        return { bundle: name, key };
      }
      bundle.vars[key] = keychainRef(key);
      if (!bundle.meta) bundle.meta = {};
      bundle.meta[key] = { type: 'token' };
      writeBundleWithItemsSync(bundle, new Map([[item, cleaned]]));
      return { bundle: name, key };
    }
    const bundle: SecretsBundle = {
      name,
      backend: 'file',
      policy: 'never',
      description: `Reserved ${harness} worker credentials (${kind}), one key per account; pushed to worker devices by the daemon. Never a native OAuth session.`,
      vars: { [key]: keychainRef(key) },
      meta: { [key]: { type: 'token' } },
    };
    writeBundleWithItemsSync(bundle, new Map([[item, cleaned]]));
    return { bundle: name, key };
  } catch (err) {
    if (isSecretsClientError(err, 'OPERATION_FAILED')) {
      throw new Error(
        `Could not write the reserved store '${name}' as a bundle: ${err.message}. agents-cli needs @phnx-labs/secrets-cli 0.1.1 or newer, which accepts the __<harness>__ bundle name: npm i -g @phnx-labs/secrets-cli@latest`,
      );
    }
    throw err;
  }
}

export interface AdoptLegacyReservedItemsResult {
  adopted: Array<{ bundle: string; key: string }>;
  errors: Array<{ bundle: string; key: string; message: string }>;
}

export function adoptLegacyReservedStoreItems(
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>,
): AdoptLegacyReservedItemsResult {
  // Local and idempotent: skip present keys, adopt legacy bare items into the file bundle, never contact peers, and report per-key failures.
  const result: AdoptLegacyReservedItemsResult = { adopted: [], errors: [] };
  for (const account of listNativeAccounts(meta)) {
    const cred = account.workerCredential;
    if (!cred || !cred.bundle.startsWith('__')) continue;
    if (cred.kind !== 'setup-token' && cred.kind !== 'api-key') continue;
    try {
      if (bundleExistsSync(cred.bundle) && cred.key in readBundleSync(cred.bundle).vars) continue;
      const value = readReservedCredential(cred.bundle, cred.key);
      if (value === null) continue;
      seedReservedStoreKey(account.agent, cred.kind, cred.key, value);
      result.adopted.push({ bundle: cred.bundle, key: cred.key });
    } catch (err) {
      result.errors.push({ bundle: cred.bundle, key: cred.key, message: (err as Error).message });
    }
  }
  return result;
}

export function seedNamedAccount(name: string, token: string, flow: MintFlow): CredentialAccount {
  // Never replace an existing account whose provider or auth kind differs.
  const cleaned = assertValidSetupToken(token);
  const existing = findAccount(name);
  if (!existing) return addAccount(name, flow.provider, flow.auth, cleaned);
  if (existing.provider !== flow.provider || existing.auth !== flow.auth) {
    throw new Error(
      `Account '${name}' already exists as ${existing.provider} ${existing.auth}; not overwriting it with a ${flow.provider} ${flow.auth}. Choose a different --account name.`,
    );
  }
  setAccountSecret(name, cleaned);
  return existing;
}

export interface MintDriveHooks {
  driver?: TermDriver;
  openUrl?: (url: string) => Promise<void>;
  readCode?: () => Promise<string | undefined>;
  drive?: DriveOptions;
}

export interface DriveMintResult {
  token: string;
  url?: string;
  sessionId: string;
}

export interface DriveSetupTokenMintOpts extends MintDriveHooks {
  code?: string;
  json?: boolean;
}

function emitMintProgress(line: string, json?: boolean): void {
  // Machine-readable stdout stays clean.
  if (!json) console.log(line);
}

export async function driveSetupTokenMint(
  command: string,
  flow: MintFlow,
  opts: DriveSetupTokenMintOpts = {},
): Promise<DriveMintResult> {
  // The terminal is torn down on every path, and its token is returned only in memory, never logged.
  if (flow.auth !== 'setup-token' || !flow.tokenCapture) {
    throw new Error(`Harness '${flow.harness}' has no interactive mint command.`);
  }
  const driver = opts.driver ?? defaultTermDriver();
  const initialDelayMs = opts.drive?.initialDelayMs ?? 1500;
  const pollMs = opts.drive?.pollMs ?? 500;
  const timeoutMs = opts.drive?.timeoutMs ?? 180_000;
  const json = opts.json === true;
  const openUrl = opts.openUrl ?? (async (url: string) => {
    const shown = await showUrl(url);
    if (shown.via === 'none') {
      console.error(`Could not open a browser — open this yourself:\n  ${url}`);
    }
  });

  const id = await driver.start();
  let opened: string | undefined;
  let wroteCode = false;
  let askedCode = false;
  try {
    await driver.exec(id, command);
    await sleep(initialDelayMs);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { screen, exited } = await driver.screen(id);
      const url = extractMintUrl(screen, flow);
      const token = extractClaudeSetupToken(screen);
      if (token) {
        const capturedUrl = url ?? opened;
        if (capturedUrl) emitMintProgress(`Authorize URL: ${capturedUrl}`, json);
        return { token, url: capturedUrl, sessionId: id };
      }
      if (url && url !== opened) {
        opened = url;
        await openUrl(url);
      }
      if (url && !wroteCode && !askedCode) {
        const code = opts.code ?? await opts.readCode?.();
        askedCode = true;
        if (code?.trim()) {
          await driver.write(id, `${code.trim()}\r`);
          wroteCode = true;
        }
      }
      if (exited) {
        throw new Error(
          opened
            ? `Mint process exited before printing a setup-token. Authorize URL was ${opened}. Re-run and complete the browser step, or seed with --token-stdin.`
            : 'Mint process exited before printing an authorize URL or a setup-token.',
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          opened
            ? `Timed out waiting for a setup-token after opening ${opened}. Paste the code with --code, or seed an already-minted token with --token-stdin.`
            : 'Timed out waiting for `claude setup-token` to print an authorize URL.',
        );
      }
      await sleep(pollMs);
    }
  } catch (e) {
    await driver.stop(id).catch(() => {});
    throw e;
  } finally {
    await driver.stop(id).catch(() => {});
  }
}

export function buildMintCommand(flow: MintFlow, bin: string, home: string, env: Record<string, string> = {}): string {
  if (flow.auth !== 'setup-token' || !flow.mintArgs) {
    throw new Error(`Harness '${flow.harness}' has no interactive mint command.`);
  }
  const args = flow.mintArgs.map(shellQuote).join(' ');
  const envPrefix = [
    `HOME=${shellQuote(home)}`,
    ...Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`),
  ].join(' ');
  return `${envPrefix} ${shellQuote(bin)} ${args}`;
}

export function resolveMintInstallation(harness: AgentId): { version: string; bin: string; home: string } {
  const installed = listInstalledVersions(harness);
  const version = getGlobalDefault(harness) ?? installed[installed.length - 1];
  if (!version) {
    throw new Error(`No installed version of ${harness}. Install one with: agents add ${harness}`);
  }
  return {
    version,
    bin: getBinaryPath(harness, version),
    home: getVersionHomePath(harness, version),
  };
}

export interface MintAndSeedInput {
  harness: string;
  account?: string;
  email?: string;
  token?: string;
  code?: string;
  open?: boolean;
  fleet?: boolean;
  devices?: string[];
  json?: boolean;
  hooks?: MintDriveHooks;
}

export interface FleetSyncRow {
  device: string;
  ok: boolean;
  message: string;
}

export interface MintAndSeedResult {
  harness: AgentId;
  account: string;
  email: string;
  authBundleKey: string;
  rotated: boolean;
  fleet: FleetSyncRow[];
}

export async function mintAndSeed(input: MintAndSeedInput): Promise<MintAndSeedResult> {
  // Claude alone mints a durable setup token interactively; API-key flows collect keys and tokenless harnesses log in per box.
  const flow = getMintFlow(input.harness);
  const json = input.json === true;
  const install = input.token
    ? null
    : input.hooks?.driver
      ? { bin: flow.harness, home: process.env.HOME ?? '/tmp' }
      : resolveMintInstallation(flow.harness);
  const identity = resolveMintIdentity({
    account: input.account,
    email: input.email,
    home: install?.home,
  });

  let token: string;
  if (input.token !== undefined) {
    token = assertValidSetupToken(input.token);
  } else {
    const command = buildMintCommand(flow, install!.bin, install!.home);
    const openUrl = input.open === false
      ? async (url: string) => {
        emitMintProgress(`Authorize: ${url}`, json);
      }
      : input.hooks?.openUrl;
    const driven = await driveSetupTokenMint(command, flow, {
      driver: input.hooks?.driver,
      openUrl,
      readCode: input.hooks?.readCode,
      drive: input.hooks?.drive,
      code: input.code,
      json,
    });
    token = driven.token;
  }

  const existing = findAccount(identity.accountName);
  const account = seedNamedAccount(identity.accountName, token, flow);
  const { key } = seedReservedAuthToken(identity.email, token);

  const targets = await resolveSyncTargets(input.fleet === true, input.devices ?? []);
  const fleet: FleetSyncRow[] = [];
  for (const device of targets) {
    fleet.push(await syncMintedBundles(account.name, device));
  }
  const failed = fleet.filter((row) => !row.ok);
  if (failed.length) {
    throw new Error(
      `Minted locally but fleet sync failed for: ${failed.map((row) => `${row.device} (${row.message})`).join('; ')}. Retry: agents accounts sync ${account.name} <device>`,
    );
  }

  return {
    harness: flow.harness,
    account: account.name,
    email: identity.email,
    authBundleKey: key,
    rotated: Boolean(existing),
    fleet,
  };
}

export async function resolveSyncTargets(fleet: boolean, devices: string[]): Promise<string[]> {
  const named = [...new Set(devices.map((d) => d.trim()).filter(Boolean))];
  if (!fleet && named.length === 0) return [];
  const registry = await loadDevices();
  const known = Object.keys(registry);
  if (named.length) {
    // Explicit self targets are skipped; unknown device names are operator errors.
    const unknown = named.filter((d) => !known.includes(d) && !isSelfHost(d));
    if (unknown.length) {
      throw new Error(
        `Unknown device${unknown.length === 1 ? '' : 's'} '${unknown.join("', '")}'. Register with \`agents devices\` or omit --device.`,
      );
    }
  }
  const fromFleet = fleet
    ? known.filter((name) => !isSelfHost(name))
    : [];
  const union = [...new Set([...fromFleet, ...named.filter((d) => !isSelfHost(d))])];
  return union;
}

async function syncMintedBundles(accountName: string, device: string): Promise<FleetSyncRow> {
  try {
    const sshTarget = await resolveHostSshTarget(device);
    assertCredentialTransportHostPinned(sshTarget);
    const remoteBackend = resolveRemoteOsSync(device) === 'win32' ? 'keychain' : 'file';
    const account = findAccount(accountName);
    if (!account) throw new Error(`Unknown provider account '${accountName}'.`);
    const accountPush = await pushBundleToHost(accountName, device, {
      remoteBackend,
      force: true,
      operation: 'accounts login --fleet',
      policyNever: true,
      agentOnly: false,
      literalValues: {
        ACCOUNT_ID: account.id,
        PROVIDER: account.provider,
        AUTH_TYPE: account.auth,
        ...(account.baseUrl ? { BASE_URL: account.baseUrl } : {}),
      },
    });
    if (!accountPush.ok) throw new Error(accountPush.message);
    if (await bundleExists(AUTH_BUNDLE)) {
      const authPush = await pushBundleToHost(AUTH_BUNDLE, device, {
        remoteBackend: 'file',
        force: true,
        operation: 'accounts login --fleet',
        policyNever: true,
        agentOnly: true,
      });
      if (!authPush.ok) throw new Error(authPush.message);
    }
    return { device, ok: true, message: `${accountPush.keyCount} keys` };
  } catch (err) {
    return { device, ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * True when a Claude setup-token is already seeded on this box (setup status).
 *
 * Read-only status probe (`agents setup`, `agents doctor`) — neither the
 * account-registry read nor the reserved auth-bundle check MUST crash the whole
 * command because the secret store could not be reached (the macOS Keychain
 * helper source unavailable — PHNX-3385 — or the standalone `secrets` CLI
 * missing / unspawnable); the client's calls fail loud by contract, but that
 * contract is for destructive-write guards, not a diagnostic. An unreachable
 * store here just means "cannot confirm," reported honestly rather than
 * propagated.
 */
export function hasMintedSetupToken(): { ready: boolean; detail: string } {
  try {
    const records = Object.values(readAccountRegistry().accounts);
    const setup = records.filter((a) => a.auth === 'setup-token' && a.provider === 'anthropic');
    if (setup.length) {
      return { ready: true, detail: `${setup.length} Claude setup-token account${setup.length === 1 ? '' : 's'}` };
    }
    if (bundleExistsSync(AUTH_BUNDLE) && bundleBackendSync(AUTH_BUNDLE) === 'file') {
      const bundle = readBundleSync(AUTH_BUNDLE);
      const keys = Object.keys(bundle.vars).filter((k) => k.startsWith('CLAUDE_CODE_OAUTH_TOKEN_'));
      if (keys.length) return { ready: true, detail: `reserved auth bundle (${keys.length} account key${keys.length === 1 ? '' : 's'})` };
    }
  } catch (err) {
    return { ready: false, detail: `could not check the secret store: ${(err as Error).message}` };
  }
  return { ready: false, detail: 'no Claude setup-token minted — agents accounts add claude [name]' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
