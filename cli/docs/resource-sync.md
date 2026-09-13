<!-- guide -->
# Resource Sync

How agents-cli syncs resources (commands, skills, hooks, memory, MCP, permissions) between central storage, project workspaces, and version homes.

For the conceptual model — what a DotAgents repo is, what resources are, and how layered resolution works — see [concepts.md](concepts.md).

## Resource Types

| Resource | Source layers (resolved project > user > system) | Target Location | Sync Method |
|----------|-----------------|----------------------|-------------|
| Commands | `<project>/.agents/commands/*.md` › `~/.agents/commands/*.md` › `~/.agents-system/commands/*.md` | Project sources: `<project>/.{agent}/{commandsSubdir}/`; user/system: `<version-home>/.{agent}/{commandsSubdir}/` | Copy (command-skill conversion where required) |
| Skills | `…/.agents/skills/{name}/` (same layering) | Project sources: `<project>/.{agent}/skills/`; user/system: `<version-home>/.{agent}/skills/` | Copy |
| Hooks | `…/.agents/hooks/*.sh` (same layering) | `.{agent}/hooks/` | Symlink |
| Rules | `…/.agents/rules/AGENTS.md` (same layering) | `.{agent}/{instructionsFile}` | Symlink |
| MCP | `…/.agents/mcp/*.yaml` (same layering) | `.{agent}/settings.json` | Merge into JSON |
| Permissions | `…/.agents/permissions/groups/*.yaml` (same layering) | Agent-native config (`settings.json`, TOML, YAML, or `.rules`) | Convert + merge |
| Plugins | `…/.agents/plugins/{name}/` (same layering) | Agent-native plugin or extension directory | Copy + native manifest/registration |

`resolveResource(kind, name)` returns the single winner; `listResources(kind)` returns the union with `source: 'project' \| 'user' \| 'system'`. Same name in a higher layer overrides lower layers; otherwise everything unions.

### Extra repos

Users can register additional DotAgent repos via `agents repo add <source>`. Extras clone into `~/.agents-system/.repos/<alias>/` and ship the same layout (`skills/`, `commands/`, `hooks/`, `rules/`). They participate as an additional layer below the user repo and above the system repo. Registrations live in `meta.extraRepos` in `~/.agents/agents.yaml`.

## Memory File Mapping

Central `AGENTS.md` maps to agent-specific filenames:

```
~/.agents/rules/AGENTS.md  ───▶  ~/.claude/CLAUDE.md
                            ───▶  ~/.codex/AGENTS.md
                            ───▶  ~/.gemini/antigravity-cli/AGENTS.md
                            ───▶  ~/.cursor/.cursorrules
                            ───▶  ~/.opencode/OPENCODE.md
                            ───▶  ~/.grok/AGENTS.md
```

Symlinks in `~/.agents/rules/`:
```
AGENTS.md       # Real file (source of truth)
CLAUDE.md -> AGENTS.md
GEMINI.md -> AGENTS.md     # Legacy only; Gemini sync is hard-deprecated.
```

## Sync Detection

Sync state is derived, not stored. Three set operations over the filesystem:

```
available = contents of scoped .agents/{commands,skills,hooks,memory,mcp,permissions}
synced    = files in <version home> plus project-managed files in <project>/.{agent}/
new       = available - synced
```

```
┌──────────────────────────────┬────────────────────────────────┬─────────────────────────────────┐
│ Function                     │ Reads                          │ Returns                         │
├──────────────────────────────┼────────────────────────────────┼─────────────────────────────────┤
│ getAvailableResources()      │ ~/.agents/*/                   │ { commands: string[],           │
│                              │ (skip symlinks in memory/)     │   skills: string[],             │
│                              │                                │   hooks: string[],              │
│                              │                                │   memory: string[], ... }       │
├──────────────────────────────┼────────────────────────────────┼─────────────────────────────────┤
│ getActuallySyncedResources   │ <version home>/.{agent}/*/     │ same shape                      │
│   (agent, version)           │ (readlink each entry, match    │                                 │
│                              │  against ~/.agents/)           │                                 │
│                              │ memory: file content compare   │                                 │
├──────────────────────────────┼────────────────────────────────┼─────────────────────────────────┤
│ getNewResources(...)         │ both above                     │ available − synced (per type)   │
└──────────────────────────────┴────────────────────────────────┴─────────────────────────────────┘
```

## Sync Flow

```
agents use claude@2.0.65
           │
           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  1. getNewResources(claude, 2.0.65)                                 │
│     └─ Returns: { commands: [foo], skills: [], memory: [AGENTS] }  │
│                                                                     │
│  2. If new resources found, prompt user                             │
│     └─ "2 commands, 1 memory file available. Sync now?"            │
│                                                                     │
│  3. syncResourcesToVersion(claude, 2.0.65)                          │
│     └─ Refreshes project resources in <project>/.claude/            │
│     └─ Copies user/system resources into the version home           │
│     └─ Records sync manifests for skip-fast staleness checks        │
└─────────────────────────────────────────────────────────────────────┘
```

Project-scope commands, skills, subagents, and workflows are never copied into a
global version home. They are refreshed into the current workspace's agent
directory (`.claude/`, `.codex/`, `.cursor/`, `.opencode/`, etc.) with an
ownership manifest at `.<agent>/.agents-managed.json`. On each refresh,
agents-cli removes only the paths listed in that manifest, then copies current
project resources. If a destination exists after manifest-owned paths are
removed, it is yours: agents-cli leaves it exactly as it is and reports it once
per sync as a single grouped line (`Kept 6 of your own files in
.claude/commands: debug.md, doc-gaps.md, image-nbp.md, +3 more`) rather than one
warning per file.

The generated `.<agent>/` directory is a regenerable copy, so agents-cli keeps it
out of `git status` for you — but never by touching a tracked file. It maintains a
per-agent, marker-fenced block listing exactly the paths it manages in
**`.git/info/exclude`** (git's per-clone, uncommitted ignore file), resolved with
`git rev-parse --git-path info/exclude` so it lands correctly from a subdirectory,
a linked worktree, or a submodule. It is deliberately **not** written to the
tracked `.gitignore`: those entries are never committed upstream, so a
`.gitignore` block left every launch with a permanent `M .gitignore` that blocked
`git pull` (PHNX-3718). A repo dirtied by that earlier behavior self-heals on the
next launch — the leftover block is stripped from `.gitignore` and moved to
`info/exclude`. Outside a git repo the whole step is a no-op.

## Sync Targets: Version Selectors, Repo Scoping, and Kind Filtering

`agents sync` accepts the full [agent-spec vocabulary](version-management.md#agent-spec-resolution)
plus an optional repo scope:

```bash
agents sync claude              # the resolved default version (interactive preview in a TTY)
agents sync claude@all          # every installed Claude version
agents sync claude@all system   # scope to one DotAgent repo: system | user | project | <alias>
agents sync claude --repo user  # same, via the flag form
agents sync --json              # machine-readable umbrella result (also used by --device all)
agents sync --device all        # fan out umbrella sync across every registered device
```

A repo scope reconciles **only** that layer's resources into the target
version(s), leaving the other layers' already-synced resources untouched. Bare
`agents sync` (no agent) runs the umbrella verb — fetch remote state, then
reconcile every installed agent. `--json` emits a single JSON object on stdout
(and forces non-interactive mode); the fleet fan-out path (`--device all`)
injects `--json` on each peer so the roster can parse results.

### Per-kind selector flags

Use kind flags to restrict a sync to one or more resource types. Omitting all
kind flags syncs everything (the default).

```bash
agents sync claude --plugins            # every plugin, nothing else
agents sync claude --plugin fleet       # only the plugin named "fleet"
agents sync claude --plugin fleet,code  # two plugins, comma-separated
agents sync claude --plugin fleet --plugin code  # same, repeated flags accumulate
agents sync claude --plugins --hooks    # plugins AND hooks; all other kinds skipped
agents sync claude --skills --repo user # user-layer skills only
```

Each resource kind has a singular flag and a hidden plural alias — they are
identical in meaning:

| Singular       | Plural (hidden alias)  | Syncs                                      |
|----------------|------------------------|--------------------------------------------|
| `--plugin`     | `--plugins`            | Plugins                                    |
| `--command`    | `--commands`           | Slash commands                             |
| `--skill`      | `--skills`             | Skills                                     |
| `--hook`       | `--hooks`              | Hooks                                      |
| `--subagent`   | `--subagents`          | Subagent definitions                       |
| `--permission` | `--permissions`        | Permission allowlists                      |
| `--mcp`        | `--mcps`               | MCP server entries                         |
| `--workflow`   | `--workflows`          | Workflow definitions                       |
| `--rule`       | `--rules`              | Rules / memory file (always full recompile)|
| `--memory`     | —                      | Alias of `--rule` (boolean, no name filter)|

**Bare flag = all of that kind.** `--plugins` (no value) selects every plugin.
`--plugin fleet` narrows to the plugin named `fleet`. Comma-separated values
(`--plugin fleet,code`) or repeated flags (`--plugin fleet --plugin code`) both
accumulate into the same name list.

**Kind flags are additive.** `--plugins --hooks` selects both kinds and nothing
else. Only the kinds explicitly named are included when any kind flag is present.

**`--rule` / `--rules` / `--memory` always trigger a full memory recompile.**
The memory file is composed from all rule layers and is not individually filterable
by rule name; any of these flags selects the entire memory kind regardless of the
value passed.

### Version auto-promotion

When no version is specified and no default is pinned but multiple versions of an
agent are installed, `agents sync --agent claude` automatically targets every
installed version (`claude@all`) rather than exiting with an error.

### Per-resource sync verbs (retired)

`agents hooks sync`, `agents skills sync`, and `agents commands sync` were
deprecated stubs. They have been removed; calling them now returns commander's
unknown-command error. Use `agents sync claude --hooks` (or `--skills`,
`--commands`) instead.

### Repo sync split

Passing a DotAgent repo name as the sole argument (`agents sync system`,
`agents sync user`) git-syncs that repo. This positional form is deprecated in
favour of the explicit verb:

```bash
agents repo sync system    # preferred
agents repo sync user      # preferred
agents sync system         # deprecated — still works, prints a warning
```

## Pruning: resources removed from source disappear from version homes

A reconcile deletes as well as installs. When a **command** or **skill** is
**removed from a DotAgent repo**, `agents sync` removes its stale copy from each
version home — so a deleted resource disappears from the `/` menu the same way an
added one appears, without hand-deleting files. This runs on the repo-scope and
`@all` reconcile forms:

```bash
agents sync claude@all system   # reconcile system repo into every claude — prunes what system no longer ships
agents sync claude system       # same, one version
```

A pruned resource is reported under a `Pruned from claude@<version> (removed from
source)` block, and the `--json` payload carries a `pruned: { commands, skills }`
field.

### Declined resources — a refused write is never a clean sync

A resource agents-cli **refuses** to write (today: an MCP config whose harness
format is not implemented — see `MCP_TARGETS` `format: null`) is reported, never
swallowed. An empty synced list on its own reads as "nothing to do", which is how
a harness could report a successful sync while nothing was written at all
(RUSH-2677, RUSH-2700):

- **Human output** — a `Not written to <agent>@<version>:` block naming the
  resource and the reason. The umbrella (`agents sync`) prints a `Not written:`
  block covering every agent it reconciled.
- **`--json`** — every payload that can carry a decline sets `ok` from it and
  includes a `declined: string[]`: `mode: 'agent'`, `mode: 'agent-all'` (per
  version, under `versions[]`), and `mode: 'umbrella'`. A payload that runs no
  sync (`nothing to sync`, a **scoped** dry run, `repo-git`, `launch`) keeps
  `ok: true`. The one exception is `--dry-run` on the **umbrella** verb (bare
  `agents sync`): it has no non-mutating preview — the machine-wide sync only
  composes mutating stages (repo pull, reconcile, device sync, repair) — so it
  refuses up front with `{ ok: false, mode: 'umbrella', dryRun: true, error,
  hint, installedAgents }` and exit 1, rather than running a real sync (the
  PHNX-3923 mutate-on-dry-run bug) or faking a preview. Scope it to an agent
  (`agents sync <agent> --dry-run`) for a real preview (PHNX-3923).
- **Fleet fan-out** — `agents sync --device all` injects `--json` per peer, so a
  box that refused a write renders as `N not written` instead of `ok`.

A decline does **not** change the exit code: `agents sync` exits 0 whether or not
something was refused, on one machine and across the fleet alike. A refusal is a
partial outcome, not a failed command — the sync did everything it could — and
`ok: false` plus the rendered block are the reporting channel. Scripts that must
treat a refusal as failure should read `ok` (or `declined`) from `--json` rather
than `$?`.

### Post-reconcile verification — the success line is checked, not assumed

`agents sync` used to print `✓ sync: reconciled` (umbrella) or `Synced to
<agent>@<version>` (per-agent) the moment the writer returned — without
re-reading the home. When the drift detector and the writer disagreed about what
a version should hold, the writer silently wrote nothing while
`agents sync status` kept reporting drift, so re-running sync forever printed
success while the drift stayed put (PHNX-3186).

Every full reconcile now **verifies convergence**: after writing, it re-reads
each version it touched (`verifyVersionConverged`, the same
`diffVersionResources` engine behind `agents sync status`, resolved against the
non-project layers) and confirms the home now matches source.

- **Residual drift is named, not hidden.** Any `drifted`/`missing` resource that
  survives the reconcile is printed under a `⚠ sync did not fully reconcile —`
  block naming each `<agent>@<version>: <status> <kind> '<name>'`, and the
  umbrella one-liner reads `⚠ sync: reconcile INCOMPLETE` instead of a bare `✓`.
- **`--json`** carries a `residualDrift` array and sets `ok: false` (per-agent,
  `agent-all`, and `umbrella` modes).
- **Exit code stays 0**, exactly like a declined write — the loud reporting is
  the `ok: false` + `residualDrift` payload and the printed ⚠ block, not `$?`.
  This is deliberate: the fleet fan-out (`agents sync --device all`) treats a
  non-zero peer exit as unreachable and discards that box's JSON, so a non-zero
  exit would hide the very residual it emitted. Scripts that must treat an
  incomplete sync as failure read `ok` / `residualDrift` from `--json`. A gap
  that persists across a re-run is a real unreconcilable drift worth filing.
- **Scope.** Only a full reconcile is verified. An interactive subset-selection
  and a repo-/kind-scoped sync deliberately touch only part of the home, so the
  rest legitimately still differs and is not that run's responsibility.
- **`orphan` never counts.** Sync does not remove orphans (`agents prune`'s job),
  so an installed-with-no-source resource is not "unfinished sync".

Pruning is **manifest-bounded**, so it never over-deletes:

- **Only agents-installed resources are candidates.** The prune set is
  `(names the last full sync recorded in the manifest) − (names still in source
  across ALL layers)`, intersected with what is currently in the home. A file you
  hand-authored into `~/.claude/…` was never recorded, so it is never touched.
- **No cross-layer deletion.** The "still in source" set spans every layer, so a
  system command removed from `~/.agents/.system` while a same-named **user**
  command still exists is kept — it is still provided by a layer.
- **No manifest → no deletion (fail loud).** With no sync manifest yet (no prior
  full sync established a baseline), the reconcile prints a one-line notice and
  prunes nothing rather than guessing. A later `agents sync <agent>` full sync
  writes the baseline, after which prune works.

Every harness prunes: a native command file (Claude, Grok, Cursor), a
command-as-skill dir (Codex ≥ 0.117, Kimi), and a Goose recipe are each removed
through the same writer that installed them. Kinds synced as a wholesale rewrite
(rules, permissions) or with their own reconciliation (plugins, via
`cleanOrphanedPluginSkills`) do not need this pass. **Hooks are out of scope
here** — pruning a hook must also GC its `settings.json`/`hooks.json`
registration (a Windows-portable-path surface), tracked in **RUSH-2456**; hook
files stay reconciled by the in-write orphan sweep (`versions.ts`, gated on
`hooksToSync > 0`). See [`src/lib/staleness/prune.ts`](../src/lib/staleness/prune.ts).

## MCP Servers: Per-Agent JSON Write

MCP is the one resource that isn't symlinked. Each agent stores MCP server
lists in its own settings file with its own key shape, so sync writes them
directly into the agent's config.

```
Source: ~/.agents/mcp/*.yaml       Per-agent destinations:

┌────────────────────┐             Agy     → ~/.gemini/config/mcp_config.json (REAL home,
│ github.yaml        │                        not version-scoped — agy reads one
│                    │                        shared file for every version)
│                    │                      · key: mcpServers.<name> = {command,args,env};
│                    │                        a remote server is keyed serverUrl
│ ───────            │
│ name: github       │                      · key: mcpServers.<name> = {command,args,env}
│ transport: stdio   │             Cursor  → <home>/.cursor/mcp.json
│ command: npx ...   │                      · key: mcpServers.<name> = {command,args,env}
│ args: [...]        │             Claude  → CLI: `claude mcp add ...`
│ env: { ... }       │                      (claude owns its own settings)
└────────────────────┘             Codex   → CLI: `codex mcp add ...`
                                            · HTTP transport not supported
                                   OpenCode → <home>/.config/opencode/config.toml
                                            · key: mcp.<name> (TOML)
                                   Grok    → <home>/.grok/config.toml
                                            · key: mcp_servers.<name> (TOML)
                                   Hermes  → <home>/.hermes/config.yaml
                                            · key: mcp_servers.<name> (YAML)
```

Behavior rules, per `src/lib/mcp.ts`:

1. **Read existing, set by name, write back.** For JSON-backed agents such as
   Cursor:

   ```
   config = readExistingConfig(settings.json)   // {} when absent or empty;
                                                // THROWS when present-but-unparseable
   config.mcpServers[server.name] = { command, args, env }  // or { url }
   fs.writeFileSync(settings.json, JSON.stringify(config, null, 2))
   ```

   A config that exists but does not parse is refused, never rebuilt from `{}` —
   these files hold far more than MCP (hermes' whole `config.yaml`, openclaw's
   `openclaw.json`), so resetting one destroys everything else in it. JSONC
   configs go through the shared string-literal-aware `stripJsonComments`, so a
   URL inside a string (`"$schema": "https://opencode.ai/config.json"`) survives.

   User-owned top-level keys (theme, editor settings, etc.) are preserved
   because the merge only touches `mcpServers`.

2. **No ownership tracking.** There's no `_agents_managed` marker. If a user
   hand-edits `mcpServers.github`, the next sync silently overwrites it with
   the YAML's values.

3. **Source delete ≠ destination clean.** `removeMcpServerConfig(name)`
   (`mcp.ts:381`) only unlinks the YAML file. The matching entry in each
   agent's settings stays until manually removed.

4. **Claude and Codex delegate.** Instead of editing settings.json directly,
   agents-cli invokes `claude mcp add` / `codex mcp add` (`mcp.ts:169-186`).
   Those commands own the merge. Benefit: agent-internal validation runs.
   Cost: write failures surface as `execSync` errors, not structured results.

## Permissions: Per-Agent Format Conversion

Permissions take a different path: collected into a canonical `PermissionSet`,
then converted per agent into that agent's native format. Not a JSON merge —
a format rewrite.

```
~/.agents/permissions/groups/                     Canonical                    Per-agent native
*.yaml                                            PermissionSet

┌─────────────────────┐                       ┌──────────────────┐          Claude (JSON):
│ read-only.yaml      │                       │ allow: [         │          { permissions: {
│ ───────             │ loadPermission-       │   "Read",        │              allow: [...],
│ allow: [Read, Grep] │ ─Groups()──────────▶  │   "Grep",        │              deny:  [...]
│ deny:  [Write]      │ concat per group      │   "Bash(git *)"  │            }}
│                     │                       │ ],               │
│ git-safe.yaml       │                       │ deny: [          │          OpenCode (JSONC/JSON):
│ ───────             │                       │   "Write"        │          { "permission": {
│ allow: [Bash(git *)]│                       │ ],               │              "bash": {
│                     │                       │ additional-      │                "git *": "allow",
│ 99-deny.yaml ──────▶│ rules go to deny      │   Directories:   │                "rm *": "deny"
│ allow: [Bash(rm *)] │ (naming convention)   │   [...]          │              }}}
└─────────────────────┘                       └──────────────────┘          Codex (Starlark file):
                                                                            agents-deny.rules
                                                                            (generated text)
```

Group-to-permission-set is concatenation with one naming convention:
groups ending in `-deny` (e.g. `99-deny.yaml`) contribute to `deny` even
though their YAML lists appear under `allow`
(`permissions.ts:230-235`).

Reading back — `agents permissions list <agent>`, and the config-file import
behind `agents permissions add <path>` — goes through `PERMISSION_TARGETS` (`lib/permissions-registry.ts`), one entry
per allowlist-capable harness declaring its config path and how to project that
file onto the canonical `PermissionSet`. A completeness test pins the key set to
`capableAgents('allowlist')`, so a harness the write path handles can never be
one the read path silently reports as empty (RUSH-2676). The registry also owns
the canonical↔native tool vocabularies that the forward serializers below
import, so the two directions cannot disagree about what `fs_read` or
`developer__shell` means.

Per-agent conversion is lossy in both directions — the reverse projection
recovers a set that grants the same access, not the byte-identical rules that
were written, and each target names its own loss in a `lossyBecause` line:

- Claude's native format is closest to canonical — near 1:1 passthrough
  (`permissions.ts:362-369`).
- OpenCode 1.1.1+ maps `Bash(pattern)` rules into the `permission.bash`
  `allow`/`deny` map in `~/.config/opencode/opencode.jsonc` (or `.json`) for
  user scope, or project-root `opencode.jsonc` (or `.json`). Non-bash rules are
  dropped.
- Codex (>= 0.138.0) writes `approval_policy` and `sandbox_mode` to
  `.codex/config.toml`, plus `sandbox_workspace_write.network_access=true` when
  web tools are allowed. It also writes a platform-resolved baseline of
  `sandbox_workspace_write.writable_roots` — the regenerable toolchain caches
  (`~/.cargo`, `~/.npm`, `~/go`, `~/.cache` / `~/Library/Caches`, …) so a
  `workspace-write` run can build/test/install without escalating to
  danger-full-access; credential dirs (`~/.ssh`, `~/.aws`, `~/.config`) are
  excluded, and any roots the user set are unioned in, not clobbered
  (`permissions.ts`: `codexDefaultWritableRoots`, `mergeCodexSandboxWrite`).
  Native launches then apply the managed `agents-plan`, `agents-edit`, or
  `agents-auto` named permission profile at runtime. This keeps network
  independent from filesystem access: plan is read-only with network, while edit
  and auto add the workspace, `~/.agents`, the cache baseline above, and
  caller-supplied writable roots. Plan and edit use
  `approval_policy="on-request"` — a sandbox-denied command comes back as an
  approval prompt, which is what you want at a terminal. `--mode auto` uses
  `approval_policy="never"` over the identical sandbox, so an unattended run
  never stops on a prompt; a denied command just fails and the agent works
  around it. Only explicit `skip` bypasses approvals and sandboxing.
  Deny rules are emitted as Starlark to a generated `agents-deny.rules` file
  (`permissions.ts:38-56`).
- Goose is **not** allowlist-capable. Its `permission.yaml` gates whole tools
  (`developer__shell`, `developer__text_editor`), so several distinct canonical
  rules collapse onto one entry and cannot be read back faithfully — the
  capability is off in the registry rather than half-supported.
- OpenClaw gates at tool granularity only, so only **blanket** (whole-tool)
  rules map into `~/.openclaw/openclaw.json` `tools.alsoAllow` (allow) /
  `tools.deny` (deny): `bash → exec`, `read → read`, `write`/`edit → write`,
  `webfetch → web_fetch`, `websearch → web_search`. Sub-command/path/domain
  rules (`Bash(git:*)`, `Write(secrets/**)`, `WebFetch(domain:x)`) have no
  tool-level equivalent and are skipped. The absolute `tools.allow` list is
  never touched, and all other keys (`mcp`, `exec`, `agents`, …) are preserved.
- Hermes maps canonical Bash allow rules to `~/.hermes/config.yaml`
  `command_allowlist` and Bash deny rules to `approvals.deny`, preserving
  sibling YAML keys like `mcp_servers` and `hooks`. Hermes has command-glob
  persistence only; session-scoped `/tools` toggles are not written.
## Plugins: Synthetic Marketplace + Exec-Surface Gate

Plugins bundle skills, commands, hooks, MCP servers, settings, and permissions
under a single `.claude-plugin/plugin.json` manifest. Sync copies the bundle
into each capable version home and writes the agent-native registration:
Claude-style harnesses use the synthetic `agents-cli` marketplace, and Goose
receives the bundle under `.agents/plugins/<name>/`.

```
Source: ~/.agents/plugins/<name>/        Per-version destination:

┌──────────────────────────────┐         <version-home>/.claude/plugins/
│ .claude-plugin/plugin.json   │         ├── known_marketplaces.json
│ skills/<name>/SKILL.md       │         │     └ "agents-cli" → marketplaces/agents-cli
│ commands/*.md                │         ├── marketplaces/agents-cli/
│ hooks/hooks.json   ◄─ exec   │         │   ├── .claude-plugin/marketplace.json
│ .mcp.json          ◄─ exec   │         │   │     └ synthesized: lists every
│ bin/, scripts/     ◄─ exec   │         │   │       discovered plugin
│ settings.json      ◄─ exec   │         │   └── plugins/<name>/  ← copy
│ permissions/       ◄─ exec   │         └── settings.json
└──────────────────────────────┘               └ enabledPlugins["<name>@agents-cli"] = true
```

Behavior rules, per `src/lib/plugins.ts:379` and `src/lib/plugin-marketplace.ts`:

1. **Discovery requires a valid manifest.** `discoverPlugins()`
   (`plugins.ts:61`) scans `~/.agents/plugins/<dir>/` and only accepts entries
   with a parseable `.claude-plugin/plugin.json` containing `name` and
   `version`. Directories without the manifest are silently skipped.

2. **Copy, not symlink.** Unlike commands/skills/hooks/rules, plugins are
   copied via `copyPluginToMarketplace()` (`plugin-marketplace.ts`). The copy
   pre-expands `${user_config.*}` placeholders against the per-plugin
   `.user-config.json` so each version sees its resolved values. `${CLAUDE_PLUGIN_ROOT}`
   and `${CLAUDE_PLUGIN_DATA}` are left for Claude to expand at runtime.

   Full refresh also treats trusted plugin `skills/<name>/` directories as
   authoritative sources for top-level materialized skill homes. That reconciles
   older homes that still have a legacy `.<agent>/skills/<name>/` copy of a
   plugin-only skill, and prunes stale top-level skill dirs whose source no
   longer exists.

3. **Synthetic marketplace per version.** `syncMarketplaceManifest()` writes a
   `marketplace.json` listing every discovered plugin, and
   `registerMarketplace()` adds `agents-cli` to `known_marketplaces.json` so
   Claude treats it as installed (not a remote git source). This is what
   makes `claude plugin enable <name>@agents-cli` work without contacting a
   remote.

4. **Exec-surface gate.** Plugins shipping `hooks/`, `.mcp.json`, `bin/`,
   `scripts/`, non-permissions `settings.json`, or `permissions/` are
   *installed* (copied + marketplace registered) but *not enabled* unless the
   caller passes `allowExecSurfaces: true`. `enablePluginInSettings()`
   (`plugin-marketplace.ts:196`) short-circuits without flipping
   `enabledPlugins[<name>@agents-cli]` to `true`. The user-facing flag is
   `--allow-exec-surfaces` on both `agents plugins add` and
   `agents plugins sync`. The gate's purpose is to prevent unattended sync
   flows (e.g., `agents use claude@<v>`) from silently arming third-party
   code on every session.

5. **Capability gating.** Only agents where `supports(agent, 'plugins', version)`
   passes participate (`capableAgents('plugins')` in `src/lib/agents.ts`). Plugins
   can additionally declare `agents: [...]` in their manifest to narrow further;
   `pluginSupportsAgent()` (`plugins.ts:179`) intersects both lists.

6. **Codex command-to-skill fallback.** Codex `>= 0.117.0` dropped
   command support; for those versions, plugin `commands/*.md` are
   converted to skills prefixed with `<plugin>-<command>`
   (`plugins.ts:444-453`) so they remain reachable as `$<plugin>-<command>`.

7. **Source delete ≠ destination clean — but stale marketplace copies get
   swept.** `cleanOrphanedPluginSkills()` (`plugins.ts`) runs every sync and
   trashes a version-home marketplace-plugin install once no active source
   plugin matches its **`(marketplace, name)` pair**. Keying on the pair — not
   the plugin name alone — is what removes a *shadow*: a plugin that moved
   marketplaces (e.g. `code` shipping from the user `agents-cli` marketplace and
   later from the system `agents-system` marketplace) leaves a stale
   `agents-cli` copy that a name-only sweep kept alive because the name was still
   active via `agents-system` (PHNX-2618). A copy is trashed when its
   marketplace's **source repo is present** but no longer ships that plugin;
   when the source repo is **absent** (a project we're not in, a removed extra
   repo) the sweep falls back to the name-only test so an unrelated sync never
   trashes a plugin whose source simply is not reachable in this context. Trashed
   copies soft-delete to `~/.agents/.trash/plugins/`; `diffVersionPlugins()`
   surfaces the same orphans for `agents prune`.

## Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `getAvailableResources()` | versions.ts | List central resources |
| `getActuallySyncedResources()` | versions.ts | Check what's synced to version |
| `getNewResources()` | versions.ts | Diff available vs synced |
| `syncResourcesToVersion()` | versions.ts | Create symlinks in version home |
| `pruneRemovedResources()` | staleness/prune.ts | Remove version-home resources deleted from source (manifest-bounded) |
| `markdownToToml()` | convert.ts | Legacy command TOML conversion helper |
| `WORKFLOW_TARGETS` | workflows-registry.ts | Per-harness workflow shape (dir, layout, transform, ownership marker); `syncWorkflowToVersion` / `listWorkflowsForAgent` / `removeWorkflowFromVersion` / `workflowContentMatches` and the staleness detector are generic over it |
| `renderGooseRecipeYaml()` | workflows.ts | Render the Goose recipe YAML the `goose` target writes and the drift check compares |
| `transformWorkflowForOpenClaw()` | workflows.ts | Convert workflows into Lobster `.lobster` files |
