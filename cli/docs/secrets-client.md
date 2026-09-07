# The standalone secrets client (`secrets-client.ts`)

`cli/src/lib/secrets-client.ts` is the **one** process client through which
agents-cli talks to the standalone `secrets` CLI (PHNX-3989). It is the
agents-owned half of the secrets extraction: the engine — bundle storage,
providers, the broker, transports — lives entirely in
[`phnx-labs/secrets-cli`](https://github.com/phnx-labs/secrets-cli), and
agents-cli reaches it only through this seam. agents-cli **never rebundles the
extracted engine** (delta-spec DIST-1); a missing executable fails loud with
install guidance rather than falling back to anything in-repo.

> Status: **complete** (PHNX-3989 Track D). Every consumer resolves through
> this client; the in-repo `cli/src/lib/secrets/` engine is deleted. Agents-owned
> policy that used to live in the engine tree — reserved per-harness stores,
> resource-profile scoping, `bundle@host` fleet-alias resolution, spawn-env
> hardening, the reserved-`auth` fleet sync — now lives in
> `cli/src/lib/reserved-stores.ts` and `cli/src/lib/secrets-policy.ts`. `agents
> secrets <anything>` is a thin exec passthrough
> (`commands/secrets-passthrough.ts`); the old in-repo command registrar and
> its command files are gone too.

## The seam

Each operation spawns `secrets __serve` and exchanges exactly one JSON message
over inherited pipes — the standalone's private consumer protocol
(`secrets-cli/src/protocol-server.ts`), separate from the child's stdout:

```
parent                              child: `secrets __serve`
  │  request JSON ──────────────────▶  fd 3 (read to EOF)
  │                                     …resolve op…
  │  ◀────────────────── response JSON  fd 4 (write, then exit)
```

- **Wire contract** (mirrored from `secrets-cli/src/protocol.ts`):
  `{ v: 1, id, op, args, context? }` in, `{ v: 1, id, ok, result | error }` out.
  `Map` arguments and results are carried through `encodeWire`/`decodeWire`
  (`{ $map: [[k, v], …] }`). This is the one thing the client re-declares rather
  than imports — a shared schema both sides must agree on byte-for-byte.
- **Handshake**, once per process (cached): the first request sends
  `op: "handshake"` and asserts the server speaks `PROTOCOL_VERSION` (1), else
  throws `PROTOCOL_UNSUPPORTED`.
- **Errors** are `SecretsClientError` carrying the server's `{ code, message }`
  (e.g. `ACCESS_DENIED`, `NOT_FOUND`), or a client-side transport code
  (`SECRETS_BIN_MISSING`, `TIMEOUT`, `PROTOCOL_UNSUPPORTED`, `SPAWN_FAILED`).

### Async and sync

Both primitives spawn one `secrets __serve` per call:

| Primitive | Transport |
|---|---|
| `secretsRequest(op, args?, context?)` | `spawn`; write+end `child.stdio[3]`, read `child.stdio[4]` to EOF. |
| `secretsRequestSync(op, args?, context?)` | `spawnSync` under a POSIX **shell**, so only stdio 0-2 cross the `spawnSync` boundary (numbered fds 3+ are **dropped by the Bun runtime**, and this repo runs its whole CLI suite as `bun src/index.ts`). The shell does the fd wiring: the request rides a **named FIFO** fed by a backgrounded `cat` (fd 3), and fd 4 is redirected onto the child's stdout (`4>&1`), captured natively as `result.stdout` on every runtime. Both fds are FIFOs, which the standalone requires (it refuses a plain file or tty for either, so no secret is staged to disk). Bounded by `SYNC_SERVE_TIMEOUT_MS` (**3 s**), not the async path's 65 s. POSIX only — Windows has no `mkfifo` and fails loud, pointing at the async path. |

`secretsRequestSync` exists for the read-only STATUS surfaces that resolve secrets
on a synchronous path — `agents view`, the account-catalog rows, run-config and
account-rotation resolution on the `agents run` hot path. There is no request-size
bound (the request streams through the FIFO, not a fixed pipe buffer), and the 3 s
timeout means a missing or unreachable standalone **fails fast**, never blocking
the whole render/launch for the standalone's own 60 s deadline. Those callers
catch the resulting `SecretsClientError` and surface one clear line while
rendering the rest (`secretsUnavailableNote`, `account-catalog.ts`); DIST-1 still
holds — there is no fallback to the embedded engine, the standalone just could not
answer.

## Environment contract

| Variable | Who sets it | Meaning |
|---|---|---|
| `SECRETS_BIN` | operator/tests (optional) | Path to the `secrets` executable. Absent ⇒ resolved from PATH, **skipping agents-cli's own shims dir** (`findInPath`): the pre-extraction `~/.agents/.cache/shims/secrets` shim `exec`s `agents secrets` and sits first on PATH, so taking it would make `agents secrets` re-enter itself without bound (the self-heal shim pass also removes that legacy shim outright). A `.js`/`.mjs`/`.cjs` value is run through this process's Node; an installed shim/binary is spawned directly. |
| `SECRETS_HOME` | **this client** | The standalone's state root. Defaults to the user agents dir (`~/.agents`, `getUserAgentsDir()`) so the user's existing stores are adopted **in place** — no copy, no re-encryption (MIG-1). An explicit value in the environment wins (test isolation, power users), matching the standalone's own precedence. |
| `SECRETS_PASSPHRASE` | **this client** (bridged) | The file-store encryption key the standalone reads. The extraction renamed every `AGENTS_SECRETS_*` knob to `SECRETS_*`, so `buildServeEnv` forwards a caller env still carrying the old `AGENTS_SECRETS_PASSPHRASE` (the name agents-cli's own engine reads) onto `SECRETS_PASSPHRASE` for the child — otherwise the standalone can't decrypt the very file store agents-cli wrote and would silently provision a fresh machine-local key (MIG-1: never silently choose another key after a decryption miss). An explicit `SECRETS_PASSPHRASE` already in the env wins; the bridge only fills the rename gap. |

The child inherits the rest of the parent env, so `SECRETS_SCOPE`/`SECRETS_CONTEXT`
already present pass through — but the client does not need to set them: the
per-request harness scope rides the protocol `context.scope` (below), and
`secrets __serve` marks its own process `SECRETS_CONTEXT=agent`.

## Policy: scope and allowed bundles (CTX-1)

The client forwards, it does not compute, the access policy. A caller passes a
`context`:

- `scope` — the harness name, folded into resolution by the standalone.
- `allowedBundles` — a resource-profile-filtered allowlist. Absent ⇒ full trust
  (the local agents client today). Present ⇒ the standalone fails **closed** to
  bundle-named operations and denies anything outside the set (`ACCESS_DENIED`).

Computing `allowedBundles` (resource-profile filtering) and choosing the scope
stay in agents-cli — this client only carries what the caller supplies.

## Typed wrappers

Thin, typed forwards onto the two primitives — the resolve/read/write/raw-CRUD
operations agents-cli's consumers hit today:

- **bundles**: `readAndResolveBundleEnv` (+`Sync`), `listBundles` (+`Sync`),
  `readBundle` (+`Sync`), `bundleExists` (+`Sync`), `bundleBackend` (+`Sync`),
  `writeBundle`, `writeBundleWithItems` (+`Sync`), `deleteBundle` (+`Sync`),
  `renameBundle` (+`Sync`), `rotateBundleSecret` (+`Sync`), `describeBundle`
- **agent**: `agentPing` (+`Sync`), `agentStatus`, `agentLock`, `ensureAgentRunning`
- **keychain items**: `getKeychainToken` (+`Sync`), `setKeychainToken` (+`Sync`),
  `hasKeychainToken` (+`Sync`), `deleteKeychainToken` (+`Sync`),
  `listKeychainItems`, `keychainUsesFileFallback`
- **store** (explicit-backend raw item CRUD): `storeGet` (+`Sync`),
  `storeHas` (+`Sync`), `storeSet`, `storeDelete`
- **remote / push**: `remoteResolveEnv`, `pushBundleToHost`, `pushBundleToHostAsync`
- **sync** (the `agents sync --secrets` umbrella stage): `listRemoteBundles`, `pullBundle`
- **rc-hygiene** (the `agents doctor` shell-rc-export advisory): `scanUserRcFiles`
  (+`Sync`), `masterPassphraseInEnv` (+`Sync`)
- **item naming** (pure, no spawn): `secretsKeychainItem(bundle, key)` →
  `agents-cli.secrets.<bundle>.<KEY>`, `profileKeychainItem(provider)` →
  `agents-cli.<provider>.token`, `keychainRef(key)` → `keychain:<KEY>`, and
  `parseBundleValue`. Raw item identifiers are part of the seam's shared schema
  (MIG-1 maps them 1:1), so agents-cli derives them here, beside the protocol,
  rather than re-deriving them per consumer.

Each `Sync` sibling exists because its consumer resolves the value on a
synchronous path (building a child env, or a `doctor`/JSON-building function
that isn't itself async) — added alongside the async wrapper only when a real
call site needed it, not speculatively. The account registry is the largest such
surface: it is a synchronous library with dozens of callers (`readAccountRegistry`,
`addAccount`, …), so converting it to async would ripple through every command that
lists accounts. Each sync call is one bounded `spawnSync`; the memo in
`claude-account-token.ts` (10 s TTL, cleared by an in-process mint/rotate) is what
keeps a usage probe over many accounts from paying that per account.

This is deliberately **not** the standalone's full op table. The remaining
bundle-metadata ops it also exposes — `bundlePolicy`, `readBundleIfDecryptable`,
`keychainItemsForBundle`, `migrateLegacyBundles` — get their wrapper as the
consumer-conversion wave (tasks.md item 6) lands the caller that needs it, so a
wrapper always ships with a real call site and a test rather than as speculative
unused surface. Converting a consumer that needs one of these is "add the one-line
forward + convert the call site", not a blocked drop-in.

`invocation(bin)` (exported alongside `resolveSecretsBin`) is the one non-op
export: it resolves how to spawn the binary (through this process's Node for a
`.js` entrypoint, or directly for an installed shim), for a caller that needs
to run a standalone verb this client doesn't wrap as an op — the `agents
secrets` passthrough (`commands/secrets-passthrough.ts`, execs any subcommand
verbatim) and `agents setup secrets` (hands off to the standalone's own
interactive `secrets migrate`) both use it.

The wrapper types are imported `type`-only from `cli/src/lib/secrets-types.ts` —
a pure re-declaration of the standalone's wire types with no runtime code, so
they add no runtime edge and nothing to the npm tarball. Keep it byte-for-byte
in sync with `secrets-cli/src/schema.ts` — this is the one seam both sides
legitimately re-declare rather than share a package for.

## Policy that stays in agents-cli

The client forwards policy; it never re-implements it. The pieces
accounts/auth/run consumers depend on live beside their callers, not in the
engine:

- **The reserved `auth` bundle is file-backed** (credential-management.md
  invariant 7). `cli/src/lib/reserved-stores.ts` carries the rule
  (`AUTH_BUNDLE_BACKEND`, `assertReservedAuthBackend`,
  `ReservedBundleWrongBackendError`, `isReservedBundleBackendError`) and every
  reserved per-harness store name (`__<harness>__`, `RESERVED_STORES`). The
  standalone enforces the same rule on its write path and answers `WRONG_BACKEND`;
  agents-cli asserts it on every read of `auth`, so a keychain- or vault-backed
  `auth` left over from an older layout fails loud instead of being silently
  ignored by usage/probe (SEC-GAP-3). `isReservedBundleBackendError` matches both
  shapes. It is a deliberate leaf module (no import of `claude-account-token.ts`
  or `secrets-policy.ts`) — both of those need it, and folding it into either
  would form a real circular import.
- **Resource-profile scoping computes `SecretsContext.allowedBundles`**
  (`cli/src/lib/secrets-policy.ts`'s `resolveSecretsContextForRun`,
  `resolveAllowedBundlesForActiveProfile`). `agents run --secrets` calls it once
  per run and forwards the result on every bundle resolution the run makes; no
  active profile is full trust (`undefined`).
- **`bundle@host` remote-reference parsing is agents' own flag syntax**
  (`secrets-policy.ts`'s `splitBundleRef`, `assertRemoteBundleFlagsUnsupported`)
  — the standalone has no concept of a host suffix.
- **Fleet sync of reserved credentials** (`secrets-policy.ts`'s
  `syncReservedAuthBundle`, `syncReservedStores`, `reconcileLocalWorkerSlots`)
  — device roles, election, and the delivery memo are agents-cli's fleet
  model, not portable secret-storage behavior.
- **Credential transport is gated on the SSH host-key pin.**
  `cli/src/lib/hosts/credential-transport.ts` holds
  `assertCredentialTransportHostPinned` and `resolveHostSshTarget`; `accounts
  sync`, `accounts mint --fleet`, and the reserved-auth sync check the pin and
  only then hand the bundle to the client's `pushBundleToHost`.

## Testing

Every test that touches an account bundle, a profile token, or the reserved
`auth` bundle drives the **real** standalone `secrets __serve` — there is no
in-memory keychain backend any more. `tests/secrets-standalone.ts` resolves the
executable once per machine: `AGENTS_TEST_SECRETS_BIN` / `SECRETS_BIN` if set
(a secrets-cli checkout's `dist/index.js`), else it installs the pinned published
`@phnx-labs/secrets-cli` into a per-version prefix under the OS temp dir with
`npm i -g --prefix` (serialized by a directory lock, reused across runs).
`tests/global-setup.ts` calls it in the main process so every fork inherits
`SECRETS_BIN`; `tests/setup.ts` pins the per-fork posture (`SECRETS_NO_AGENT=1`, a
deterministic `SECRETS_PASSPHRASE` so a headless box routes keychain items to the
encrypted file store). The state root defaults to the sandboxed `HOME`'s `.agents`,
so nothing reaches the real store; a suite that seeds state calls
`useFreshSecretsHome()` for an empty `SECRETS_HOME` per test.

Blocks that write bundles with no explicit backend or profile tokens are gated on
`standaloneKeychainIsFileBacked()`: on a headed macOS box the same calls would
reach the operator's real login keychain, and there is no per-test keychain to
isolate. File-backed bundles (the reserved `auth` bundle, `__<harness>__` stores)
run everywhere.

To run against a checkout instead of the published version:

```bash
# in a secrets-cli checkout (main)
bun install --frozen-lockfile && bash scripts/build.sh
# in cli/
AGENTS_TEST_SECRETS_BIN=/path/to/secrets-cli/dist/index.js bun run test
```

`secrets-client.test.ts` sets the legacy `AGENTS_SECRETS_PASSPHRASE` (not
`SECRETS_PASSPHRASE`) on purpose, so the round-trip exercises the passphrase
bridge above on the real store; `buildServeEnv` itself is pinned by pure unit
tests that always run.
