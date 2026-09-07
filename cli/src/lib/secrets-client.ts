/**
 * secrets-client.ts — the ONE process client through which agents-cli talks to
 * the standalone `secrets` CLI (PHNX-3989).
 *
 * This is the agents-owned half of the secrets extraction: a bounded
 * request/response client over the standalone executable's private consumer
 * pipe. It carries NO storage, provider, or broker implementation — every
 * operation is resolved by spawning `secrets __serve` and exchanging one JSON
 * message over inherited pipes (delta-spec RPC-1). The engine lives entirely in
 * the standalone package; agents-cli never rebundles it (DIST-1), so there is
 * deliberately NO fallback to the in-repo `cli/src/lib/secrets/` engine — a
 * missing executable fails loud with install guidance.
 *
 * Transport (matches secrets-cli/src/protocol-server.ts `runProtocolServer`):
 *   - the child reads the request JSON from fd 3 (to EOF) and writes the
 *     response JSON to fd 4; nothing is ever written to the child's stdout.
 *   - async: `spawn` with stdio ['ignore','ignore','inherit','pipe','pipe'];
 *     write+end child.stdio[3], read child.stdio[4] to EOF.
 *   - sync: `spawnSync` only wires stdio 0-2 portably (Bun drops numbered fds
 *     3+), so the fd 3/4 wiring is done in a POSIX shell: the request rides
 *     `spawnSync`'s STDIN — a real pipe/socketpair on every runtime — which the
 *     shell dups onto fd 3 (`3<&0`), and fd 4 is redirected onto the child's
 *     stdout (`4>&1`), which `spawnSync` captures natively. Both fds are then the
 *     SAME anonymous pipe/socketpair the async path hands the standalone, which
 *     is load-bearing: the standalone wraps fd 3 in a `net.Socket`, and a Socket
 *     over a NAMED FIFO reads the request but never fires EOF on macOS, so the
 *     older FIFO wiring hung the read loop for the full timeout. Bounded to
 *     `SYNC_SERVE_TIMEOUT_MS` so a broken standalone fails fast, never for the
 *     server's 60s deadline. POSIX only; Windows fails loud pointing at the
 *     async path.
 *
 * State root (MIG-1): the standalone selects its state root from `SECRETS_HOME`.
 * agents-cli points it at the user agents dir (`~/.agents`) by default so the
 * user's existing stores are adopted in place — no copy, no re-encryption. An
 * explicit `SECRETS_HOME` in the environment wins (test isolation, power users),
 * matching the standalone's own `state.ts` precedence.
 *
 * Policy (CTX-1): agents-cli passes its harness name as the opaque `scope` and,
 * when a request must be bounded, a resource-profile-filtered `allowedBundles`
 * set. Computing that policy stays in agents-cli (the caller supplies `context`);
 * this client only forwards it.
 *
 * The typed shapes are imported `type`-only from `./secrets-types.js`, a pure
 * re-declaration of the standalone's wire types (no runtime code, nothing in
 * the npm tarball beyond the erased type import) — this repo's own in-process
 * engine (`cli/src/lib/secrets/**`) is gone (PHNX-3989 Track D); the standalone
 * `@phnx-labs/secrets-cli` package is the only implementation.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { findInPath } from './agent-spec/agents.js';
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

/**
 * Wire contract, mirrored from `secrets-cli/src/protocol.ts`. Both sides MUST
 * agree byte-for-byte; this is the shared schema of the seam, the one thing an
 * independent client legitimately re-declares rather than imports.
 */
export const PROTOCOL_VERSION = 1;
const MAX_PROTOCOL_BYTES = 8 * 1024 * 1024;
/** Just over the server's own 60s deadline, so the server times out first. */
const SERVE_TIMEOUT_MS = 65_000;
/**
 * The synchronous path only serves read-only STATUS surfaces — `agents view`,
 * the account-catalog rows, and run-config / account-rotation resolution on the
 * `agents run` hot path. Those must never hang the whole render or launch on a
 * missing or unreachable standalone, so the sync serve carries a short, hard
 * bound instead of the async path's 65s: a broken `secrets` fails loud in a few
 * seconds and the caller renders the rest of its output (or launches on the
 * native login) with one clear line, rather than sitting for the standalone's
 * own 60s deadline (the exact 60s hang PHNX-3989 hit when the child ran under
 * Bun). A real sync op (a handshake, a bundle list, one item read) completes in
 * tens of milliseconds, so this is ~100x headroom. It is NOT a fallback to the
 * embedded engine (DIST-1); the standalone stays the only implementation, it
 * just fails fast.
 */
const SYNC_SERVE_TIMEOUT_MS = 3_000;

export interface SecretsContext {
  /** Bundle allowlist; absent ⇒ full trust (the local agents client today). */
  allowedBundles?: string[];
  /** Opaque scope the standalone folds into resolution — the harness name. */
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

/** Serialize `Map`s the way the server's `decodeWire` expects to receive them. */
export function encodeWire(value: unknown): unknown {
  if (value instanceof Map) {
    return { $map: [...value.entries()].map(([key, item]) => [key, encodeWire(item)]) };
  }
  if (Array.isArray(value)) return value.map(encodeWire);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeWire(item)]));
  }
  return value === undefined ? null : value;
}

/** Reconstruct `Map`s from the server's `encodeWire`'d reply. */
export function decodeWire(value: unknown): unknown {
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

/** Carries the server's `{code, message}`, or a client-side transport code. */
export class SecretsClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SecretsClientError';
  }

  /**
   * Serialize to a plain `{code, message}`. A consumer that folds a failure into
   * a structure it later `JSON.stringify`s (a teammate's meta.json, a failure
   * record, a spawn env) must never make the serializer chase this Error's
   * internal references and throw `Converting circular structure to JSON`
   * mid-launch — the value here is the two fields a caller actually needs.
   */
  toJSON(): { code: string; message: string } {
    return { code: this.code, message: this.message };
  }
}

/** True when `error` is a {@link SecretsClientError}, optionally with the given code. */
export function isSecretsClientError(error: unknown, code?: string): error is SecretsClientError {
  return error instanceof SecretsClientError && (code === undefined || error.code === code);
}

/**
 * Client-side TRANSPORT codes — the standalone could not be reached or spoke a
 * broken protocol. These are the ONLY errors a "degrade when the standalone is
 * unavailable" consumer may swallow: a code from the standalone's own reply
 * (`NOT_FOUND`, `LOCKED`, `WRONG_BACKEND`, `OPERATION_FAILED`, `ACCESS_DENIED`, …)
 * is a real answer and must surface, never be hidden as "unavailable".
 */
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

/** True when `error` is a {@link SecretsClientError} from the transport itself (the
 * standalone was unreachable/unusable), not a data error it answered with. */
export function isSecretsTransportError(error: unknown): error is SecretsClientError {
  return error instanceof SecretsClientError && SECRETS_TRANSPORT_CODES.has(error.code);
}

// --- item naming (the shared identifier scheme of the seam) ---------------
//
// Raw item identifiers are part of the wire contract, mapped 1:1 across the
// cutover (delta-spec MIG-1): the standalone stores a bundle's per-key value at
// `agents-cli.secrets.<bundle>.<KEY>` and a profile provider token at
// `agents-cli.<provider>.token`, and a bundle var that reads `keychain:<KEY>`
// refers to the former. agents-cli derives these names whenever it seeds or
// reads a raw item (account bundles, profile tokens, the reserved `auth`
// bundle), so they are declared once here beside the protocol schema rather
// than re-derived per consumer.
const SERVICE_PREFIX = 'agents-cli';
export const SECRETS_ITEM_PREFIX = `${SERVICE_PREFIX}.secrets.`;

/** The raw item holding one bundle key's value. */
export function secretsKeychainItem(bundle: string, key: string): string {
  return `${SECRETS_ITEM_PREFIX}${bundle}.${key}`;
}

/** The raw item holding a profile provider's token (`agents-cli.<provider>.token`). */
export function profileKeychainItem(provider: string): string {
  return `${SERVICE_PREFIX}.${provider}.token`;
}

/** The bundle-var form that points a key at its own raw item. */
export function keychainRef(key: string): string {
  return `keychain:${key}`;
}

export type { BundleValue, SecretRef };
const REF_PATTERN = /^(keychain|env|file|exec):(.+)$/s;

/**
 * Parse a bundle value into either a literal string or a typed secret ref. A
 * `{ value }` object is an escaped literal (a URL that happens to start with a
 * ref prefix is never misread as a reference).
 */
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

// --- executable resolution -------------------------------------------------

let cachedBin: string | undefined;

/**
 * Resolve the standalone `secrets` executable: `$SECRETS_BIN` if set, else the
 * `secrets` command on PATH — resolved with `findInPath`, which skips agents-cli's
 * own shims dir. That skip is load-bearing, not tidiness: before PHNX-3989 the
 * shims dir carried a `secrets` command shim that `exec`s `agents secrets`, it
 * sits FIRST on PATH, and it survives an in-place upgrade (its baked entrypoint
 * still exists). A plain `which secrets` returned that shim, so `agents secrets`
 * → shim → `agents secrets` → … spawned an unbounded process chain on every box
 * upgraded from 1.22.84 (the whole fleet, via R5 auto-update). A `secrets` inside
 * our shims dir can never be the standalone, so it is not a candidate at all.
 * Cached for the process. A miss throws with install guidance — there is NO
 * fallback to the embedded engine (DIST-1).
 */
export function resolveSecretsBin(): string {
  if (cachedBin) return cachedBin;
  const explicit = process.env.SECRETS_BIN?.trim();
  const resolved = explicit && explicit.length > 0 ? explicit : findInPath('secrets');
  if (!resolved) {
    throw new SecretsClientError(
      'SECRETS_BIN_MISSING',
      'The standalone `secrets` CLI was not found. Install it with:\n' +
        '  npm i -g @phnx-labs/secrets-cli\n' +
        'or point $SECRETS_BIN at its executable.',
    );
  }
  cachedBin = resolved;
  return resolved;
}

/**
 * How to invoke the resolved binary. A `.js`/`.mjs`/`.cjs` entrypoint (a dev
 * build, or `$SECRETS_BIN` pointing at `dist/index.js`) is run through this
 * process's Node so it works without an executable bit and on Windows; an
 * installed `secrets` shim/binary is spawned directly. Exported so a caller
 * that needs to run an interactive standalone verb directly (e.g. `secrets
 * migrate`, which isn't in this client's op table) can build the same argv.
 */
export function invocation(bin: string): { command: string; prefix: string[] } {
  if (/\.[mc]?js$/.test(bin)) return { command: process.execPath, prefix: [bin] };
  return { command: bin, prefix: [] };
}

/**
 * Spawn env for the child, applied to a base env (defaults to `process.env`):
 *
 *  - `SECRETS_HOME` defaults to the user agents dir so the standalone adopts the
 *    existing stores in place (MIG-1); an explicit value in the base env wins.
 *  - The standalone renamed every `AGENTS_SECRETS_*` knob to `SECRETS_*`, so a
 *    caller env still carrying the old `AGENTS_SECRETS_PASSPHRASE` (the name
 *    agents-cli's own engine reads — filestore/linux/windows) would be invisible
 *    to `secrets`, which reads only `SECRETS_PASSPHRASE`. Forward it so the child
 *    can decrypt the very file store agents-cli wrote, rather than silently
 *    provisioning a fresh machine-local key. An explicit `SECRETS_PASSPHRASE`
 *    wins — this only bridges the rename, it never overrides.
 *
 * Exported for the seam test (a pure env mapping, no spawn).
 */
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

/**
 * Describe what the child actually wrote on fd 4 when it did not parse as JSON,
 * so a wrong `secrets` on PATH (a shim printing usage, an unrelated binary), a
 * child that ran under the wrong runtime and never answered, or a silent write
 * failure is diagnosable from the error alone rather than a bare "non-JSON
 * response". Bounded to 200 bytes; control bytes are stripped so the message
 * stays one readable line.
 */
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
  if (!parsed || parsed.v !== PROTOCOL_VERSION || typeof parsed.id !== 'string') {
    throw new SecretsClientError('INVALID_RESPONSE', 'secrets returned a malformed response envelope');
  }
  if (parsed.ok) return decodeWire(parsed.result);
  throw new SecretsClientError(parsed.error.code, parsed.error.message);
}

// --- raw transport (one spawn per request) ---------------------------------

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
    // A child that dies before reading gives EPIPE here; the outcome surfaces on
    // fd 4 / 'error' instead, so this handler just keeps it from throwing.
    const input = child.stdio[3] as Writable;
    input.on('error', () => {});
    input.end(request);

    // Settle only when BOTH the response has been read to EOF AND the child has
    // fully exited. The standalone writes its response to fd 4 and closes it
    // *before* it finishes: on the way out it still releases its proper-lockfile
    // lock dir and flushes its meta/events log under the store's `.cache`.
    // Resolving on fd-4 EOF alone let the caller (e.g. a test tearing down its
    // throwaway SECRETS_HOME) race those trailing writes — an ENOTEMPTY rmdir.
    // Awaiting child exit makes the store quiescent the instant secretsRequest
    // resolves, so no consumer needs a cleanup retry.
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

/** POSIX single-quote a token so the shell passes it to the child verbatim. */
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
  // The standalone's private protocol reads the request from fd 3 and writes the
  // response to fd 4, wrapping BOTH in a `net.Socket` (secrets-cli
  // `runProtocolServer`). It also REFUSES a plain file or tty for either — fd 3/4
  // MUST be a pipe or socket (`PRIVATE_PIPE_REQUIRED`) — so no secret is ever
  // staged to disk. But `spawnSync` only wires stdio 0-2 portably — the Bun
  // runtime (this repo runs its whole CLI suite as `bun src/index.ts`, so the CLI-
  // integration tests spawn agents-cli under Bun) silently DROPS numbered fds 3+,
  // so the numbered-fd wiring is done in a POSIX shell.
  //
  // The request rides `spawnSync`'s STDIN, which every runtime backs with a real
  // pipe/socketpair, and the shell dups it onto fd 3 (`3<&0`); fd 4 is dup'd from
  // the captured stdout pipe (`4>&1`), then the child's own fd 1 is sent to
  // /dev/null (`1>/dev/null`, AFTER `4>&1` so fd 4 keeps the pipe) — so the
  // response channel (fd 4) is structurally the ONLY writer to the captured
  // stream and a stray write to the standalone's own stdout can never corrupt the
  // fd-4 bytes. Crucially, fd 3 and fd 4 are now the SAME anonymous
  // pipe/socketpair the async path hands the standalone via `spawn` numbered
  // stdio, rather than a named FIFO: a `net.Socket` wrapped around a named FIFO
  // reads the request but never fires EOF on macOS, so the standalone's
  // `for await (const chunk of input)` on fd 3 would hang for the full timeout
  // (the bug the old FIFO wiring hit — spawnSync's stdout IS a socketpair, so fd 4
  // was fine, but the FIFO on fd 3 never EOF'd). `exec` so the wrapper `sh`
  // BECOMES the standalone (same PID): `spawnSync` waits on the real process, so
  // on return the store is fully flushed and its lock dir released, and a timeout
  // SIGTERM lands on the standalone itself rather than orphaning a wedged child.
  // The response never touches disk. The shell wiring is parent-runtime-agnostic
  // — `spawnSync`'s stdio is a socketpair under both Node and Bun — so fd 3 EOFs
  // whenever the standalone itself runs under Node. (A standalone that `invocation`
  // launches under BUN still hits its own PHNX-3989 EOF hang regardless of the
  // wiring; that stays bounded by SYNC_SERVE_TIMEOUT_MS below, as before.)
  const serve = [command, ...prefix, '__serve'].map(shQuote).join(' ');
  const script = `exec ${serve} 3<&0 4>&1 1>/dev/null`;
  const result = spawnSync('sh', ['-c', script], {
    input: request,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: buildServeEnv(),
    timeout: SYNC_SERVE_TIMEOUT_MS,
    maxBuffer: MAX_PROTOCOL_BYTES + 4096,
  });
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    const code = err.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'SPAWN_FAILED';
    throw new SecretsClientError(code, `secrets request failed: ${err.message}`);
  }
  const raw = (result.stdout as Buffer | undefined) ?? Buffer.alloc(0);
  if (raw.length > MAX_PROTOCOL_BYTES) {
    throw new SecretsClientError('RESPONSE_TOO_LARGE', 'secrets response exceeds the protocol limit');
  }
  return parseResponse(raw);
}

// --- handshake (once per process) ------------------------------------------

let handshakeReady = false;
let handshakePromise: Promise<void> | null = null;

function checkHandshake(result: unknown): void {
  const protocol = (result as { protocol?: unknown } | null)?.protocol;
  if (protocol !== PROTOCOL_VERSION) {
    throw new SecretsClientError(
      'PROTOCOL_UNSUPPORTED',
      `secrets speaks protocol ${String(protocol)}; this agents-cli needs ${PROTOCOL_VERSION}. ` +
        'Update the standalone CLI (npm i -g @phnx-labs/secrets-cli).',
    );
  }
}

async function ensureHandshake(): Promise<void> {
  if (handshakeReady) return;
  if (!handshakePromise) {
    handshakePromise = (async () => {
      checkHandshake(await serveOnce('handshake', []));
      handshakeReady = true;
    })().catch((error) => {
      handshakePromise = null;
      throw error;
    });
  }
  await handshakePromise;
}

function ensureHandshakeSync(): void {
  if (handshakeReady) return;
  checkHandshake(serveOnceSync('handshake', []));
  handshakeReady = true;
}

// --- primitives ------------------------------------------------------------

/**
 * Send one operation to the standalone secrets CLI and await its typed result.
 * Verifies the executable speaks protocol v1 once per process (cached), then
 * spawns `secrets __serve` for the operation. Throws a {@link SecretsClientError}
 * carrying the server's `{code, message}` on failure.
 */
export async function secretsRequest<T = unknown>(
  op: string,
  args: unknown[] = [],
  context?: SecretsContext,
): Promise<T> {
  await ensureHandshake();
  return (await serveOnce(op, args, context)) as T;
}

/**
 * Synchronous sibling of {@link secretsRequest} for the consumers that resolve
 * secrets on a synchronous path (e.g. building a child env before spawn).
 * Bounded by a spawn timeout. POSIX only.
 */
export function secretsRequestSync<T = unknown>(
  op: string,
  args: unknown[] = [],
  context?: SecretsContext,
): T {
  ensureHandshakeSync();
  return serveOnceSync(op, args, context) as T;
}

/** Test hook: forget the cached binary + handshake so a new env is re-resolved. */
export function _resetSecretsClientForTest(): void {
  cachedBin = undefined;
  handshakeReady = false;
  handshakePromise = null;
  requestCounter = 0;
}

// --- typed wrappers -------------------------------------------------------
//
// The resolve/read/write/raw-CRUD ops today's consumers hit — one thin, typed
// forward each onto the two primitives above; the standalone remains the single
// implementation. Async by default; the read-hot operations agents-cli resolves
// synchronously carry a `*Sync` sibling.
//
// This is deliberately NOT the standalone's full op table. The remaining
// bundle-metadata ops it also exposes — `bundlePolicy`,
// `readBundleIfDecryptable`, `keychainItemsForBundle`, `migrateLegacyBundles`
// — get their wrapper as the consumer-conversion wave (tasks.md item 6) lands
// each caller that needs it, so a wrapper always ships with a real call site
// and a test rather than as speculative unused surface. (`describeBundle`,
// `bundleBackend`, `renameBundle`, `rotateBundleSecret`, and the `sync.*` /
// `rc-hygiene.*` groups have landed with the consumers that needed them.)

// bundles.*
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

/**
 * Per-key kind breakdown (`literal`/`file`/`onepassword`/…) of an already-resolved
 * bundle — the cosmetic `[secrets] Resolved <name>: N keys (…)` summary line. Pure
 * over the bundle document server-side; the wrapper forwards the object the caller
 * already holds from {@link readAndResolveBundleEnv} so the same shape is described.
 */
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

export function deleteBundle(name: string, context?: SecretsContext): Promise<boolean> {
  return secretsRequest('bundles.deleteBundle', [name], context);
}
export function deleteBundleSync(name: string, context?: SecretsContext): boolean {
  return secretsRequestSync('bundles.deleteBundle', [name], context);
}

/** Rename a bundle: metadata and raw items move together; the source is deleted last. */
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

/** Rotate one keychain-backed key's value in place, preserving or patching its meta. */
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

// agent.*
export function agentPing(): Promise<{ reachable: boolean; cliVersion?: string }> {
  return secretsRequest('agent.agentPing', []);
}
export function agentPingSync(): { reachable: boolean; cliVersion?: string } {
  return secretsRequestSync('agent.agentPing', []);
}

export function agentStatus(): Promise<AgentStatusEntry[]> {
  return secretsRequest('agent.agentStatus', []);
}

export function agentLock(name?: string): Promise<number> {
  return secretsRequest('agent.agentLock', name === undefined ? [] : [name]);
}

export function ensureAgentRunning(timeoutMs?: number): Promise<boolean> {
  return secretsRequest('agent.ensureAgentRunning', timeoutMs === undefined ? [] : [timeoutMs]);
}

// index.* (keychain items)
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

/**
 * True when `keychain`-backend items are being routed to the standalone's
 * encrypted file store (headless Linux/Windows with no reachable keyring):
 * on such a host no test or probe can reach a real OS keychain.
 */
export function keychainUsesFileFallback(): Promise<boolean> {
  return secretsRequest('index.keychainUsesFileFallback', []);
}

// store.* (explicit-backend raw item CRUD)
export function storeGet(backend: SecretsBackend, item: string): Promise<string> {
  return secretsRequest('store.get', [backend, item]);
}
export function storeGetSync(backend: SecretsBackend, item: string): string {
  return secretsRequestSync('store.get', [backend, item]);
}

export function storeHas(backend: SecretsBackend, item: string): Promise<boolean> {
  return secretsRequest('store.has', [backend, item]);
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

export function storeDelete(backend: SecretsBackend, item: string): Promise<boolean> {
  return secretsRequest('store.delete', [backend, item]);
}

// remote.* / push.*
export function remoteResolveEnv(
  target: string,
  bundle: string,
  opts?: { osLookupName?: string },
): Promise<Record<string, string>> {
  return secretsRequest('remote.remoteResolveEnv', [target, bundle, opts ?? {}]);
}

/**
 * The user agents dir as the RECEIVING agents-cli resolves it — `~/.agents` on
 * every box, the same root {@link buildServeEnv} pins the local standalone to
 * (MIG-1). A push must name it, because the remote `secrets` otherwise runs
 * under its own default `~/.secrets`: the import succeeds, the file store there
 * is keyed by a different machine-local passphrase, and the receiving daemon's
 * `readReservedCredential` never finds the bundle (yosemite-m0, 2026-09-07:
 * `pushed __cursor__` on the publisher, `no readable durable key` on the worker).
 * Remote-relative on purpose — the local absolute dir means nothing over there.
 */
export const REMOTE_USER_AGENTS_DIR = '~/.agents';

/** Fill in the remote state root unless the caller named one. Pure, for the seam test. */
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

// sync.* (transport pull, used by the `agents sync --secrets` umbrella stage)
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

// rc-hygiene.* (shell-rc credential-export advisory, `agents doctor`)
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

// --- env sanitization (EXEC-1: deny loader/interpreter overrides) ----------
//
// Pure, engine-free — every spawn boundary strips these before either an
// injected secrets env or the bare process env reaches a child, so a bundle
// (or an inherited shell) can never smuggle a loader/interpreter override into
// an agent's process.

/** True for a dynamic-loader or language-interpreter override env var. */
export function isLoaderOrInterpreterEnv(name: string): boolean {
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

/** Strip loader/interpreter overrides from an env before it reaches a spawned child. */
export function sanitizeProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (isLoaderOrInterpreterEnv(k)) continue;
    out[k] = v;
  }
  return out;
}
