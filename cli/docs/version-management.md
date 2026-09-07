<!-- guide -->
# Installations, Accounts, and Updates

Accounts are the normal interface; installation labels and release numbers are
advanced diagnostics. Each harness has **one managed installation** (label
`main`): a stable label and home plus a replaceable vendor `releaseVersion` in
`installation.json`. Account credential slots (PHNX-3940) are HOME-shaped
directories under `~/.agents/.history/accounts/**` — they are not installations
and never appear in any installation listing. A second installation of the same
harness exists only as an expert `--isolated` copy.

> This page covers versions of the *agent CLIs* agents-cli manages (Claude Code,
> Codex, etc.). To update **agents-cli itself**, run `agents upgrade` (see
> `agents upgrade --help`) -- unrelated to the mechanism below.

## Everyday use

```bash
agents add codex                          # install the one managed installation (codex@main)
agents accounts add codex work            # native sign-in in a separate account slot
agents run codex#work
agents view codex                         # account-first, duplicate identities folded
agents update codex                       # move the managed installation to the latest release
agents update codex --to 0.153.4          # pin it to a concrete release (expert)
agents update codex --check               # read-only update eligibility
agents config set updates.auto false      # global automatic-update kill switch
agents config set updates.auto true
agents config set updates.codex.auto false
```

Bare `agents add <harness>` installs the managed installation when the harness
is absent and reuses it when present — it never creates a second home.
`agents add <harness>@<release>` is the expert pin of that SAME installation:
it is exactly `agents update <harness> --to <release>`, printing so when a
managed installation already exists. Creating a second, separate home requires
`--isolated` (see [§Isolated Installs](#isolated-installs)).
`agents accounts add <harness> [name]` is the taught way to add another account
— headed devices only; on a worker it refuses before any slot, install, or
browser login, and the worker is provisioned automatically from the minted
durable credential (PHNX-3940). The old `accounts connect` spelling is a hidden
alias that prints the pointer to `add`. A revoked or missing native login still
needs its native sign-in flow (`agents accounts login <harness>#<name>`);
updating cannot repair it.

Existing homes are discovered and kept at their original paths. Account labels,
project references, defaults, bindings, and session paths remain valid. Repeated
discovery is idempotent. Duplicate identities become one normal account row, but
the hidden `--versions` diagnostic retains every installation; migration never
deletes them.

## Automatic update policy

The daemon owns a supervised harness-update service, separate from agents-cli's
own self-update. It checks periodically, not through vendor push notifications.
Managed transactional installations follow latest by default; a global or
per-harness off switch prevents automatic replacement. Unsupported or
nontransactional vendor installers are not silently treated as safely updatable.

Automatic and manual updates share the same lock, staging, binary verification,
rollback, and release-record transaction. A busy installation is deferred, never
updated by terminating its sessions. Download or verification failure leaves the
working release and its credential home intact. Vendor updaters remain disabled
inside managed npm installations so they cannot bypass that transaction.

An explicit `agents update <harness> --to <release>` pins the managed
installation. `--to latest` clears the pin. The legacy `@<label>` selector
(`agents update <harness>@<label>`) still addresses a specific installation in
pre-v2 layouts with several installations. Historical `@2.1.112` selectors
address the stable installation originally named `2.1.112`; they are not
immutable release promises.
JSON preserves its existing `versions[].version` label and adds
`versions[].releaseVersion` and an account-first `accounts` projection.

In the advanced reference below, **version** in a path or selector means the
stable installation label unless it explicitly describes an upstream release.

## Architecture

```
~/.agents/
  agents.yaml                           # Global defaults: agents.claude = "main"
  .history/versions/
    claude/
      main/                             # The ONE managed installation
        installation.json               #   frozen identity + current releaseVersion
        node_modules/.bin/claude        # Installed CLI binary
        home/
          .claude/                      # Isolated config for this installation
            commands/  -> ~/.agents/commands/   (symlink)
            skills/    -> ~/.agents/skills/     (symlink)
            CLAUDE.md  -> ~/.agents/rules/AGENTS.md (symlink)
      2.1.112/                          # An expert --isolated second copy (optional)
        node_modules/.bin/claude
        home/.claude/
        .isolated
    codex/
      main/
        ...
  .history/accounts/                    # Account credential slots (PHNX-3940) —
    claude/<accountId>/                 # HOME-shaped, NO binary, never listed as
      .claude/                          # installations
  shims/
    claude                              # Version-resolving wrapper script
    codex
  backups/
    claude/
      1709856000000/                    # Timestamped backup of original ~/.claude/
```

## Version Resolution

```
User runs: claude --help
           │
           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  ~/.agents-system/shims/claude (bash script)                               │
│                                                                     │
│  1. Walk up from $PWD looking for project agents.yaml               │
│     └─ Parse agents.claude: "2.0.70" (skips ~/.agents/agents.yaml)  │
│                                                                     │
│  2. If not found, read ~/.agents/agents.yaml (user default)         │
│     └─ Parse: agents.claude = "2.0.65"                              │
│                                                                     │
│  3. If version not installed, auto-install (project versions only)  │
│                                                                     │
│  4. exec ~/.agents-system/versions/claude/{version}/node_modules/.bin/claude │
└─────────────────────────────────────────────────────────────────────┘
```

## Agent-Spec Resolution

The shim above resolves a version from config for a *bare* `claude` launch. Every
CLI subcommand that takes an `<agent>[@<qualifier>]` argument — `view`, `inspect`,
`sync`, `run`, and the `*list*` commands — resolves that spec through one engine,
[`src/lib/agent-spec/`](../src/lib/agent-spec/). The core is **pure**: it takes a
`VersionProvider` instead of touching the filesystem (so it is unit-tested with
in-memory fixtures), and `provider.ts` binds the real one. Entry points:
`resolveAgentTargets` (multi), `resolveSingleAgentTarget` (exactly one),
`resolveVersionFilter` / `resolveListFilter` (read/list filters).

### Qualifier vocabulary

| Spec | Resolves to |
|------|-------------|
| `claude` (bare) | project pin (`agents.yaml`) → global default → the sole installed version. If more than one is installed with no default, state-changing commands error ("specify one"); `run`/`exec` pick the newest with a note. |
| `claude@2.1.187` | that stable installation label (must be installed; inspect its current release with `--versions`) |
| `claude@latest` | newest **installed** version |
| `claude@oldest` | oldest installed version |
| `claude@pinned` / `claude@default` | the configured global default (synonyms) |
| `claude@all` | every installed version (multi-target; rejected where exactly one is required) |
| `claude@all,codex@latest` | comma-separated multi-spec |

Each resolved target carries a `source` provenance tag (`project-pin`,
`global-default`, `sole-installed`, `newest-installed`, `alias-latest`/`-oldest`,
`explicit`, `none`). Exact versions are validated against `VERSION_RE` before any
filesystem or exec use.

### Two meanings of `latest`

- **Install/update** — `agents add claude@latest` or `agents update claude` →
  the newest release published on **npm** (`getLatestNpmVersion`, network),
  carried by the one managed installation.
- **Resolve** — `agents view/run/sync claude@latest` → the newest **installed**
  version (no network).

The engine's domain is installed versions only.

### Non-semver versions

Ordering is by `compareVersions` (numeric per `.`-segment), so date-style schemes
like OpenClaw's `yyyy.m.d` sort correctly. A trailing `-N` rebuild suffix
(`2026.2.19-2`) breaks same-day ties — a higher `-N` is newer. This is
deliberately **not** full semver: OpenClaw's `-N` means *newer*, the opposite of a
semver pre-release, so a semver comparator would invert it. Suffix-free versions
are unaffected.

### `@default` in read/list commands

For the read/list commands (`skills list`, `hooks list`, `rules list`, …) a bare
spec shows **all** installed versions; `@default` / `@pinned` scopes to the
**configured default version** (matching `view`).

## Installation Flow

```
agents add claude
           │
           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  ensureHarnessInstallation(agent)                                   │
│  src/lib/installations/store.ts                                     │
│                                                                     │
│  1. resolveManagedInstallation(agent) — reuse the one managed       │
│     installation (`main`, else the default, else the sole           │
│     non-isolated install) when it already exists                    │
│  2. Otherwise installVersion(agent, release, { installationLabel:   │
│     'main' }):                                                      │
│     a. Create ~/.agents/.history/versions/claude/main/              │
│     b. npm install @anthropic-ai/claude-code@<release>              │
│     c. Create home dir: versions/claude/main/home/.claude/          │
│     d. syncResourcesToVersion() - symlink central resources         │
│     e. createShim() - generate ~/.agents/shims/claude               │
│     f. createVersionedAlias() - generate shims/claude@main          │
│     g. createInstallation() - freeze identity in installation.json  │
└─────────────────────────────────────────────────────────────────────┘
```

`agents add claude@2.1.112` with the managed installation already present does
NOT take this path — it pins the existing installation (`agents update claude
--to 2.1.112`), which stages the release in a sibling directory, launches it
there, and only then swaps it in. `--isolated` is the only way `add` creates a
second home.

## Config Symlink Switching

When `agents use claude@2.0.65` runs, the user's `~/.claude/` becomes a symlink:

```
BEFORE (first use):
~/.claude/                    # Real directory with user's config
  settings.json
  commands/
  CLAUDE.md

AFTER:
~/.claude/ -> ~/.agents-system/versions/claude/2.0.65/home/.claude/   (symlink)
~/.agents-system/backups/claude/1709856000000/                        (backup)
  settings.json
  commands/
  CLAUDE.md
```

Key behaviors:
- Only `agents use` can set the global default (via `setGlobalDefault()`)
- Real directories are backed up before being replaced with symlinks
- Subsequent switches just update the symlink target (no new backups)
- Each version has isolated auth in its `home/` directory
- `agents sync <agent>` self-heals **dangling version pointers**: the global
  default, the isolated default, and the `~/.<agent>` config symlink are each
  repointed off any version that is no longer installed before the sync resolves
  a version. The default goes to the newest non-isolated installed version
  (never auto-promoting an isolated install), the symlink to the resolved default
  else the newest non-isolated installed version. A pointer already on an
  installed version, a real config directory, and isolated-only agents are left
  untouched (`healDanglingVersionPointers`, RUSH-2471).

## Uninstalling (reversing adoption)

`agents uninstall` is the reverse of `agents setup`: it completely removes
agents-cli **and restores the config directories adoption took over**, so the
machine is left as it was before agents-cli was installed.

The ordering matters — the config backups live inside `~/.agents`, so restore
runs before disposal:

```
agents uninstall
    │
    ▼
  1. Restore each adopted ~/.<agent>          (lib/uninstall.ts: planUninstall/executeUninstall)
       owned symlink? (getConfigSymlinkVersion != null)
         → newest backup exists  → move backups/<agent>/<ts> back to ~/.<agent>
         → else (importAgent)     → copy the symlink target (version home) back
       real, un-adopted dir?      → LEFT UNTOUCHED
  2. Restore owned home files      (~/.claude.json, ...)
  3. releaseAdoptedLauncher()      restore native binaries on PATH
  4. stripShimPathLines()          remove the shim dir from every shell rc file
  5. dispose ~/.agents             move aside to ~/.agents.removed-<ts> (default)
                                    or hard-delete with --purge
  6. print `npm uninstall -g @phnx-labs/agents-cli`   (a CLI can't delete its own binary)
```

Guarantees:
- **A `~/.<agent>` that agents-cli never adopted is never touched.** Ownership is
  decided structurally by `getConfigSymlinkVersion()` (non-null only for a symlink
  into the versions dir) — the same check `removeVersion()` uses.
- **Recoverable by default.** `~/.agents` (installed versions, session history,
  secrets metadata) is moved to `~/.agents.removed-<timestamp>`, not deleted.
  `--purge` hard-deletes it instead.
- **`--purge` self-downgrades on error.** If any restore step fails, `--purge` is
  automatically demoted to the recoverable move-aside — a swallowed error can never
  take the user's only copy of a config with it. The command says so in its output.
- **Cross-volume safe.** Restores move data with a rename, falling back to
  copy-then-remove when `~/.agents` lives on a different filesystem than `$HOME`
  (`renameSync` would throw `EXDEV`). Resource symlinks that point back into
  `~/.agents` are stripped from a restored config so nothing dangles post-uninstall.
- **`--dry-run`** prints the full plan (what is restored, what is left untouched,
  what is removed) without changing anything.
- `uninstall` is exempt from the setup gate, so it runs even from a broken or
  half-initialized state.

Note: with `--purge`, macOS Keychain items created by `agents secrets` are not
removed (they are managed by the signed helper app); remove those with
`agents secrets` before uninstalling if you want them gone.

## Isolated Installs

`agents add <agent>@<version> --isolated` installs a fully self-contained copy
that never touches the user's existing setup. It is the escape hatch for "give me
a clean, separate <agent> without disturbing my current one." Under the
one-managed-installation model it is also the ONLY way `agents add` creates a
second home for a harness — every non-isolated form resolves to the managed
installation.

An isolated install deliberately SKIPS every adopting side effect of a normal
install:

- No global default is set or offered (`setGlobalDefault()` is never called).
- No bare `<agent>` shim is created, so nothing on `PATH` is shadowed.
- The real `~/.<agent>` is never backed up or replaced with a symlink
  (`switchConfigSymlink()` is never called).
- No settings carry-over and no resource sync — the copy starts pristine, with
  its own `home/` config and its own login.

What it DOES create is just enough to launch the copy explicitly:

```
agents add claude@2.1.112 --isolated
           │
           ▼
  installVersion()                 # same npm install into versions/claude/2.1.112/
  createVersionedAlias()           # ~/.agents-system/shims/claude@2.1.112
  markVersionIsolated()            # writes versions/claude/2.1.112/.isolated
```

Run it with an explicit version selector (PATH-independent):

```
agents run claude@2.1.112 "your prompt"
```

The `.isolated` sentinel lives at the version-dir root, so it travels to trash on
removal and is restored intact. Two consequences follow from the marker:

- `removeVersion()` never auto-promotes an isolated version to the global
  default; if the only survivors are isolated, it clears the default instead.
- `agents remove <agent>@<version> --isolated` refuses to remove anything that is
  NOT an isolated install, and its picker only lists isolated versions — so a
  normal/default install (and the real `~/.<agent>`) can never be removed by
  accident. Removal is still a soft-delete to trash, recoverable via
  `agents trash restore`.

`--isolated` cannot be combined with `--project` (an isolated copy is
global-but-separate; a project pin selects a shared install for one directory).

### The isolation boundary

Once an agent is installed **only** as isolated copies, nothing the framework does
can adopt it. Protection is derived from the `.isolated` markers already on disk —
there is no mode to set, and none to forget:

```ts
isIsolationProtected(agent)   // >=1 installed version, and every one is isolated
```

Two properties fall out of deriving it that way:

- **Per-agent.** An isolated codex constrains nothing about claude.
- **The escape hatch is inherent.** Remove the isolated copies and the agent is
  ordinary again — the state that grants protection is the state you delete to drop
  it. No `--force` flag, nothing to leave switched off.

Five primitives can carry an agent across the boundary. Each calls
`assertIsolationBoundary` before doing any work, so the refusal is a property of the
code rather than a check every future call site must remember:

| Primitive | What it would do |
|-----------|------------------|
| `setGlobalDefault` | records the default that owns the launcher and arms `shadowing` |
| `createShim` | puts a bare `<cli>` shim first on PATH |
| `switchConfigSymlink` | moves the real `~/.<agent>` aside and symlinks it into a version home |
| `switchHomeFileSymlinks` | the same for `~/.claude.json` and friends |
| `adoptShadowingLauncher` | repoints the user's own launcher symlink at our shim |

Clearing a global default is always allowed — `removeVersion` clears one as the last
non-isolated version goes away, which is the moment an agent *becomes* isolated-only.

`agents add` (without `--isolated`) and `agents import` additionally check the
boundary at the command entry point. That is not redundant: **import registers the
adopted install as a normal version first**, so by the time it reaches
`setGlobalDefault` the agent already has a non-isolated version and the primitive
gate — which reads state at call time — would let the adoption through. The boundary
has to be evaluated against the state before the command mutates it.

`doctor --adopt` is the one operation with no isolated-scoped equivalent: hijacking
PATH is its entire purpose, and isolated copies are deliberately absent from PATH.
It refuses and explains.

`src/lib/isolation-boundary.test.ts` pins the primitive list and scans `installations/shims.ts` for
any other exported function that both resolves the real config dir and mutates the
filesystem without the gate — so a sixth way in fails there rather than silently
reopening the hole.

### Bringing an existing install into the sandbox

`agents import <agent> --isolated` is the mirror of a plain import. Where the latter
*adopts* — moving `~/.<agent>` into a version home, symlinking the original away,
setting the global default and creating a shim — `--isolated` **copies**:

```
~/.codex  ──copy──▶  versions/codex/1.2.3/home/.codex     (original untouched)
```

and finalizes the way `agents add --isolated` does: versioned alias plus the
`.isolated` marker, no default, no bare shim, no config symlink.

This is the supported way in while an agent is protected — plain `import` is refused
there precisely because adoption is its purpose.

Credentials are **skipped by default and reported**, not silently included. An
isolated copy is a separate principal that signs in on its own, so copying tokens
into it should be a choice rather than a side effect of wanting your settings.
`--with-auth` opts in. Symlinks into `~/.agents` are dropped,
so the copied config does not depend on the CLI's own tree.

### The isolated default

`agents use <agent>@<isolated-version>` records which isolated copy a bare
`agents run <agent>` should reach. It is scoped to the sandbox: unlike a normal
`use` it sets no global default, creates no bare shim, and never repoints the real
`~/.<agent>` config symlink.

```json
// ~/.agents/.history/devices/pins-<machine>.json   (machine-local runtime state,
// untracked — auto-written pins in the tracked device doc caused commit churn)
{
  "agents": { "claude": "2.1.220" },          // global defaults — own the launcher, shim and config symlink
  "isolatedAgents": { "codex": "0.144.6" }    // sandbox pointers — own nothing
}
```

Both maps are machine-local for the same reason: each names a version installed on
*this* machine, so syncing either would hand another machine a pointer to a copy it
does not have.

The two maps are kept separate deliberately. An entry under `agents:` arms the
self-heal `shadowing` check and is what `getGlobalDefault` returns; an isolated
copy must never acquire that, so it is recorded somewhere `getGlobalDefault`
cannot see.

Resolution order for a bare agent name (`resolveVersion`):

```
project pin  ->  global default  ->  isolated default
```

Strictly a fallback, so nothing changes for anyone who has a global default.
Without it an isolated-only user could not reach their installs by bare name at
all — the chain ended at the global default, so `agents run codex` fell through to
whatever `codex` meant on PATH and only `agents run codex@<version>` worked.

The pointer is verified on read (installed *and* still isolated), and `removeVersion`
re-points it at the newest surviving isolated copy — or clears it — so it can never
resolve to a directory that is not there.
### Leaving an isolated install

Remove the isolated version with `agents remove <agent>@<version> --isolated`.
To adopt an existing native config into agents-cli instead, use
`agents import <agent>` after removing every isolated copy for that agent.

## Resource Syncing

`syncResourcesToVersion()` copies user/system resources into version homes and
refreshes project resources into the current workspace's dot-agent directory:

```
~/.agents/commands/foo.md          ──copy──▶  ~/.agents/.history/versions/claude/2.0.65/home/.claude/commands/foo.md
~/.agents/skills/bar/              ──copy──▶  ~/.agents/.history/versions/claude/2.0.65/home/.claude/skills/bar/
<project>/.agents/commands/foo.md  ──copy──▶  <project>/.claude/commands/foo.md
~/.agents/rules/AGENTS.md          ──copy──▶  ~/.agents/.history/versions/claude/2.0.65/home/.claude/CLAUDE.md
```

Commands are copied in the target agent's native format, with command-as-skill
conversion for agents that require it.

## Shim Process Contract

The shim is more than a version router — it's a process-model contract that
downstream consumers (VS Code extensions, IDEs, daemons) depend on. Two
guarantees:

### 1. `exec`-replacement, not `fork+exec`

The shim's final line is always:

```bash
exec "$BINARY" "$@"
```

`exec` replaces the shim process in place. The shell's direct child pid *is*
the shim pid — which, after `exec`, *is* the agent CLI. No wrapper process
remains as a parent of the agent.

```
Process tree after `claude@2.1.112` runs at the shell:

  zsh(shell_pid)
    └─ /bin/bash(shim_pid)              ← shim script starts here
         ├─ (transient) agents sync     ← project resource sync, ~100ms
         └─ (exec replaces) node claude ← same pid, now IS claude
```

### 2. Signals propagate cleanly

Because `exec` replaces rather than forks, `SIGINT` (Ctrl+C) and `SIGTERM`
from the shell hit the agent CLI directly. A second `SIGINT` exits the agent
and returns control to the shell — `pgrep -P shell_pid` returns empty, the
shell is idle at prompt.

### Why this matters

Any consumer that drives an agent terminal programmatically — Companion's VS
Code extension is the primary one today — relies on these two guarantees to
observe lifecycle transitions via `pgrep`/`ps` without hooking the terminal's
pty output. Specifically:

- **"Agent is running"** is detectable as "shell has a child pid."
- **"Agent has exited, shell is idle"** is detectable as "shell has no
  children."
- **"Which process is the agent"** is always the immediate child of the
  shell, not a deeper descendant.

### What would break the contract

| Hypothetical change | Breaks |
|---|---|
| Shim uses `$BINARY "$@"` instead of `exec $BINARY "$@"` | `pgrep -P shell_pid` keeps returning the shim pid even after the agent exits; consumers can't detect "shell idle" |
| Shim wraps the agent in `tmux`/`screen`/`agents pty` as a persistent parent | `pgrep -P shell_pid` returns the wrapper pid; the actual agent is a deeper descendant, requiring a tree-walk |
| Shim daemonizes or backgrounds the agent | Terminal's pty is not the agent's stdin; typed input goes to the wrong process |

When introducing new launch modes, preserve this contract or provide an
explicit alternative detection path for consumers.

## Migrating per-account installations to slots

Pre-v2 layouts installed a full release per connected account (`acct-*` homes
and leftover version dirs). Account model v2 keeps **one managed installation
per harness** and a HOME-shaped **slot** per identity.

```bash
agents accounts migrate --dry-run                 # print the plan; touch nothing
agents accounts migrate --apply                   # move homes, trash empties/duplicates
agents accounts migrate --dry-run --device worker-1
```

`--dry-run` is the default. `--apply` is required to write; an ordinary CLI
upgrade only prints the report. The planner:

1. Inventories every installation dir per harness (label, release, credential
   presence, identity, sessions under it, busy-ness).
2. Picks the canonical install: the current global default if it is launchable,
   else the newest launchable managed release — never a logged-out home.
3. Moves every other credential-bearing unique identity's `home/` into
   `~/.agents/.history/accounts/<harness>/<accountId>/` (registers the account
   row when the identity is unknown). The canonical install's home moves too;
   its binary stays. Duplicate identities keep the best home
   (`planDuplicatePrune`: captured identity → signed-in → newest release) and
   trash the rest. Empty logged-out homes go to trash. A home whose account
   already holds a populated slot on this device (the daemon's auth-sync
   provisions worker slots on its own) is a stale copy of a credential the slot
   now carries: a non-canonical one is trashed whole, the canonical one has its
   `home/` moved to `~/.agents/.history/trash/homes/<harness>/<label>/<stamp>`
   (recorded in the manifest under `<harness>@<label>#home`) and an empty home
   recreated beside the kept binary.
4. Repoints `agent@label` bindings at the account, the global default at the
   canonical install, and re-indexes `sessions.db` file paths (including Claude
   `projects/<cwd-key>` under the home) in the same transaction.
5. Defers any home `isInstallationLikelyActive` reports busy. Never moves it.

Everything is reversible: `agents trash restore <agent>@<label>` puts a trashed
install back, and a manifest at `~/.agents/.history/accounts/migration-<ts>.json`
maps old label → new slot. The manifest is written with the full plan and
`status: planned` before the first irreversible move, then updated after each
move or trash (so a crash lists exactly what already moved), and marked
`status: complete` last. `agent@label` bindings are rewritten per-target onto
the kept account for that identity (a duplicate's binding follows the kept
home); they are never collapsed onto one bare-agent binding. Unreadable
`installation.json`, an identity mismatch between a home and its account row,
or a regular file sitting where that account's slot directory belongs fail
loud (a populated slot directory is folded, as above). Native OAuth files
stay inside the moved home on this device and are never copied onto a worker.

## Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `ensureHarnessInstallation()` | installations/store.ts | Return the one managed installation, installing into `main` when absent |
| `resolveManagedInstallation()` | installations/store.ts | Resolve the single managed installation (`main` → default → sole non-isolated) |
| `installVersion()` | versions.ts | Install agent CLI version |
| `removeVersion()` | versions.ts | Remove installed version |
| `resolveVersion()` | store.ts | Find version from project/global config |
| `syncResourcesToVersion()` | versions.ts | Symlink resources into version home |
| `switchConfigSymlink()` | installations/shims.ts | Replace ~/.{agent} with symlink |
| `createShim()` | installations/shims.ts | Generate version-resolving wrapper |
| `setGlobalDefault()` | versions.ts | Set default in agents.yaml |
