<!-- guide -->
# Credential management — the fleet auth model

Status: design (target state). Companion to
[`secrets-trust-boundaries.md`](secrets-trust-boundaries.md).

## The problem

Every agent harness authenticates with a **rotating, interactive OAuth login**
stored on disk (Claude Code's `.claude/.credentials.json`, `.codex/auth.json`,
`.grok/auth.json`, `.kimi-code/…`, antigravity's Google token, droid's encrypted
blob). Measured on a live box, all of them are the same shape: a short-lived access
token plus a **single-use refresh token that rotates server-side on every refresh**.

Two failures follow from treating that login as fleet state:

1. **Fleet-wide logout.** `agents fleet apply` copies the login file across machines
   (`FLEET_AUTH_FILES`). When one box refreshes, the server rotates the refresh
   token and invalidates every other copy — the whole fleet drops to "run /login"
   (the codebase already documents this: `fleet/remote-login.ts` — "droid collapsed
   10 boxes → 1 overnight").
2. **Touch ID storm.** On macOS the login lives in the login Keychain, ACL-bound to
   the harness (Claude Code, etc.). agents-cli isn't on that ACL, so every time it
   reads the token — to draw `ag view` usage bars, to select an account — macOS
   pops a Touch ID sheet.

Both come from the same mistake: **agents-cli touching the interactive login.**

## The invariants (non-negotiable)

1. **The daemon holds no token.** No fallback, no injected, no per-account token. It
   never reuses a live/interactive token, never refreshes or rotates one, never logs
   in for the user. A routine runs the *exact same* `agents run` process a user runs
   directly. (Shipped: PR #1583.) See [`routines.md`](routines.md).

2. **The interactive/rotating login is untouchable.** agents-cli never reads,
   stores, syncs, or references a harness's interactive OAuth login. Not for usage,
   not for fleet sync, not for account selection. It is never written to the keychain
   by us and never copied across devices. It stays on the box that minted it and
   refreshes itself there. Enforced on the transfer paths too (RUSH-2527): neither
   `agents run --host --copy-creds` nor `agents run --lease` serializes a native
   login (Claude OAuth + codex/grok/gemini `auth.json`) to another device — both
   **refuse** and steer to a portable provider account, sharing the one
   `isNativeOAuthRuntime` predicate (`src/lib/hosts/credentials.ts` →
   `buildHostCredentialScript`, `src/lib/crabbox/runtimes.ts` →
   `buildCredentialScript`; SING-1b). Portable account bundles still cross the
   fleet through the explicit `agents accounts sync` path.

3. **The only credential agents-cli manages is a deliberate, durable credential.** A
   long-lived, **non-rotating** OAuth setup-token / API key / bearer token
   (`claude setup-token`, `OPENAI_API_KEY`, `XAI_API_KEY`, `FACTORY_API_KEY`, …).
   Valid until explicitly revoked → **safe to reuse on many devices, no repeated
   logouts, no revocation cascade.** That safety property is the whole reason it, and
   only it, is shareable.

4. **Shipped (RUSH-2470): each provider account is its own named `agents secrets`
   bundle.** `agents accounts add <name> --provider <p>
   --auth <type>` creates a bundle named after the account, with secrets policy
   `never` set unconditionally — never the OS keychain's biometry ACL, so reading
   it raises no Touch ID prompt. A user can
   hold as many named provider accounts as they need, and only the accounts they explicitly
   `agents accounts sync <name> --device <device>` cross the fleet.
   **Reserved names are the exception (PHNX-3940):** a harness's durable *worker*
   credential lives in a per-harness reserved store `__<harness>__`
   (`RESERVED_STORES`), and `auth` is the reserved legacy alias for `__claude__`
   (the claude setup-token store). A user-created bundle can never take a
   `__`-prefixed or `auth` name — the secrets layer refuses it. See
   [§Slots and reserved stores](#slots-and-reserved-stores-phnx-3940). That sync (and
   every `agents secrets` transport that moves credential bytes) rides a hardened
   SSH posture (RUSH-2527): the destination is verified against the CLI-managed
   known_hosts store — a **changed** host key is refused — and the credential
   connection is never multiplexed, so it leaves no reusable authenticated control
   master behind. Secret bytes cross on ssh **stdin** (push) / **stdout** (resolve),
   never on argv.

5. **Usage probes read the setup-token**, not the interactive login — and never
   a prompting keychain read. Caveat (RUSH-2392): Anthropic's
   `claude setup-token` is scoped `user:inference` only; the usage endpoint
   requires `user:profile`, so a setup-token cannot populate bars through that
   endpoint. Interactive Claude sessions populate the same per-account cache
   without exposing a credential: Claude Code sends its native five-hour and
   seven-day rate limits to the managed status-line command after responses.
   `agents view` reads those snapshots. A headless account that has not produced
   a native snapshot still renders `usage unavailable (headless)`.

   **Claude is event-fed, not polled.** The managed Claude settings command is
   `agents __claude-statusline`. Resource sync merges that command into each
   version home's existing `settings.json`, preserving every other setting and
   delegating a prior custom status-line command. Claude Code invokes it with
   `rate_limits` only after a real inference response; launching Claude without
   receiving a response can therefore show host/account/model while leaving quota
   unchanged. The account part is the registered account name for that home's
   identity when one exists, else the email from its `.claude.json`
   (`readClaudeIdentity`, the one read per render the usage ingest shares) — file
   reads only; it never touches the credential. The five-hour and seven-day fields may arrive independently, so
   ingestion merges each window into the last snapshot instead of replacing the
   other one. `agents view claude` always reserves both `S` and `W` slots: a
   provider-omitted window is a filled red `unavailable` slot, distinct from a real
   zero-percent window. Do not restore `/api/oauth/usage` polling or read/copy the
   interactive OAuth credential to fill these bars.

6. **Zero Touch ID** — `ag view`, agent launch, usage, any op — across **every
   harness**, including the hard ones (Droid, Kimi). Solution decided per credential
   *type*, not per agent name.

7. **Device role decides the credential source, and the two roles never cross
   (owner rule — do not regress).** This is an explicit, standing requirement from
   the fleet owner; treat it as non-negotiable and never "optimize" it away.

   - **Personal / desktop devices (headed — e.g. `zion`) authenticate with the
     harness's NORMAL interactive OAuth login (the native login), minted on that
     device.** A headed device MUST NOT authenticate from the injected long-term
     setup-token. Two reasons: (a) the setup-token is identity-blind — it surfaces
     no email / account, so a machine a human works on must carry a real,
     inspectable native login; (b) the personal device is the machine that *mints*
     the durable token (below), so it is the one place the interactive login must
     live. This is the headed-device branch in
     `src/lib/harness/adapters/claude.ts` (`isHeadedDeviceRole`): it defers to the
     native login and drops an inherited copy of *that account's* setup-token
     (matched by value; the broader "strip any inherited token" is the still-open
     RUSH-2360 follow-up) (RUSH-2395).

   - **Worker devices authenticate with the durable long-term setup-token**,
     synced from the account bundle. Workers hold no interactive login.

   - **Minting flow (must be automatic).** The durable `claude setup-token` is
     obtained by running the setup-token flow ON a personal device (`zion`); the
     minted token must be saved into the account store automatically and propagated
     to worker devices via `agents accounts sync` / the reserved `auth` bundle — it
     must NOT require the owner to hand-copy the token through 1Password and have an
     agent re-inject it. `agents accounts add claude <name>` is the one-shot that
     logs in, mints, and seeds; `agents accounts login claude#<name>` re-mints.

   - **A dead login on a headed device is fixed by re-running the native OAuth
     flow on that device — NEVER by falling back to the injected setup-token.** Any
     change that makes a personal/desktop device consume the long-term token
     (including a well-meant "the native login expired, so use the token instead"
     fallback) is a REGRESSION of this rule and must not be added. The correct
     remedy for a logged-out personal home is `agents accounts login claude#<name>`
     (or `claude` → `/login`), which restores a real identity-bearing native login.

### Slots and reserved stores (PHNX-3940)

An account is a credential slot, not an installation. The binary lives in the
one managed harness install; each account materializes as a HOME-shaped dir at
`~/.agents/.history/accounts/<harness>/<accountId>/` with no binary in it.
`DeviceAccountSlot` records (`accountId`, `slotDir`, `authMode`, `verdict`) live
in the **device doc** (`deviceAccounts.slots`) and never the fleet-synced
central file — a slot path is local, and a native OAuth/session file never
leaves the device that minted it.

Durable worker credentials live in one reserved store per harness, named
`__<harness>__` from a hard-coded table (`RESERVED_STORES`, derived from
`AGENT_IDS`; `lib/reserved-stores.ts`). Each store is a real **file-backed,
policy-`never` bundle** — the same shape as the legacy `auth` bundle — because the
only transport to a worker is the ordinary bundle push (`pushBundleToHost`), which
reads the store as a bundle and imports it remotely as one; the standalone accepts
the `__<name>__` shape from secrets-cli 0.1.1. The push names the remote state root
(`remoteSecretsHome: '~/.agents'`, filled in by the client wrapper — secrets-cli
0.1.2), so the receiving `secrets` writes the same `~/.agents` root the worker's
daemon reads instead of its own default `~/.secrets`. A user-created bundle whose name
starts with `__` — or the reserved `auth` alias — is refused (`isReservedStoreName`).
A key written by 1.22.84–1.22.89 as a bare file item (no bundle record) is adopted
into its bundle by the next `auth-sync` tick (`adoptLegacyReservedStoreItems`);
the item name is unchanged, so workers that already hold it are unaffected.
The store accepts only a **setup-token** or an **API key** at write time; a
rotating OAuth/session file is rejected with a harness-specific reason (the
RUSH-1958 class: a refresh-bearing session reused on two devices logs the owner
out). The legacy `auth` bundle remains a readable alias for `__claude__`; this
track does not migrate data.

## Provisioning model — the canonical, non-reversible flow (owner requirement)

This is how every harness account is set up across the fleet. It is a standing
owner requirement: **do not redesign or reverse it.** It follows directly from
invariant 7 (device role decides the credential) and the per-harness capability
map below.

**Headed devices (`personal` and `desktop`) each authenticate with their own
native interactive OAuth login** (invariant 7) — minted by a human, in a browser,
on that box; never a copied token. The **`personal` laptop is additionally the
canonical origin where durable tokens are minted for DISTRIBUTION** to workers
(step 1 below) — it is the interactive seat the owner works at. **`worker` boxes
NEVER run an interactive login flow;** they authenticate only from a distributed
durable credential.

From that one origin, a harness is provisioned to the rest of the fleet by exactly
one of two paths, chosen by whether the harness exposes a **portable long-term
credential** (see the per-harness map):

1. **Token-bearing harnesses → add-once-on-laptop, daemon provisions workers.**
   For a harness that has a durable, non-rotating credential — `claude`
   (`setup-token`, 1yr), `codex`/`grok`/`cursor`/`opencode` (provider API key),
   `droid` (`FACTORY_API_KEY`) — run `agents accounts add <harness> [name]` on
   the laptop (`accounts login <harness>#<name>` re-mints). That command logs
   in natively in a new slot, registers the fleet-wide row, and stores the
   worker credential in the reserved `__<harness>__` store under
   `<ENV>_<accountId>` (never a rotating OAuth/session file). The daemon's
   auth-sync tick then pushes **that key** to `role=worker` peers and
   materializes a slot on each; headed peers receive the row, never the key
   (invariant 7). `agents accounts sync` remains the manual reconcile. A
   separately named provider account (`accounts add <name> --provider`) is
   still a policy-`never` user bundle, not a reserved store.

2. **Token-less harnesses → log in per box (cannot be copied).** `kimi` (no env
   auth, `config.toml` only) and `antigravity` (opaque keychain login, no working
   portable key) expose no shareable credential, so each box that runs them must
   hold its own login — `agents fleet login` (per-box device-code over SSH, writes
   the credential locally, never transports it). This is a harness limitation, not
   a bug, and it is why the fleet holds e.g. two separate antigravity subs on two
   boxes rather than one copied everywhere.

**Forbidden (the reverse of the above):** running an interactive OAuth flow on a
worker; treating a copied long-term token as a headed device's own runtime
credential; or copying a rotating native OAuth session between devices
(invariant 2). Any of these is a regression.

### How the daemon reconciles it — per key, per role (PHNX-3940 T6)

Step 1's "propagate + auto-inject" is the daemon's `auth-sync` tick, generalized
from the single legacy `auth` bundle to every portable account:

- **The plan is per ACCOUNT and per KEY, not per bundle.** Each portable account
  resolves to one reserved-store key `<ENV>_<accountId>` (a claude row predating
  T1 falls back to the legacy `auth` bundle keyed by email). The elected single
  publisher pushes a reserved store to a peer whenever that peer is missing **any**
  of its keys — so a newly-added account propagates within one tick, instead of
  being hidden behind a bundle-coarse "already has the bundle" verdict.
  (`planReservedStoreSync` / `reservedSyncTargets`, `lib/secrets-policy.ts`.)
- **The publisher is a ready HEADED device.** `electPublisher` ranks every device
  reporting `auth: ready` headed-first (`personal`/`desktop`, where tokens are
  minted and the copy of record lives), then by name to break ties, so every box
  elects the same one. A worker is elected only when no headed device is ready.
  Sorting by name alone (the pre-fix rule) elected `mac-mini` — a worker holding a
  six-day-old copy of `auth` — over `zion`, and zion then skipped every peer as
  "another ready device is the elected publisher".
- **Pushes target `role=worker` devices only.** A headed (`personal`/`desktop`)
  peer receives the account **row** through the normal repo sync, but **never a
  durable key** — it authenticates from its own native login (invariant 7). The
  filter is `isHeadedDeviceRole` on the peer's synced role.
- **After a key lands on a worker, the daemon materializes a slot for it — for
  every registered account, T1 or legacy.** `reconcileLocalWorkerSlots` walks
  `reservedSyncTargets` (the same resolver the push plan uses), so a T1 row keys
  its reserved `__<harness>__` store and a claude row predating T1 keys the legacy
  `auth` bundle by email; whichever key is on the box, `provisionWorkerSlot` runs
  `ensureSlot` (T1) and writes the credential the way the pre-slot Claude worker
  home was provisioned — for `claude`, the setup-token → `.oauth_token` (0600) plus
  a seeded `.claude.json`: the identity email (the read-side join then completes
  the account/org uuids from the registry row) and `hasCompletedOnboarding`, because
  a worker has no human to answer Claude Code's first-run theme picker. A durable
  claude slot missing either (provisioned before onboarding was seeded) is
  provisioned again on the next tick; an API-key harness gets a `durable` slot with
  **no** file (the key is injected at spawn); a token-less harness (`kimi`,
  `antigravity`) gets a `per-device` slot and no push. A row whose key has not
  reached the box is reported `durable key not synced yet` and retried next tick.
  Slot reconciliation runs only on a non-headed device, and it runs **first** in
  the tick, before the shared-state git exchange: it reads only local state, so a
  `git rebase timed out` on that tick never postpones it. (Before this, legacy
  rows were skipped on the assumption that "a legacy worker resolves its token at
  spawn" — true only for `agents run claude#<name>`, never for the interactive
  picker, which enumerates slots and version homes and therefore showed the 8
  registered accounts as logged out on a worker whose `auth` bundle held all 8
  tokens.)
- **Invariant 1 (transport, retain nothing).** The daemon moves a durable key over
  the existing encrypted SSH bundle push (the process client's
  `pushBundleToHostAsync`, `lib/secrets-client.ts`) and retains
  nothing beyond its own store; slot materialization writes only locally on the box
  where the key landed. A native OAuth/session file is never transported
  (`fleet/auth-sync.ts` `isCredentialSafeToPropagate` stays `false`).

## One account namespace: provider credentials and named native logins (RUSH-2527)

An **account** is one authorization identity, and it comes in two kinds that share
a single name namespace (`meta.accounts`):

- **Provider credential accounts** — a durable API key, setup token, or bearer
  token the CLI stores as a policy-`never` secrets bundle (invariant 4 above).
  Created with `agents accounts add`; portable, so `accounts sync` copies it.
- **Native account records** — a durable *name* for a harness's own signed-in
  login. `agents accounts add <harness> [name]` drives the native login in a
  fresh per-account slot (a HOME-shaped dir under `.history/accounts/<harness>/<id>/`,
  not a second installation) and records **metadata only** — a stable
  id, the harness, the identity key, and a friendly label — in `meta.accounts.native`.
  The harness-owned OAuth/session credential is **never copied**, so a native
  account cannot be `sync`ed. A native lookup reads only `meta`, never the provider
  bundle store or the keychain.

**Only a safely-identifiable native login is nameable/attachable.**
`account-capabilities.ts` is the canonical table, and it is deliberately
conservative — a `NativeAccount` stores no device-id discriminator, so a login
whose identity can't be proven unique across synced metadata is marked
**unsupported** rather than falsely supported:

| Harness | Native account naming |
|---|---|
| Claude, Codex, Grok, Cursor | **supported** — version-scoped, strong account key; `accounts add <harness> [name]` drives the login |
| Kimi | **supported** for naming (version-scoped, stable opaque id, no email), but `add` cannot drive its login (in-TUI `/login` only) — it logs in per box (`agents fleet login kimi`) |
| Muse | **conditional** — version-scoped, email-only; nameable only when the login exposes an email |
| Antigravity, Droid, OpenCode | **unsupported** — device-scoped but opaque/singleton; the identity can't be proven distinct across devices (Droid exposes no account key; Antigravity/OpenCode can alias two credentials as one) |
| everything else | **unsupported** / discovery-only |

`accounts add`/`login` (and the hidden `name`/`attach`) refuse an unsupported
harness with a named
reason (for example, `kimi has no finite login command — kimi has no portable
credential — it logs in per box (agents fleet login kimi).`). That gate
applies only to native naming/attachment. Provider `accounts add <name>
--provider <p>` stays unrestricted.

The commands read like the task, object first:

| Command | Behavior |
|---|---|
| `agents accounts list [<harness>] [--fleet] [--json]` | One row per named harness account — a native login or a provider credential that authenticates that harness — with STATE (`live`/`expired`/`revoked`/`rate_limited`/`unverified`/`missing`/`per-device` for native; `ready`/`missing` for a provider credential) Honesty: `rate_limited` is the usage snapshot (`deriveUsageStatusFromSnapshot`/`applyUsageHonesty`), never a probe 429 — a throttled probe keeps the previous verdict within 20 min, otherwise `unverified` with detail `probe throttled (HTTP 429)`, WHERE (`this box` when only this device reports; otherwise `on N boxes` when every provisioned device is usable, `on N of M boxes` when some are not), USAGE (bar + percent when verified, `*` stale), and FIX (the exact repair command; empty when there is none). A harness filter emits only that harness's group; empty groups are omitted. A provider credential no harness uses is listed under Other accounts. `--json` is the version 2 account schema (see below). `--fleet` pivots native accounts as rows and devices as columns, and names devices whose daemon-state carries no account verdicts (older release) rather than leaving a blank column. Reserved credential stores are not shown here. |
| `agents view <harness>` | Uses the same account-row renderer as `accounts list`, so state, device coverage, usage, and repair guidance cannot disagree. Use the installation diagnostics view only for release/home details. |
| `agents accounts add <harness> [name]` | The onboarding verb: one managed install (reused) + a fresh credential SLOT (HOME-shaped, no binary) + native login in the slot + fleet-wide row + durable worker credential (claude: `setup-token` driven in the slot; codex/grok/cursor/opencode: `--api-key` or a prompt; codex `--per-device` for a ChatGPT-plan seat; kimi/antigravity log in per box). **Headed devices only** — on a worker it refuses before any slot, install, or browser; workers are provisioned automatically from the minted credential. Idempotent: an already-registered name or identity points at `accounts login`. |
| `agents accounts add <name> --provider <p> --auth <t>` | Provider form (first arg NOT a harness id): store a durable provider credential account. Mixing the two forms (harness id + `--provider`) fails loud as ambiguous. |
| `agents accounts login <harness>#<name>` | Re-auth into the SAME slot (never a new home); fails closed on a different identity; re-mints + re-syncs the worker credential. On a per-device harness any box may run it — that is how that box logs in. |
| `agents accounts default <harness> [name]` | The one write path for the fleet-wide per-harness default (picker with no name, `--json` to list or report). The hidden `set-default`/`switch` share it. |
| `agents accounts view <account>` (alias `inspect`) | Show one account — kind, custody, and its attachments. Target may be `<harness>#<name>` when the same name exists for several harnesses; an ambiguous bare name is refused, never guessed. |
| `agents accounts rename <old> <new>` / `remove <name>` | Rename or remove either kind. Target may be `<harness>#<name>` when the same name exists for several harnesses; an ambiguous bare name is refused, never guessed. `remove` refuses while a binding, a per-harness default, or a harness profile still references the account |
| `agents accounts sync <account> <device>` | Copy a provider account bundle to a worker (native records have no bytes to copy) |
| hidden: `connect`, `name`, `label`, `mint`, `attach`, `detach`, `switch`, `set-default` | Still execute for one release and print the pointer to their replacement (`add` / `login` / `default` / `run <harness>#<name>`). |

`--json` (`agents accounts --json`, `accounts list --json`) is the version 2
account schema: `{ version: 2, accounts: AccountListEntryJson[] }`. Each entry
keeps a scalar `harness` (`AgentId | null`) plus `kind`, `id`, `name`,
`identityLabel`, `isDefault`, `provisioning`, `verdict`, `checkedAt`, `devices`,
`usage`, and `fix`. A provider credential that authenticates several harnesses
(an OpenRouter key for claude, codex, and opencode) is **one JSON entry per
harness** it authenticates — same `id`, `kind: "provider"`, each with its own
`harness` — so a consumer filtering `harness === "codex"` sees it. A credential
no harness authenticates is one `harness: null` entry. A harness filter
(`accounts list claude --json`) emits only that harness's entry. The rest of the
v2 shape is unchanged.

Account registration is uncapped. (The plan-tier cap that briefly shipped in
1.22.42-1.22.43 read the billing tier from the Rush/Prix backend; it was removed
with the rest of that coupling pending the Phoenix-backed account layer,
RUSH-2581.)

`default` / `clear-default` are the per-harness-default spelling and are
consulted after an exact `agent@version` or device-scoped binding.
`agents accounts default <harness>` (optional `[name]`, `--json`) is the one
write path (picker with no name): it lists named accounts with usage / headroom /
signed-out state and writes the default. The hidden `set-default` and `switch`
verbs share that path. No extra persistent state.
`resolveAccountSelection` orders resolution: explicit `--account` → exact target
binding → device-scoped binding → per-harness default. Runtime injection of the
resolved account (live-fingerprint validation for native, env for provider) and
the fleet inventory labels are wired by the runtime/fleet-auth track; fleet
credential transport is owned by the credential-transport track.

## What is "held" and shared (the ingredients)

| ingredient | where | shared across fleet? | why safe |
|---|---|---|---|
| Interactive OAuth login | the box that minted it, in that account's slot / the harness's own keychain item | **No — never touched by us** | rotates/revokes on cross-use; leaving it alone is the fix |
| Setup-token / API key (durable worker credential) | reserved store `__<harness>__`, key `<ENV>_<accountId>` (legacy `auth` alias for `__claude__`) | **Yes — daemon, per key, workers only** | non-rotating, revoke-only; reuse never invalidates another holder |
| Named provider account (API key / setup-token / bearer) | a user-named `agents secrets` bundle, policy `never` | **Yes — explicit `accounts sync`** | same safety property; a different namespace from reserved stores |
| daemon / CLI | — | — | hold nothing |

Nothing rotating is ever copied. A native account's worker credential crosses
to workers through the daemon's per-key reserved-store push; a provider account
crosses only when the user runs `agents accounts sync <name> --device <device>`.

## How each surface changes

- **`agents fleet apply`** does not copy login files. `FLEET_AUTH_FILES` is inventory
  metadata only; fleet apply has no native-login materialization path. Per
  agent per box `apply` surfaces: "logged in" / "log in on this box" (interactive or
  `agents fleet login`) / "add or sync a provider account (`agents accounts add` /
  `sync`)" — driven by whether the box has its own login or a declared account
  bundle, never by agent identity.
- **`agents fleet login`** (per-box device-code over SSH, writes the credential on
  the box, never transports it) stays as the per-machine login path. Onboarding a
  new device syncs the needed provider account bundle (`agents accounts sync`)
  instead of copying logins.
- **`ag view` / usage** (`usage.ts`) reads the shared per-account usage cache.
  Interactive Claude sessions feed that cache through Claude Code's native
  status-line payload; explicit network probes read the setup-token from its
  named account bundle. Neither path reads the harness's ACL-bound keychain login.
  No no-ACL cache of the interactive token is needed because the interactive
  token is never read.
  A headed daemon publishes those non-secret rows to its per-device
  `daemon-state.json` in the fleet-synced user repo. The daemon automatically
  commits only its owned file and runs a serialized, 45-second-bounded Git
  exchange; workers consume the delivered local mirror newest-wins, with no
  per-tick device-to-device SSH mesh.
  Claude's human row ends with one unlabeled last-active timestamp. Auth-health
  remains available in `--json` for machine consumers; it is not rendered as a
  second timestamp beside usage because that probe age is neither activity age
  nor usage-capture age.
  When Anthropic returns 403 `user:profile` on that token, the probe sets
  `reason: 'usage_scope'` so auth-health stays `unverified` (not `revoked`) and
  the row shows `usage unavailable (headless)` (RUSH-2392).
- **Routines / `agents run`** authenticate via the box's own login (interactive) or
  the setup-token the user placed; the daemon injects nothing.

## Per-harness credential map (evidence-based, verified)

macOS keychain-ACL (→ Touch ID when we read it) is **claude + antigravity only**
(`auth-sync.ts:47`). Every other harness reads its login from a plain file and
**never triggers Touch ID** (`usage.ts` per-provider reads). Setup-token env vars
are already mapped in `profiles.ts:324-329` for BYOK profiles.

| harness | macOS login store | setup-token / API-key env var | wired in agents-cli? |
|---|---|---|---|
| claude | **keychain-ACL** | `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`, 1yr) / `ANTHROPIC_API_KEY` | daemon-inject removed (PR1); `ANTHROPIC_AUTH_TOKEN` via profiles; Linux shim reads `.oauth_token` |
| codex | file (`.codex/auth.json`) | `OPENAI_API_KEY` | yes (`profiles.ts:326`) |
| gemini | file | `GEMINI_API_KEY` | yes (`profiles.ts:327`) |
| grok | file | `XAI_API_KEY` | yes (`profiles.ts:328`) |
| opencode | file | `OPENCODE_API_KEY` | yes (`profiles.ts:329`) |
| droid | file (locally-decrypted, no keychain) | `FACTORY_API_KEY` (`fk-…`) | **no** — unwired anywhere |
| kimi | file (`.kimi-code/…`) | **none** — Kimi reads only `config.toml`, not env | **no** (not possible via env) |
| antigravity | **keychain-ACL** | `ANTIGRAVITY_API_KEY` (agents-cli claims; upstream issue #78 says unsupported — unresolved) | preset only |

Resolved open items:
- **Touch ID is Claude-only in practice.** Only claude routes usage/probe through
  the ACL keychain (`usage.ts:1305-1306`, `loadClaudeOauth`→`getKeychainToken`).
  Antigravity is keychain-bound but has NO usage read, so it doesn't hit the `ag
  view` storm. Droid & Kimi are already file-based → **no Touch ID to fix**.
- **Kimi has no env-var auth** (config.toml only) — a real limitation; its
  file-based OAuth login stays per-box, no shareable token.
- **Droid**: `FACTORY_API_KEY` is real but agents-cli wires nothing — a gap to
  close if we want droid selectable as an `agents accounts` provider.

## Which credential a run injects — keyed on DEVICE ROLE, not run mode (PHNX-3502)

The map above says which credential *types* exist. This says which one a given
`agents run` actually authenticates with — the rule that governs
`buildExecEnv` → the harness adapter's `applyExecConfigEnv`
([`harness/adapters/claude.ts`](../src/lib/harness/adapters/claude.ts)).

**A harness has two credentials, and a box carries at most one of them:**

- **Native interactive login** (`.claude/.credentials.json`, scope `user:profile`,
  behind Claude Code's Touch-ID/keychain-ACL item). A **headed** box holds this —
  `personal`/`desktop` (`isHeadedDeviceRole`, `device-config.ts`), the seat a human
  actually logged in at (e.g. `zion`). It is untouchable per the invariants above.
- **Setup-token** (the `auth` bundle → `.oauth_token` → `CLAUDE_CODE_OAUTH_TOKEN`,
  scope `user:inference`). This is the **worker** credential — a non-interactive,
  non-rotating, 1-year OAuth token for runs with **no human present**. A worker
  device carries this and no native login.

**The routing rule is one predicate — `isHeadedDeviceRole(ctx.deviceRole)`, NOT
`ctx.interactive`:**

| run | worker device | headed (`personal`/`desktop`) |
|---|---|---|
| interactive TUI | **inject setup-token** | defer to native login |
| headless one-shot | inject setup-token | defer to native login |

"Interactive" means "this opens a TUI," **not** "a human with a keychain login is
present." An interactive run on a worker is a *remotely dispatched* TUI
(`agents run claude --interactive --device <worker>`), not someone sitting at that
box — so it authenticates with the same setup-token headless runs use. Symmetrically,
a *headless* one-shot on the user's own `personal` laptop (`agents run claude "fix
the bug"`) MUST use that box's native login, never the setup-token (RUSH-2395 — gating
on `ctx.interactive` alone hijacked the laptop's login onto the setup-token).

**Two bugs this rule closes, one on each side of the diagonal:**

- **PHNX-3502** — the old `if (ctx.interactive || headedDevice)` deferred *any*
  interactive run to the native login. On a keychain-less worker there is no
  `.credentials.json` to defer to **and** the setup-token it does hold was never
  injected, so `agents run claude --interactive --device <worker>` landed on Claude
  Code's login/theme-picker screen with a perfectly good credential sitting unused.
- **RUSH-2395** — the mirror image: keying on run mode sent a *headless* laptop run
  onto the setup-token and took the human's hand-driven sessions off their login.

Keying on device role — not run mode — is the single fix for both.

**Account → slot at spawn (PHNX-3940 T5).** The role rule still chooses *which
kind* of credential is injected. The slot chooses *whose* credential. When a run
resolves a native account (`#name`, `--account`, a binding, or the per-harness
default), `execHome` is that account's slot on this device (`readSlots`). The
binary still comes from the one managed install. Two slots in one install never
share a config-dir env: adapters pin `CLAUDE_CONFIG_DIR` / `CODEX_HOME` /
`GROK_HOME` / `OPENCODE_CONFIG_DIR` / XDG at the slot, and the strip list
removes every other pin so a parent agent's dir cannot leak. The spawn also
stamps the slot in `AGENTS_EXEC_HOME` so the shim's own config-dir pin (bare
shim and `<agent>@<version>` alias; claude, grok, opencode, kimi, muse, copilot
— `slotAwareConfigEnvBash`) yields to it. Every one of those shims used to
re-export the version home over the slot, so a worker run picked as one account
onboarded and kept its history in the shared version home; the shim consumes
the marker before `exec`, so a nested launch never inherits its parent's slot.
Codex (a caller-provided `CODEX_HOME` wins) and cursor (its HOME swap yields to
a spawner-chosen HOME) already behaved this way. A headed device
still authenticates only with the native login in that slot; a worker still
injects only the durable credential for that account. Native OAuth files never
leave the device that minted them.

`agents run claude#work --device worker-1` forwards `#work` on the remote argv;
the worker resolves *its* slot (or provisions one from the reserved store) and
never receives the laptop's `.credentials.json`.

### Establishing the worker credential (non-interactive login)

The setup-token is not a file you hand-copy; a worker gets one because the laptop
**minted** it — the worker-credential step of `agents accounts add claude <name>`
(re-run by `agents accounts login claude#<name>`; the hidden `agents accounts mint`
/ `agents auth mint` still work and print the pointer) drives `claude setup-token` through its
device-code OAuth flow and seeds the result as a named account (`driveSetupTokenMint`, [`auth-mint.ts`](../src/lib/auth-mint.ts), PHNX-2364).
The *authorize* step still needs a browser pointed at the right account: the fleet's
logins accumulate in **browser profiles** (`agents browser profiles logins`), so
minting for a specific account means authorizing in the profile signed into that
account — the profile-switch friction is real and lives here, at mint time, not at
run time. Once minted and synced (`agents accounts sync <name> --device <worker>`),
every run on that worker authenticates from it with zero Touch ID and no human.

## The Touch ID fix (concrete)

Only the **token-acquisition step** changes — no endpoint/header change (the usage
endpoint takes any `sk-ant-oat01-` bearer, `usage.ts:624,957`):

- In `loadClaudeOauth` (and its callers `probeClaudeStatus` / `getClaudeUsageInfo`,
  `usage.ts:604,938`), **resolve `CLAUDE_CODE_OAUTH_TOKEN` from the named account
  bundle (or env) BEFORE the keychain-ACL read** (`usage.ts:1348-1353`). If a
  setup-token is present → use it as the bearer and skip `getKeychainToken`
  entirely → no ACL-gated `/usr/bin/security` call → no Touch ID.
- Same for the daemon's every-3-min `probeLocalFleetAuth` (`auth-health.ts:391-410`)
  — the real storm source — so its warm loop reads the account bundle's
  setup-token, never the ACL-bound keychain login.
- The setup-token lives in a bundle written by `agents accounts add`, which
  always sets secrets policy `never` — a no-biometry-ACL item (keychain on
  macOS, the platform default elsewhere), never the harness's own ACL'd login.
  Populated by the user OR **self-minted** by the agent (`claude setup-token`
  via pty + computer-use).

## Migration (priority order — Touch ID first, it's the live pain)

1. Daemon holds nothing (done, #1583).
2. **Claude usage/probe read the account bundle's setup-token, not the ACL'd
   keychain login** → kills the Touch ID storm. Self-mint + store the setup-token
   per account. **Enforcement landed:** `loadClaudeOauth`'s `accessTokenCache`
   path (`usage.ts`) now returns `null` when no setup-token is provisioned
   instead of falling through to the interactive keychain / `.credentials.json`
   — so the daemon's usage (~60s) and auth-health (~3min) warms can never read
   or transmit the interactive OAuth login (the transitional fallback + its
   no-ACL cache are removed). An unprovisioned account reads as `unconfigured`
   for the probe; a normal interactive response can still populate its usage
   snapshot through the native status line. Rush Cloud dispatch does not read a Claude credential at all
   (SING-1b: the account manifest is version + email only). The leftover
   `readClaudeCredentialsBlob` helper that still read Keychain / `.credentials.json`
   — the #1767 shape — is deleted (RUSH-2359). `--lease` SING-1b detection reads
   the wrapped rotating blob itself and rejects anything that is not
   `{ claudeAiOauth.accessToken }`.
3. `apply` stops copying rotating login files (Gap B).
4. **Shipped (RUSH-2470):** `agents accounts add <name>` creates a named,
   policy-`never` bundle per account; `agents accounts sync <name> --device
   <device>` copies it explicitly to a worker device (encrypted file backend on
   Linux, Credential Manager on Windows). Each provider **account** the user
   creates is independently named and synced; a harness's durable worker
   credential instead lands in the reserved per-harness store (`__<harness>__`,
   with `auth` the legacy claude alias — PHNX-3940).
5. Fleet upgrade + verify **zero Touch ID** on a real macOS box (the proof).
