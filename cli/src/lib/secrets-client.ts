import { spawn, spawnSync } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { findInPath } from './agent-spec/agents.js';
import { SECRETS_CLI_INSTALL_HINT } from './secrets-cli.js';
import { getUserAgentsDir } from './state.js';
import type {
  SecretsBundle,
  SecretsBackend,
  ResolveBundleOptions,
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

export const PROTOCOL_VERSION = 1;
const MAX_PROTOCOL_BYTES = 8 * 1024 * 1024;
const SERVE_TIMEOUT_MS = 65_000;
export const SYNC_SERVE_TIMEOUT_MS = 30_000;
let syncServeTimeoutMs = SYNC_SERVE_TIMEOUT_MS;

export interface SecretsContext {
  allowedBundles?: string[];
  scope?: string;
}

interface ProtocolRequest {
  v: 1;
  id: string;
  op: string;
  args: unknown[];
  context?: SecretsContext;
}
type ProtocolResponse =
  | { v: 1; id: string; ok: true; result: unknown }
  | { v: 1; id: string; ok: false; error: { code: string; message: string } };

function encodeWire(value: unknown): unknown {
  if (value instanceof Map) {
    return { $map: [...value.entries()].map(([key, item]) => [key, encodeWire(item)]) };
  }
  if (Array.isArray(value)) return value.map(encodeWire);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeWire(item)]));
  }
  return value === undefined ? null : value;
}

function decodeWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeWire);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (Object.keys(object).length === 1 && Array.isArray(object.$map)) {
      if (object.$map.some((entry) => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')) {
        throw new SecretsClientError('INVALID_RESPONSE', 'Invalid map encoding in secrets response');
      }
      return new Map((object.$map as [string, unknown][]).map(([key, item]) => [key, decodeWire(item)]));
    }
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, decodeWire(item)]));
  }
  return value;
}

export class SecretsClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SecretsClientError';
  }

  toJSON(): { code: string; message: string } {
    return { code: this.code, message: this.message };
  }
}

export function isSecretsClientError(error: unknown, code?: string): error is SecretsClientError {
  return error instanceof SecretsClientError && (code === undefined || error.code === code);
}

const SECRETS_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'SECRETS_BIN_MISSING',
  'TIMEOUT',
  'SPAWN_FAILED',
  'SYNC_UNSUPPORTED',
  'PROTOCOL_UNSUPPORTED',
  'INVALID_RESPONSE',
  'RESPONSE_TOO_LARGE',
  'IO_ERROR',
]);

export function isSecretsTransportError(error: unknown): error is SecretsClientError {
  return error instanceof SecretsClientError && SECRETS_TRANSPORT_CODES.has(error.code);
}

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


let cachedBin: string | undefined;

export function resolveSecretsBin(): string {
  if (cachedBin) return cachedBin;
  const explicit = process.env.SECRETS_BIN?.trim();
  const resolved = explicit && explicit.length > 0 ? explicit : findInPath('secrets');
  if (!resolved) {
    throw new SecretsClientError(
      'SECRETS_BIN_MISSING',
      'The standalone `secrets` CLI was not found. Install it with:\n' +
        `  ${SECRETS_CLI_INSTALL_HINT}\n` +
        'or run `agents setup secrets`.',
    );
  }
  cachedBin = resolved;
  return resolved;
}

export function invocation(bin: string): { command: string; prefix: string[] } {
  if (/\.[mc]?js$/.test(bin)) return { command: process.execPath, prefix: [bin] };
  return { command: bin, prefix: [] };
}

export function buildServeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {

  const env: NodeJS.ProcessEnv = {
    ...base,
    SECRETS_HOME: base.SECRETS_HOME ?? getUserAgentsDir(),
  };
  if (!env.SECRETS_PASSPHRASE && base.AGENTS_SECRETS_PASSPHRASE) {
    env.SECRETS_PASSPHRASE = base.AGENTS_SECRETS_PASSPHRASE;
  }
  return env;
}

let requestCounter = 0;
function buildRequest(op: string, args: unknown[], context?: SecretsContext): ProtocolRequest {
  requestCounter += 1;
  const request: ProtocolRequest = {
    v: PROTOCOL_VERSION,
    id: `${process.pid}-${requestCounter}`,
    op,
    args: encodeWire(args) as unknown[],
  };
  if (context) request.context = context;
  return request;
}

function describeNonJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return ' (the standalone wrote nothing to fd 4)';
  const preview = trimmed.slice(0, 200).replace(/[\u0000-\u001f\u007f]/g, '?');
  return ` (first 200 bytes on fd 4: ${JSON.stringify(preview)})`;
}

function parseResponse(raw: Buffer): unknown {
  const text = raw.toString('utf8');
  let parsed: ProtocolResponse;
  try {
    parsed = JSON.parse(text) as ProtocolResponse;
  } catch {
    throw new SecretsClientError('INVALID_RESPONSE', `secrets returned a non-JSON response${describeNonJson(text)}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new SecretsClientError('INVALID_RESPONSE', 'secrets returned a malformed response envelope');
  }
  if (typeof parsed.v === 'number' && parsed.v !== PROTOCOL_VERSION) {
    throw new SecretsClientError(
      'PROTOCOL_UNSUPPORTED',
      `secrets speaks protocol ${String(parsed.v)}; this agents-cli needs ${PROTOCOL_VERSION}. ` +
        'Update the standalone CLI (npm i -g @phnx-labs/secrets-cli).',
    );
  }
  if (parsed.v !== PROTOCOL_VERSION || typeof parsed.id !== 'string') {
    throw new SecretsClientError('INVALID_RESPONSE', 'secrets returned a malformed response envelope');
  }
  if (parsed.ok) return decodeWire(parsed.result);
  throw new SecretsClientError(parsed.error.code, parsed.error.message);
}


function serveOnce(op: string, args: unknown[], context?: SecretsContext): Promise<unknown> {
  const { command, prefix } = invocation(resolveSecretsBin());
  const request = Buffer.from(JSON.stringify(buildRequest(op, args, context)));
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, '__serve'], {
      stdio: ['ignore', 'ignore', 'inherit', 'pipe', 'pipe'],
      env: buildServeEnv(),
    });
    let settled = false;
    const fail = (error: SecretsClientError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new SecretsClientError('TIMEOUT', 'secrets request timed out')),
      SERVE_TIMEOUT_MS,
    );
    child.on('error', (error) =>
      fail(new SecretsClientError('SPAWN_FAILED', `Failed to spawn secrets: ${error.message}`)),
    );
    const input = child.stdio[3] as Writable;
    input.on('error', () => {});
    input.end(request);

    const out = child.stdio[4] as Readable;
    const chunks: Buffer[] = [];
    let size = 0;
    let response: Buffer | null = null;
    let exited = false;
    const settleWhenReady = () => {
      if (settled || response === null || !exited) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(parseResponse(response));
      } catch (error) {
        reject(error);
      }
    };
    out.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PROTOCOL_BYTES) {
        fail(new SecretsClientError('RESPONSE_TOO_LARGE', 'secrets response exceeds the protocol limit'));
        return;
      }
      chunks.push(chunk);
    });
    out.on('error', (error) => fail(new SecretsClientError('IO_ERROR', error.message)));
    out.on('end', () => {
      response = Buffer.concat(chunks);
      settleWhenReady();
    });
    child.on('exit', () => {
      exited = true;
      settleWhenReady();
    });
  });
}

function shQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

function serveOnceSync(op: string, args: unknown[], context?: SecretsContext): unknown {
  if (process.platform === 'win32') {
    throw new SecretsClientError(
      'SYNC_UNSUPPORTED',
      'The synchronous secrets path needs a POSIX shell; use secretsRequest (async) on Windows.',
    );
  }
  const { command, prefix } = invocation(resolveSecretsBin());
  const request = Buffer.from(JSON.stringify(buildRequest(op, args, context)));
  const serve = [command, ...prefix, '__serve'].map(shQuote).join(' ');
  const script = `exec ${serve} 3<&0 4>&1 1>/dev/null`;
  const result = spawnSync('sh', ['-c', script], {
    input: request,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: buildServeEnv(),
    timeout: syncServeTimeoutMs,
    maxBuffer: MAX_PROTOCOL_BYTES + 4096,
  });
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === 'ETIMEDOUT') {
      throw new SecretsClientError(
        'TIMEOUT',
        `the standalone \`secrets\` CLI did not answer within ${Math.round(syncServeTimeoutMs / 1000)}s ` +
          `(${[command, ...prefix, '__serve'].join(' ')}). The machine may be too loaded to boot it in time, or the install is broken: ` +
          'check with `secrets --version`.',
      );
    }
    if (err.code !== 'EPIPE') {
      throw new SecretsClientError('SPAWN_FAILED', `secrets request failed: ${err.message}`);
    }
  }
  const raw = (result.stdout as Buffer | undefined) ?? Buffer.alloc(0);
  if (raw.length > MAX_PROTOCOL_BYTES) {
    throw new SecretsClientError('RESPONSE_TOO_LARGE', 'secrets response exceeds the protocol limit');
  }
  return parseResponse(raw);
}


export async function secretsRequest<T = unknown>(
  op: string,
  args: unknown[] = [],
  context?: SecretsContext,
): Promise<T> {
  return (await serveOnce(op, args, context)) as T;
}

export function secretsRequestSync<T = unknown>(
  op: string,
  args: unknown[] = [],
  context?: SecretsContext,
): T {
  return serveOnceSync(op, args, context) as T;
}

export function _resetSecretsClientForTest(): void {
  cachedBin = undefined;
  requestCounter = 0;
  syncServeTimeoutMs = SYNC_SERVE_TIMEOUT_MS;
}

export function _setSyncServeTimeoutForTest(ms: number): void {
  syncServeTimeoutMs = ms;
}


export function readAndResolveBundleEnv(
  name: string,
  opts?: ResolveBundleOptions,
  context?: SecretsContext,
): Promise<{ bundle: SecretsBundle; env: Record<string, string> }> {
  return secretsRequest('bundles.readAndResolveBundleEnv', [name, opts ?? {}], context);
}
export function readAndResolveBundleEnvSync(
  name: string,
  opts?: ResolveBundleOptions,
  context?: SecretsContext,
): { bundle: SecretsBundle; env: Record<string, string> } {
  return secretsRequestSync('bundles.readAndResolveBundleEnv', [name, opts ?? {}], context);
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

export const REMOTE_USER_AGENTS_DIR = '~/.agents';

export function withRemoteStateRoot(opts: PushBundleOptions): PushBundleOptions {
  return { ...opts, remoteSecretsHome: opts.remoteSecretsHome ?? REMOTE_USER_AGENTS_DIR };
}

export function pushBundleToHost(
  bundle: string,
  host: string,
  opts: PushBundleOptions,
): Promise<PushBundleResult> {
  return secretsRequest('push.pushBundleToHost', [bundle, host, withRemoteStateRoot(opts)]);
}

export function pushBundleToHostAsync(
  bundle: string,
  host: string,
  opts: PushBundleOptions,
): Promise<PushBundleResult> {
  return secretsRequest('push.pushBundleToHostAsync', [bundle, host, withRemoteStateRoot(opts)]);
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

export function sanitizeProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {


  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (isLoaderOrInterpreterEnv(k)) continue;
    out[k] = v;
  }
  return out;
}
