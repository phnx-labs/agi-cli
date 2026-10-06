import {
  secretsRequest,
  secretsRequestSync,
  type SecretsContext,
} from '@phnx-labs/secrets-cli/client';
import type {
  SecretsBundle,
  SecretsBackend,
  WriteBundleOptions,
  BundleEntryInfo,
  RenameOptions,
  RotateOptions,
  BundleValue,
  KeychainReadContext,
  SecretRef,
  AgentStatusEntry,
  PushBundleOptions,
  PushBundleResult,
  RemoteBundleSummary,
  PullOptions,
  RcSecretFinding,
} from './secrets-types.js';

export {
  PROTOCOL_VERSION,
  SYNC_SERVE_TIMEOUT_MS,
  SecretsClientError,
  isSecretsClientError,
  isSecretsTransportError,
  resolveSecretsBin,
  invocation,
  buildServeEnv,
  secretsRequest,
  secretsRequestSync,
  readAndResolveBundleEnv,
  readAndResolveBundleEnvSync,
  _resetSecretsClientForTest,
  _setSyncServeTimeoutForTest,
  type SecretsContext,
} from '@phnx-labs/secrets-cli/client';

const SERVICE_PREFIX = 'agents-cli';
const SECRETS_ITEM_PREFIX = `${SERVICE_PREFIX}.secrets.`;

export function secretsKeychainItem(bundle: string, key: string): string {
  return `${SECRETS_ITEM_PREFIX}${bundle}.${key}`;
}

export function profileKeychainItem(provider: string): string {
  return `${SERVICE_PREFIX}.${provider}.token`;
}

export function keychainRef(key: string): string {
  return `keychain:${key}`;
}

export type { BundleValue, SecretRef };
const REF_PATTERN = /^(keychain|env|file|exec):(.+)$/s;

export function parseBundleValue(raw: BundleValue): { literal: string } | { ref: SecretRef } {
  if (typeof raw === 'object' && raw !== null && typeof (raw as { value?: unknown }).value === 'string') {
    return { literal: (raw as { value: string }).value };
  }
  if (typeof raw !== 'string') {
    throw new Error(`Invalid bundle value (expected string or {value: string}): ${JSON.stringify(raw)}`);
  }
  const match = REF_PATTERN.exec(raw);
  if (!match) return { literal: raw };
  return { ref: { provider: match[1] as SecretRef['provider'], value: match[2] } };
}

export function listBundles(context?: SecretsContext): Promise<SecretsBundle[]> {
  return secretsRequest('bundles.listBundles', [], context);
}
export function listBundlesSync(context?: SecretsContext): SecretsBundle[] {
  return secretsRequestSync('bundles.listBundles', [], context);
}

export function describeBundle(bundle: SecretsBundle, context?: SecretsContext): Promise<BundleEntryInfo[]> {
  return secretsRequest('bundles.describeBundle', [bundle], context);
}

export function readBundle(name: string, context?: SecretsContext): Promise<SecretsBundle> {
  return secretsRequest('bundles.readBundle', [name], context);
}
export function readBundleSync(name: string, context?: SecretsContext): SecretsBundle {
  return secretsRequestSync('bundles.readBundle', [name], context);
}

export function bundleExists(name: string, context?: SecretsContext): Promise<boolean> {
  return secretsRequest('bundles.bundleExists', [name], context);
}
export function bundleExistsSync(name: string, context?: SecretsContext): boolean {
  return secretsRequestSync('bundles.bundleExists', [name], context);
}

export function bundleBackend(name: string, context?: SecretsContext): Promise<SecretsBackend> {
  return secretsRequest('bundles.bundleBackend', [name], context);
}
export function bundleBackendSync(name: string, context?: SecretsContext): SecretsBackend {
  return secretsRequestSync('bundles.bundleBackend', [name], context);
}

export function writeBundle(
  bundle: SecretsBundle,
  opts?: WriteBundleOptions,
  context?: SecretsContext,
): Promise<void> {
  return secretsRequest('bundles.writeBundle', [bundle, opts ?? {}], context);
}

export function writeBundleWithItems(
  bundle: SecretsBundle,
  items: Map<string, string>,
  opts?: WriteBundleOptions,
  context?: SecretsContext,
): Promise<void> {
  return secretsRequest('bundles.writeBundleWithItems', [bundle, items, opts ?? {}], context);
}
export function writeBundleWithItemsSync(
  bundle: SecretsBundle,
  items: Map<string, string>,
  opts?: WriteBundleOptions,
  context?: SecretsContext,
): void {
  secretsRequestSync('bundles.writeBundleWithItems', [bundle, items, opts ?? {}], context);
}
export function deleteBundleSync(name: string, context?: SecretsContext): boolean {
  return secretsRequestSync('bundles.deleteBundle', [name], context);
}

export function renameBundle(
  oldName: string,
  newName: string,
  opts?: RenameOptions,
  context?: SecretsContext,
): Promise<void> {
  return secretsRequest('bundles.renameBundle', [oldName, newName, opts ?? {}], context);
}
export function renameBundleSync(
  oldName: string,
  newName: string,
  opts?: RenameOptions,
  context?: SecretsContext,
): void {
  secretsRequestSync('bundles.renameBundle', [oldName, newName, opts ?? {}], context);
}

export function rotateBundleSecret(
  bundle: SecretsBundle,
  key: string,
  opts: RotateOptions,
  context?: SecretsContext,
): Promise<void> {
  return secretsRequest('bundles.rotateBundleSecret', [bundle, key, opts], context);
}
export function rotateBundleSecretSync(
  bundle: SecretsBundle,
  key: string,
  opts: RotateOptions,
  context?: SecretsContext,
): void {
  secretsRequestSync('bundles.rotateBundleSecret', [bundle, key, opts], context);
}

export function agentPing(): Promise<{ reachable: boolean; cliVersion?: string }> {
  return secretsRequest('agent.agentPing', []);
}

export function agentStatus(): Promise<AgentStatusEntry[]> {
  return secretsRequest('agent.agentStatus', []);
}

export function getKeychainToken(item: string, context?: KeychainReadContext): Promise<string> {
  return secretsRequest('index.getKeychainToken', [item, context ?? {}]);
}
export function getKeychainTokenSync(item: string, context?: KeychainReadContext): string {
  return secretsRequestSync('index.getKeychainToken', [item, context ?? {}]);
}

export function setKeychainToken(item: string, value: string, opts?: { noAcl?: boolean }): Promise<void> {
  return secretsRequest('index.setKeychainToken', opts === undefined ? [item, value] : [item, value, opts]);
}
export function setKeychainTokenSync(item: string, value: string, opts?: { noAcl?: boolean }): void {
  secretsRequestSync('index.setKeychainToken', opts === undefined ? [item, value] : [item, value, opts]);
}

export function hasKeychainToken(item: string): Promise<boolean> {
  return secretsRequest('index.hasKeychainToken', [item]);
}
export function hasKeychainTokenSync(item: string): boolean {
  return secretsRequestSync('index.hasKeychainToken', [item]);
}

export function deleteKeychainToken(item: string): Promise<boolean> {
  return secretsRequest('index.deleteKeychainToken', [item]);
}
export function deleteKeychainTokenSync(item: string): boolean {
  return secretsRequestSync('index.deleteKeychainToken', [item]);
}

export function listKeychainItems(prefix: string): Promise<string[]> {
  return secretsRequest('index.listKeychainItems', [prefix]);
}

export function keychainUsesFileFallback(): Promise<boolean> {
  return secretsRequest('index.keychainUsesFileFallback', []);
}
export function storeGetSync(backend: SecretsBackend, item: string): string {
  return secretsRequestSync('store.get', [backend, item]);
}
export function storeHasSync(backend: SecretsBackend, item: string): boolean {
  return secretsRequestSync('store.has', [backend, item]);
}

export function storeSet(backend: SecretsBackend, item: string, value: string): Promise<void> {
  return secretsRequest('store.set', [backend, item, value]);
}
export function storeSetSync(backend: SecretsBackend, item: string, value: string): void {
  secretsRequestSync('store.set', [backend, item, value]);
}

export function remoteResolveEnv(
  target: string,
  bundle: string,
  opts?: { osLookupName?: string },
): Promise<Record<string, string>> {
  return secretsRequest('remote.remoteResolveEnv', [target, bundle, opts ?? {}]);
}

// An unset remoteSecretsHome stays unset so the receiver uses its own default root.
export function pushBundleToHost(
  bundle: string,
  host: string,
  opts: PushBundleOptions,
): Promise<PushBundleResult> {
  return secretsRequest('push.pushBundleToHost', [bundle, host, opts]);
}

export function pushBundleToHostAsync(
  bundle: string,
  host: string,
  opts: PushBundleOptions,
): Promise<PushBundleResult> {
  return secretsRequest('push.pushBundleToHostAsync', [bundle, host, opts]);
}

export function listRemoteBundles(context?: SecretsContext): Promise<RemoteBundleSummary[]> {
  return secretsRequest('sync.listRemoteBundles', [], context);
}

export function pullBundle(
  name: string,
  opts: PullOptions,
  context?: SecretsContext,
): Promise<SecretsBundle> {
  return secretsRequest('sync.pullBundle', [name, opts], context);
}

export function scanUserRcFiles(homeDir?: string, context?: SecretsContext): Promise<RcSecretFinding[]> {
  return secretsRequest('rc-hygiene.scanUserRcFiles', homeDir === undefined ? [] : [homeDir], context);
}
export function scanUserRcFilesSync(homeDir?: string, context?: SecretsContext): RcSecretFinding[] {
  return secretsRequestSync('rc-hygiene.scanUserRcFiles', homeDir === undefined ? [] : [homeDir], context);
}

export function masterPassphraseInEnv(context?: SecretsContext): Promise<boolean> {
  return secretsRequest('rc-hygiene.masterPassphraseInEnv', [], context);
}
export function masterPassphraseInEnvSync(context?: SecretsContext): boolean {
  return secretsRequestSync('rc-hygiene.masterPassphraseInEnv', [], context);
}


function isLoaderOrInterpreterEnv(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    upper.startsWith('LD_') ||
    upper.startsWith('DYLD_') ||
    [
      'NODE_OPTIONS',
      'PYTHONPATH',
      'PYTHONSTARTUP',
      'BASH_ENV',
      'ENV',
      'PERL5OPT',
      'RUBYOPT',
      'PROMPT_COMMAND',
      'IFS',
      'CDPATH',
    ].includes(upper)
  );
}

// Strip loader/interpreter injection variables before spawning the standalone secrets engine.
export function sanitizeProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {


  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (isLoaderOrInterpreterEnv(k)) continue;
    out[k] = v;
  }
  return out;
}
