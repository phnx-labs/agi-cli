<!-- guide -->
# Secrets: trust boundaries & what the agent sees (design)

> **Enforcement moved (PHNX-3989 Track D).** The concept this document
> describes — inject into the child process, never into the agent, by
> construction — still holds and is still the right mental model. What
> changed is WHO enforces it: the storage and materialization boundaries
> below were enforced by the in-repo secrets engine (`lib/secrets/*`), which
> is deleted; the standalone [`@phnx-labs/secrets-cli`](https://github.com/phnx-labs/secrets-cli)
> engine enforces both now (its own `MAT-1`/`EXEC-1`), reached only through
> the bounded process client (`secrets-client.ts`). The file:line citations
> below describing the old engine's implementation are historical. The
> `secrets.md#security-model` section this doc cross-references was folded
> into the rewritten [secrets.md](secrets.md), which now scopes to what
> agents-cli itself still owns.

> Status: **accepted** (mental model still current; enforcement moved, see
> above) · Related: [secrets.md](secrets.md) (reference),
> [secrets-agent-process-model.md](secrets-agent-process-model.md) (broker process model, superseded)

A design record for the **one question every operator eventually asks**: when an
AI coding agent runs a release (or any task) with `agents secrets`, *does the agent
ever see the plaintext key?* The answer is "only if a command materializes it" —
and this doc pins down exactly which commands do, why, and where the boundary is
enforced. It complements the reference doc's [Security model](secrets.md#security-model)
(which covers the *keychain ACL* threat model) by tracing the **plaintext data-flow**
past a second boundary the ACL section doesn't name: the agent's own context and
its session transcript.

## The two boundaries

`agents secrets` defends against **on-disk plaintext** (`.env` files, shell history,
accidental commits). That is the reference doc's threat model. This doc adds the
boundary that matters when the *reader* is an agent, not a human:

1. **Storage boundary** — values live in the OS keychain, never on disk as plaintext.
   Reads are gated (Touch ID / passcode). *Covered by the reference doc.*
2. **Materialization boundary** — the line between a secret staying inside a child
   process's environment (invisible to the agent) versus being **printed to stdout**,
   where it lands in the agent's context window *and* is persisted to the session
   transcript (`.jsonl`). *This doc.*

The design intent is: **inject into the child process, never into the agent.** Every
command is on one side of boundary #2 by construction — there is no "sometimes."

## Where values live (storage boundary)

A secret value never exists as a file. On macOS every write goes through the signed
`Agents CLI.app` helper, which attaches an access control of
`[.biometryCurrentSet, .or, .devicePasscode]` via `SecAccessControlCreateWithFlags`
(`src/lib/secrets/keychain-helper.swift:33-45`) — the OS itself gates decryption with
Touch ID / passcode. Bundle *metadata* (names, var list, policy) is itself a keychain
JSON blob — nothing about a secret is on disk.

A **bundle** (`SecretsBundle`, `src/lib/secrets/bundles.ts:186`) maps env-var names
to typed refs (`REF_PATTERN`, `src/lib/secrets/index.ts:51`):

| Ref kind | Where the value is | Reachable by the agent's stdout? |
|---|---|---|
| `keychain:<key>` | keychain item, biometry-gated | only via a materializing command (below) |
| `literal` (`--value`) | inline in metadata JSON — **non-sensitive by contract** | yes (it's not a secret) |
| `env:<VAR>` | parent `process.env` at run time | only if materialized |
| `file:<path>` | a file, read at run time | only if materialized |
| `exec:<cmd>` | stdout of a command, run at resolve time (needs `allow_exec`) | only if materialized |

## The two data-flow paths

### Path A — injection (the agent never sees the value)

This is the release path. `agents secrets exec <bundle> -- <cmd>` and
`agents run --secrets <bundle>` resolve the bundle in memory and hand it to the child
as **environment**, not output. The env is built by `buildSecretsExecEnv`
(`src/lib/secrets/exec` → `src/commands/secrets.ts:353-360`):

```ts
export function buildSecretsExecEnv(parentEnv, secretEnv) {
  const env = { ...sanitizeProcessEnv(parentEnv), ...secretEnv };
  delete env.AGENTS_SECRETS_PASSPHRASE;   // the master key must not reach the child
  return env;
}
```

The resolved values go straight into the spawned process's `env`. They are **never
written to stdout**, so they never enter the agent's context or the transcript. The
agent sees only whatever the *child* chooses to print (`npm publish` → `+ pkg@1.2.3`).

```
  keychain ──(one Touch ID / broker)──▶ resolve in memory ──▶ child process env
                                                                    │
                                              agent sees: child's stdout only
                                              agent does NOT see: the values
```

`buildSecretsExecEnv` also **strips `AGENTS_SECRETS_PASSPHRASE`** — the file-store
master key is used to decrypt, then removed before the child (and thus the agent)
runs, so the one key that unlocks everything never reaches the executed command.

### Path B — materialization (the value is printed → agent + transcript)

Two commands exist to put plaintext *on stdout* on purpose, and both are gated to
a **human at a real interactive terminal, outside any agent session** (RUSH-2774):

- `agents secrets view <bundle> --reveal` — unmasks values.
- `agents secrets get <item>` — prints one raw keychain item
  (`src/commands/secrets.ts:1648`).

Both refuse outright — before resolving anything — when `isAgentInvocationContext()`
sees an agent marker (`AGENTS_RUNTIME`, `AGENT_SESSION_ID`, `AGENTS_SESSION_ID`,
`CLAUDECODE`) or when there is no TTY. `view --reveal` additionally has no
non-interactive escape hatch left: the old `--plaintext` flag that allowed a
piped/non-TTY reveal is gone. And the bundle-key form, `agents secrets get
<bundle> <KEY>`, is removed unconditionally — it always refuses and names
`agents secrets exec <bundle> -- printenv <KEY>` instead. `export`'s old
shell-eval mode (`eval "$(agents secrets export <bundle> --plaintext)"`) is
removed the same way: `export` without a destination flag (`--device` /
`--to-1password` / `--to-file`) refuses and names `secrets exec` / `view
--reveal`.

When a human runs `view --reveal` or `get <item>` at a terminal, the plaintext is
legitimate one-off output. When anything tries to run either from *inside* an
agent session, the refusal is the point: an agent's shell tool output lands in
the model's context **and** is written verbatim to the session `.jsonl`, so
letting either command through would cross boundary #2 by construction. The one
surviving stdout emitter beyond those two is a machine-to-machine transport, not
a human- or agent-facing command: the SSH remote-resolve path
(`export <bundle> --plaintext --format json`) that `remoteResolveEnv` /
`verifyRemoteKeychainPush` build internally, gated on the hidden
`AGENTS_SECRETS_REMOTE_TRANSPORT=1` marker AND the same agent-context refusal —
nobody types this form by hand.

## Seen-vs-not-seen, by command

| Command | Plaintext destination | Agent sees it? | In transcript? |
|---|---|:--:|:--:|
| `agents secrets exec <b> -- <cmd>` | child process env | **No** | **No** |
| `agents run --secrets <b>` | agent run's env | **No** | **No** |
| `agents secrets list` / `view <b>` | masked (`••••`) | No (masked) | No |
| `agents secrets view <b> --reveal` | **stdout** (human terminal only; refuses in an agent session) | **No** — refuses | **No** — refuses |
| `agents secrets get <item>` | **stdout** (ungated scripting primitive — a single raw item, not a bundle) | Yes, if the agent runs it | Yes |
| `agents secrets export <b> --plaintext` (shell-eval mode) | *removed* (RUSH-2774) | n/a | n/a |
| `agents secrets get <bundle> <KEY>` (bundle-key form) | *removed* (RUSH-2774) | n/a | n/a |

**Rule of thumb for agent-driven flows:** use `exec` / `--secrets`. `view
--reveal` now refuses to run at all inside an agent session, so a
key can no longer enter an agent's transcript through either of them — the
former ungated printers (`export --plaintext`, `get <bundle> <KEY>`) are gone
outright.

## The transcript corollary

Because Path B output is persisted to the session `.jsonl`, a materialized secret is
not ephemeral — it is durable in the transcript until that file is deleted. This is
why the operating rules treat transcripts as confidential (secret-gist attachment on
private repos; **never** pasted into a public repo, PR, or tracker). A key that only
ever traveled Path A leaves no transcript residue; a key that traveled Path B does.
The materialization boundary and the "transcripts are confidential" rule are the same
boundary seen from two sides.

## How the boundary is enforced (not just documented)

- **Agent-context refusal on every materializing command.** `isAgentInvocationContext()`
  (`src/lib/secrets/headless.ts`) checks for `AGENTS_RUNTIME`, `AGENT_SESSION_ID`,
  `AGENTS_SESSION_ID`, or `CLAUDECODE` — present regardless of TTY, since an agent
  running inside tmux still has one. `view --reveal` consults
  it before resolving anything and refuse outright when it is set. This is what
  makes Path B a human-only path rather than an advisory one.
- **Headless no-prompt.** Where nobody could answer a sheet — an unattended launch
  (`AGENTS_RUNTIME=headless`: routines, fleet workers) or a process outside the GUI
  login session (SSH, launchd, CI) — resolution takes the `agentOnly` /
  `isHeadlessSecretsContext()` path (secrets-cli `src/lib/secrets/headless.ts`,
  0.1.4+). It reads from the broker or fails loudly; it does not prompt behind the
  user's back. Any other launch in a GUI session — an agent the user is driving
  (`AGENTS_RUNTIME=terminal` or `teams`, or a harness tool shell) — is not
  headless: its read raises one Touch ID sheet on the user's screen,
  and the hold policy keeps the bundle silent afterwards.
- **The broker holds resolved env in memory only.** `agents secrets unlock` caches the
  resolved bundle behind a Unix socket in a `0700` directory, with the socket file
  itself chmod'd `0600` (`src/lib/secrets/agent.ts:145`, `:445`; `session-store.ts`) so
  Path A stays promptless across concurrent runs — still no
  stdout exposure. See [secrets-agent-process-model.md](secrets-agent-process-model.md).
- **Auto-mode classifiers.** In hosted agent harnesses, an attempt to scan bundles or
  materialize a value (`secrets show`, bulk `--reveal`) is challenged as credential
  exploration — a runtime backstop on top of this design, not a substitute for it.

## What this boundary does NOT do

Inherited from the reference doc's [Security model](secrets.md#security-model),
restated here because they bound *this* boundary too:

- **Path A env is inherited by the whole subprocess tree.** A value injected into a
  child is visible to everything that child spawns (npm lifecycle scripts, shells).
  Only bundle credentials you're willing to expose to the agent's full subprocess tree.
- **`never`-policy bundles have no gate at all.** A `never` bundle is stored *without*
  the biometry ACL (`set-no-acl` in `keychain-helper.swift`) and reads fully silently.
  It is the on-disk-plaintext-equivalent downgrade the rest of the model avoids —
  never put a high-value secret in one.
- **Same-user trust is conceded.** The keychain ACL is user-presence, not code-identity;
  any same-user process that pops the prompt can read. This doc is about not
  *gratuitously* widening that to "and it's in the agent's transcript too."

## Decision

Keep the two paths **structurally separate and named**: Path A (`exec` / `--secrets`)
is the default for every agent-driven flow and never materializes; Path B
(`view --reveal`, plus the deliberately-ungated raw-item `get <item>` that fleet shell hooks capture into their own variables) exists for deliberate use, and
that restriction is now **enforced, not just advisory** — both refuse outright
under an agent invocation context, and the two commands that used to materialize
with no such gate (`export --plaintext` shell-eval, `get <bundle> <KEY>`) are
removed outright (RUSH-2774). The design guarantee is that *reaching for a normal
secrets-injecting command cannot accidentally print a secret into an agent's
context* — materialization is no longer an opt-in an agent could reach for at
all, only a refusal-gated command a human can run at a real terminal.

## See also

- [secrets.md](secrets.md) — full reference (commands, backends, recipes, ACL threat model)
- [secrets-agent-process-model.md](secrets-agent-process-model.md) — where the broker lives as a process
