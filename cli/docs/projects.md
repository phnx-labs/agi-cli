<!-- guide -->
# Projects (Named Multi-Repo Projects + Progress Rollup)

A **project** names a body of work, binds it to one or more repos, and rolls live
activity up into one progress card. It is a **definition layer over the existing
`--project` convention**, not a replacement — an undefined slug resolves exactly as
before.

> Graduated out of beta — `agents projects` is always on. A leftover `beta.enabled: [projects]` entry is ignored.

## Why

`agents run --project <slug>` already resolves a bare name to `<projectRoot>/<slug>`
by pure convention (`lib/project-root.ts`). That cannot name a project independently
of its folder, bind multiple repos, pin a monorepo subpath, or answer *"what is
happening on project X right now"*. At 50–100 agents the per-agent activity line is
noise; what matters is the **project**. This subsystem fills both gaps.

## The definition — `~/.agents/projects/<name>.yaml`

One hand-editable YAML file per project, beside `routines/` and `monitors/` in the
user repo. Paths are stored home-relative (`~/…`) so a definition re-roots on any
machine.

> **Commit them, or lose them.** Sitting in the user repo makes a definition
> *syncable*, not synced. `agents projects add` writes the file; nothing commits it.
> Until you run `agents repo push user`, `projects/` is an **untracked** directory, and
> any reconcile that cleans the working tree deletes it — this cost one machine its four
> definitions twice in a day. The only trace afterwards is a
> `chore(local): save …-sync drift` commit that is unreachable from `HEAD`, so it is
> recoverable until git collects it and not after. Recover with:
>
> ```bash
> cd ~/.agents
> git log --all --oneline --diff-filter=A -- 'projects/*'   # find the drift commit
> git show <sha>:projects/<name>.yaml > projects/<name>.yaml
> ```
>
> (`agents push` was removed; the command is `agents repo push <alias>`. Note that it
> stages with `git add -A`, so check `git status` for unrelated drift first.)

```yaml
name: rush                      # stable id == filename; what --project takes
description: "Rush app"
root: ~/src/github.com/phnx-labs/rush
defaultPath: ~/src/github.com/phnx-labs/rush/apps/web   # where an agent's cwd lands
repo: phnx-labs/rush            # primary GitHub slug (PR / merge rollup)
repos:                          # every directory this project binds (see below)
  - slug: phnx-labs/rush-infra
    path: ~/src/github.com/phnx-labs/rush-infra
goals:                          # the outcomes this project serves (OKR-shaped)
  - objective: "Ship Rush 2.0"
    measure: "all tiers migrated"
contexts:                       # described starting points — an agent reads `purpose`
  - path: apps/web
    purpose: "user-facing Next.js app; funnel + growth surfaces"
  - path: packages/api
    purpose: "FastAPI backend; Supabase models live here"
integrations:                   # external context, surfaced in `projects show`
  - kind: gdrive
    url: https://drive.google.com/…
    label: "design docs"
linear:
  projectId: a1b2c3d4-…
  name: "Rush"                  # display name (used by Fleet / feeds)
dispatch:
  enabled: true                 # opt into auto-dispatch from Linear
  maxAgents: 3                  # cap on concurrent auto-dispatched agents
  provider: codex               # optional cloud backend pin (otherwise agent-native)
  host: mac-mini                # pin dispatch to a specific fleet device
```

| Field | Purpose |
| --- | --- |
| `name` | Stable id, == filename. What `--project` takes. |
| `root` | Repo / monorepo root, home-relative → portable. |
| `defaultPath` | Where an agent's cwd lands (a monorepo subdir). Defaults to `root`. |
| `repo` / `repos[]` | GitHub slug(s), each with an optional `subpath`, for the PR/merge rollup. `repos[].path` (home-relative) names that repo's local checkout: it opts the repo into workspace probing (`status`) **and** into the directories an agent spawned on this project can reach (see [A project is a set of directories](#a-project-is-a-set-of-directories)). |
| `contexts[]` | `{path, purpose}` described starting points — indexed anchors for agents. |
| `goals[]` | `{objective, measure}` the OKR-shaped outcomes a project serves — a project may have several. The objective is the "why"; `measure` is the optional key result. Milestones (pulled from Linear) are the dated checkpoints toward them. |
| `integrations[]` | `{kind, url, label}` external context sources. |
| `linear` | `{projectId, url, name}` — reuses the existing Linear path. All three are written by `agents projects link` and `projects import --from-linear`. `name` is the board's own display label (shown on the `status` card, in Fleet, and in the activity feed) and is **refreshed from Linear on every link**, so renaming a project on the board fixes the label here with one `agents projects link <name> --linear "<new name>"`. It is not the def's identity — the filename is (`agi.yaml` is the local id, `AGI` is what the board calls it). |
| `dispatch` | `{enabled, maxAgents, provider, host}` — auto-dispatch settings read by `agents __auto-dispatch` and by the Fleet dispatch panel. All subfields are optional. `enabled: true` opts the project into auto-dispatch; `provider` optionally pins a `agents cloud` backend (`rush`, `codex`, `factory`, `host`, …), otherwise the delegated agent's native cloud backend is used; `host` selects a named fleet device when `provider: host`. |

## Resolution — definition first, convention fallback

`resolveProjectRef` (`lib/project-root.ts`) looks up a named definition before the
`<root>/<slug>` convention. A defined project resolves to its `defaultPath` (or
`root`); a `@worktree` suffix lands under the repo root's `.agents/worktrees/`. An
**undefined** slug falls through to the unchanged convention. Home-relative paths mean
`--project rush --device <box>` re-roots on the remote's home automatically.

Resolution is intentionally **not** beta-gated — only the `agents projects` command
tree is. A definition exists solely by explicit user action (`projects add`,
`projects import`, or hand-authoring the YAML), so honoring it in `--project`
resolution is additive and safe; users without any definitions see zero change.

## A project is a set of directories

A project usually spans more than one checkout — a CLI, its website, and the
DotAgents repo it ships resources into. Each `repos[]` entry with a `path` is one
of those directories, and everything that starts an agent resolves all of them:

```bash
# --root sets where agents start; --dir binds the directories they may reach.
# The slug is read from EACH directory's own origin remote.
agents projects add agents-cli \
  --root ~/src/github.com/muqsitnawaz/agents-cli \
  --dir ~/src/github.com/muqsitnawaz/agents-cli-web \
  --dir ~/.agents/.system

agents projects set agents-cli --add-dir ~/.agents/.system     # bind one more
agents projects set agents-cli --rm-dir  ~/.agents/.system     # unbind it
agents projects set agents-cli --add-dir ./vendor/thing --slug o/thing  # no origin
```

**The slug comes from the directory, never from its path.** A checkout at
`~/src/github.com/muqsitnawaz/agents-cli` whose origin is `phnx-labs/agents-cli`
records the remote it actually pushes to. `--slug` names it explicitly for a
directory with no origin; it applies to a single `--add-dir`.

**Which one is the cwd.** `defaultPath ?? root` — set by `--root` / `--path`, and
**not** by `--dir`. `--dir` binds a directory; it never moves where an agent starts.
Every bound directory other than that cwd is attached as an `--add-dir` grant:

```bash
agents run claude --project agents-cli
#   cwd        ~/src/github.com/muqsitnawaz/agents-cli
#   --add-dir  ~/src/github.com/muqsitnawaz/agents-cli-web
#   --add-dir  ~/.agents/.system

agents teams create feat --project agents-cli   # same, for every teammate
```

This holds for `agents run` (local and `--device`) and for `agents teams`. In a
team, the project's directory sits **below** `--cwd` and a `--worktree` in the cwd
precedence chain — an explicit one still wins — but the grants are attached either
way, since the siblings are what the project binds, not where the teammate sits.

**Who consumes the grants.** Claude, Cursor, and Kimi take the native `--add-dir`
flag. Codex folds the directories into its `workspace_roots` / permission profile.
Grok injects a short rules note so the model knows the siblings are in scope, and
— when a non-off OS sandbox is active (`GROK_SANDBOX` / `--sandbox`) — writes a
project-local `.grok/sandbox.toml` profile (`agents-project`) with those paths as
`read_write` and selects it. Every other harness has no multi-root surface, so it
sees the cwd alone. That is a harness limitation, not a configuration mistake.

**A directory missing on this box is skipped, not an error.** A definition binding
a checkout that only exists on some machines still loads, and the primary cwd still
resolves. For a `--device` run the paths stay `~/…` and are **not** filtered against
this machine's filesystem — the target host has its own checkouts, and the `agents
run` on that host expands `~` against its own `$HOME` before the harness sees it.

For a team, the grants are resolved **at launch**, not when you run `teams add`. On
a `--devices` pool an unpinned teammate has no host until the scheduler places it,
so freezing directories at add time would hand it this machine's absolute paths.

Definitions are syncable, not synced: after binding directories, push them with
`agents repo push user` and `agents repo pull user` on the other boxes.

## One name everywhere — activity, feed, sessions

Definitions also rename the fleet's activity. `resolveProjectNameForCwd`
(`lib/projects.ts`) is the single project resolver shared by `agents feed`
(buckets and row chips), `agents feed post` (the stamped project), and the
`agents sessions` overview: a cwd inside a defined project's root reads as the
project's **name** — a multi-repo project is one bucket, not one per repo — and
anything else falls back to the repository-level key (`lib/project-key.ts`). Each
machine resolves its own cwds against its own (synced) definitions before events
cross the wire. `agents feed --project <name>` narrows the stream to one project.

## `status` and `view` are one body

`status`, `view`, and `show` are aliases of a single implementation (`runProjectCard`). There
is no second renderer to drift.

- **Unnamed** (`agents projects status`) — the multi-project rollup: next milestone only,
  scannable across every defined project.
- **Named** (`agents projects status rush`, `view rush`, `show rush`) — the same card for one
  project, with **every** milestone and the stored definition underneath (each repo with its
  subpath and checkout, each context with its purpose, each integration with its URL, the
  Linear link, the docs, and the YAML path). The fleet fan-out — and its
  `--device`/`--devices` scoping — applies to both forms.

Gathering still goes through `enrichProjectsForRender` so a signal added for the card appears
whether you typed `status` or `view`.

## The progress card — `agents projects status`

The headline. It matches every live session to a project **by cwd** (longest root
wins) and rolls up the signals already on disk. The live-agent rollup defaults to this machine's active sessions (the same set
`agents sessions --active` shows, matched by local-home cwd); the **merged-PR
count is repo-global** (via `gh`). The live line also includes sessions fanned
out over SSH across the fleet — but cwd matching is still against the **local**
home layout, so a peer session whose path uses a different home root may not
attribute. Full home-relative matching across homes remains deferred (see below):

```
fleet snapshot · as of 18:40                     # when this fleet-wide rollup was taken (status only)

rush  ·  23 live
  live     14 running · 6 idle · 3 need-input     # LIVE sessions by lifecycle state
  dead     4 finished or lost (3 crashed, 1 closed)  # a single dead status reads directly: "dead  41 crashed"
  agents   @zion        claude · running · RUSH-2107  ·  claude · running ×8
           @mac-mini    codex · idle  ·  claude · idle ×2
           @yosemite-s0 claude · running ×5  ·  +6 more
  ships    4 merged (7d) · 2 open PRs · 3 worktrees · v1.20.91  # gh counts + latest release tag
  linear   12/30 done (40%) · 5 in progress      # Linear issue counts (needs linear.projectId)
  next     Beta cut  ·  3/8  ·  due in 6 days     # the next unfinished Linear milestone
           +2 more milestones — agents projects view <name>
  tickets  RUSH-1201 · RUSH-1198 · …              # tickets worked or created
  fleet    6/13 clean · 4 behind · 4 dirty · 1 missing   # health summary, then the per-host table
           mac-mini: ⚠ ↓172 · main  ·  zion: ✓ clean · main  ·  win-mini: ✗ missing  ·  …
  proof    11 artifacts (7d) · last: plan-x.html  # artifact.created milestones by cwd
  repos    phnx-labs/rush · rush-infra
  context  apps/web · packages/api
  🔴  4 hosts behind origin/main — yosemite-m2 ↓217, mac-mini ↓172, yosemite-s0 ↓93, yosemite-m1 ↓8
      pull (or rebase) before agents on these hosts open PRs against a stale base
  🔴  win-mini: checkout missing
  ⚠️  4 hosts with uncommitted changes — pinnacles 16, yosemite-s0 3, yosemite-m2 1, zion 1
```

- **`live`, `agents`, `plan`, open PRs, `tickets`, `worktrees`** come straight from the
  active session list (`rollupSessionsByProject`) — no network. The `agents` line
  groups live agents by host (`@zion  claude · running ×9  ·  …`) so the same
  harness on two machines is not collapsed into one cell. Within a host, cells
  collapse identical state (`×N`), sorted running-first, capped with `+N more`. Remote sessions carry their peer's hostname.
- **`ships` merged-count** is a best-effort `gh pr list` on the primary repo
  (`--no-remote` skips it; a missing `gh`/auth degrades to 0). It counts up to the
  100 most recent merges within the window. The trailing tag is the **latest release
  of the primary repo only** (`gh release list -L 1`; `repos[]` are not scanned),
  absent when the repo has no releases.
- **`linear`** counts issues by state TYPE (completed → done, started → in progress)
  in the Linear project bound via `linear.projectId` — set it with
  `agents projects link <name> --linear`. Best-effort: no credential, offline, or a
  slow API (>8s) just omits the line, and `--no-remote` skips it too. `total`
  includes canceled issues; the fetch caps at 2,500 issues and a capped count
  renders as a lower bound (`2500+ done`), never as the complete total. Answers
  are cached per project (10-min TTL), and every agent process **on one machine**
  spends from a shared hourly request budget for that key, so a box running many
  drain agents can't collectively blow Linear's 2,500 requests/hour limit — when
  the budget is spent the card serves the last cached snapshot (marked stale)
  rather than forcing a throttle. The budget state is machine-local (not
  fleet-synced), so two boxes sharing one key each budget independently;
  coordinating the budget across devices is not yet covered.
- **`next`** is the project's next unfinished Linear milestone — the earliest
  `targetDate` that is not yet complete — rendered `name · done/total · due …`.
  A percentage says how far along a project is; the milestone says what it is due
  to hit next, which is what a person plans around. Undated milestones sort last;
  the line is omitted when the project declares none or all are complete.

  The milestone **list comes from the project, not from its issues**
  (`project.projectMilestones`), because a milestone commonly has nothing filed
  under it yet — deriving the list from issue assignments hides exactly those.
  Issues supply only the `done/total` progress, and when none are assigned the
  fraction is omitted rather than printed as a meaningless `0/0`. The list rides
  along on the **first** page of the existing issue fetch, so the line costs no
  extra request and inherits the same 8s budget and best-effort degradation.

  Dates read in human terms — `due today`, `due tomorrow`, `due in 6 days`,
  `overdue by 3 days`, and `due Aug 21` once a countdown stops being useful.
  Linear stores a calendar date with no timezone, so both sides are compared at
  **local** midnight; parsing it as UTC would shift the answer by a day for
  anyone west of Greenwich.
- **`proof`** counts `artifact.created` activity milestones whose cwd is inside the
  project (`lib/project-status.ts`).
- `--window <days>` sets the merged-PR / artifact window (default 7).

### Fleet workspace drift (default)

Projects are natively multi-device, so `status` adds a `fleet` block per project
by default, showing the state of its workspace repos on every fleet device —
present or missing, on which branch, ahead/behind the upstream, and uncommitted
changes. A one-line **health summary** (`N/M clean · behind · dirty · missing`)
sits above the per-host table so the block scans without reading every cell; the
table keeps the branch and per-host drift detail:

```
rush  ·  3 agents
  live     2 running · 1 idle
  ships    4 merged (7d)
  fleet    1/3 clean · 1 dirty · 1 missing
           zion: ✓ clean · main  ·  mac-mini: ⚠ 12 dirty · ↑3 · feature/x  ·  gpu-box: ✗ missing
```

- **What it dials.** One parallel SSH call per online device (the canonical
  `remote-agents-json` fan-out, 12s per-peer timeout) running the hidden
  `agents projects probe --json <path...>` on each peer, plus the existing
  sessions fan-out so the card's `live` line counts agents on every box, not
  just this machine. Local paths are probed directly.
- **What's probed.** Each shown def's `root` plus every `repos[].path` — the
  field that opts an additional repo into drift tracking (the def otherwise
  only knows the primary `root` on disk). Paths are home-relative, so they
  re-root on each peer.
- **Drift is against the last-fetched upstream.** The probe never runs
  `git fetch` — `↑`/`↓` measure against the peer's remote-tracking refs as they
  are. A repo with no upstream reports no drift (not zero).
- **Unreachable or older peers are named once** in a trailing note
  (`· N devices didn't answer (unreachable, older agents-cli, or timed out): …`)
  — a peer whose CLI predates the probe subcommand lands in the same skipped
  list, never a silent gap. Peers answer whenever their binary carries the
  `probe` subcommand.
- `--json` includes the fleet data: per project `workspaces: [{host, path,
  present, branch, upstream, ahead, behind, dirty, lastCommit, error}]`.
- **Dialed by default.** Scope it to a subset with `--device <name...>`
  (repeatable) or `--devices a,b,c` (comma-separated); with no filter every
  registered online device is dialed.

## Warnings footer

Anything that needs attention lands at the **bottom** of the card, not mid-stream:

| Mark | Severity | Examples |
| --- | --- | --- |
| 🔴 | critical | missing checkout, ≥10 commits behind, repo slug mismatch, large crash pile |
| ⚠️ | continue | dirty tree, small behind, schedule not measurable |

**Grouped by root cause.** Workspace warnings collapse per class so a fleet where
eight hosts drift is a few lines, not sixteen: all behind hosts become one warning
listing each host with its count (`4 hosts behind origin/main — mac-mini ↓172, …`)
under **one** shared remediation, and dirty/missing collapse the same way. A lone
host keeps its full sentence. Grouping is **per probed path**, so two different
repos never merge into one count. A behind group is critical when **any** host is
≥10 behind. (`workspaceWarnings` in `lib/project-probe.ts`.)

A local workspace probe always feeds this footer (cheap, no SSH). The full per-host
`fleet` table is shown by default — scope it with `--device`/`--devices`.


## Command surface

| Command | Does |
| --- | --- |
| `agents projects list [--json] [--with-agents]` | All defined projects (root, repo, …). Definitions only by default — zero session scan / SSH. `--with-agents` is an explicit opt-in for **local** active counts only. |
| `agents projects add <name>` | Scaffold `<name>.yaml`; infers `root` + origin slug from the current repo. Flags: `--root`, `--path`, `--repo`, `--dir <path...>` (bind directories; slug read from each one's origin), `--context path:purpose`, `--goal objective:measure`, `--linear`. |
| `agents projects save --json` | Create or update one project from a complete `ProjectDef` JSON object on stdin; validates against the canonical schema, writes atomically under `~/.agents/projects/`, prints the saved definition as JSON. Used by the ext (and any other machine client). |
| `agents projects view <name>` / `show` | Alias of `status <name>`: full card, every milestone, stored definition. |
| `agents projects edit <name>` | Open the YAML in `$EDITOR`. |
| `agents projects status [name] [--json] [--window N] [--no-remote] [--device name...] [--devices a,b,c]` (aliases `view`, `show`) | Progress card for every project across the whole fleet (per-device workspace drift over SSH), or one named project. Named form also prints every milestone and the stored definition. `--device`/`--devices` scopes the fan-out to a subset. |
| `agents projects link <name> --linear [query]` | Bind a Linear project into the def (`linear.projectId` + `name` + url). No query → auto-suggests from the def name + repo slug; ambiguous/none lists candidates and exits 1. Powers the `linear` card line. Re-run it to pick up a project renamed on the board — the recorded `name` is refreshed from Linear every time, and the command says which label it replaced. |
| `agents projects import --from-linear` | Import the workspace's Linear projects (via the `linear` CLI) as definitions. See [Importing](#importing--from-linear). There is no ext import path — `~/.agents/factory/projects.json` is never read. |
| `agents projects set <name> [--repo\|--root\|--path\|--description\|--goal objective:measure\|--add-dir\|--rm-dir\|--slug]` | Change one field, preserving every other. `--goal` (repeatable) replaces the goals list. `--add-dir` / `--rm-dir` (both repeatable) bind and unbind directories; `--slug` names the remote for a single `--add-dir` whose origin cannot be read. Removals apply before additions, so `--rm-dir old --add-dir new` re-points a directory in one command. Use this rather than `add --force`, which rebuilds the definition from flags alone. |
| `agents projects remove <name> [--json]` (alias `rm`) | Remove the definition (never touches the repo). `--json` prints `{ ok, name, removed }` (or `{ ok: false, name, error }` on failure). |
| `agents projects pull <name> [--device name...] [--devices a,b,c] [--json]` | Fast-forward every fleet checkout of a named project to its remote default branch. See [Pulling every reachable checkout](#pulling-every-reachable-checkout). |
| `agents projects prs <name> [--json] [--repo owner/repo [--number n]]` | Every open PR across the project's attached repos, read over REST: drafts included, no author filter, each row with `createdAt`/`updatedAt`, author, branch, and body. The envelope carries `viewer` (the authenticated login) and, per repository, `sharedWith`. `--repo … --number` enriches one PR with checks, `reviewDecision`, `mergeable`, and `mergeableState`. In a shared monorepo the list is scoped; see [Monorepo subprojects](#monorepo-subprojects-which-project-owns-a-session). |
| `agents projects prs merge <name> --repo owner/repo --number n --sha <head> [--method rebase\|squash\|merge] [--json]` | Merge one PR with a single REST call pinned to the head SHA the caller reviewed. GitHub refuses (exit 1, `merged: false`) if the branch moved, and branch protection, required checks, and reviews stay GitHub's to enforce. With no `--method`, it uses the first of rebase, squash, merge the repository allows. AGI Menu's Merge button runs this. |

The same claim scopes **pull requests** (`agents projects prs`). When a repository is
attached to more than one project, a project that claims part of it lists only the PRs
whose changed files touch its paths (`scope: project`) or touch no sharing project's paths
(`scope: repo-wide`: root config, CI, shared docs). A PR that touches only another
project's subtree is left to that project, and one that touches both is listed under both.
A project that claims the whole repository (no narrowed `defaultPath` or `subpath`) still
sees every PR. Changed-file lists are cached per head SHA in
`~/.agents/.cache/project-pr-files.json`; a list never changes for a given head, so only a
new push costs a REST read.
