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

One hand-editable YAML file per project, beside `routines/` and `teams/` in the
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
| `agents projects prs <name> [--json] [--repo owner/repo [--number n]]` | Every open PR across the project's attached repos, read over REST: drafts included, no author filter, each row with `createdAt`/`updatedAt`, author, branch, and body. The envelope carries `viewer` (the authenticated login) and, per repository, `sharedWith`. `--repo … --number` enriches one PR with `checks` (`name`, `status`, `conclusion`, `link` per check, anchored to the live head), `reviewDecision`, `mergeable`, and `mergeableState`; `isDraft` is on every row. `reviewDecision` is GitHub's own verdict (`APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or null when the repository requires no review), read with one `gh pr view` call because REST cannot compute it; it is never approximated from `pulls/{n}/reviews`. Every open row also carries `ciState` (GitHub's rollup of the head commit: `SUCCESS`, `FAILURE`, `PENDING`, `ERROR`, `EXPECTED`, or null when it has no checks) and `failingChecks` (names of failed, errored, timed-out, cancelled, or action-required checks). Each repository adds `recentlyMerged` (PRs merged in the last 7 days, newest `mergedAt` first, at most 20: `number`, `title`, `url`, `author`, `headRefName`, `baseRefName`, `mergedAt`, `mergedBy`, `mergeCommitSha`, `additions`, `deletions`, `scope`, and `ciState`/`failingChecks` for the merge commit, i.e. the base branch right after the merge) and `defaultBranch` (`{ name, sha, ciState, failingChecks }`). All of it is REST: each commit's checks are read with the same check-runs and status calls `--number` uses. A commit whose checks have all finished is cached in `~/.agents/.cache/project-pr-ci.json`, never permanently: a green one for an hour, in case a slower workflow adds a check later, and a red one for five minutes, because re-running a failed job turns the same commit green. Running and check-less commits are always re-read. The open and closed PR lists are cached by `gh` for 60 seconds. Merged PRs come from the closed-PR list sorted by last update (at most 3 pages of 100); `truncated` is true when that cap was reached with the window still open, so the merged list may be missing PRs. Each merged PR's `mergedBy`/`additions`/`deletions` read is cached in `project-pr-merged.json`, since it cannot change after the merge. Each repository also carries `ciError`: null when every one of those reads succeeded, otherwise GitHub's message (a rate limit when one occurred). The fields whose read failed are then null or empty and must not be read as "no checks" or "nothing merged"; the repository itself is not marked failed. Each repository also carries `release`: the highest plain version tag (`vX.Y.Z` or `X.Y.Z`; prefixed trains such as `menubar/v1.11.0` are ignored) as `{ latestTag, latestTagAt, mergesSince, mergesSinceComplete, npm }`. `latestTagAt` is the tagged commit's commit time; `mergesSince` counts the scoped merges in the 7-day window merged after it, and `mergesSinceComplete` is false when the tag predates the window or the closed-PR scan was truncated, so the count may be short. `npm` is `{ name, version, error }` for the public package the release commit bumped to the tag's version (a `package.json` the tagged commit changed, or the root one; private and mismatched manifests never count), else null; `version` is `npm view <name> version` (5-second timeout), and `error` says why it is null. The tag list, tagged commit and manifest are REST reads `gh` caches for an hour, and the npm read is cached for an hour in `project-npm-versions.json`. `release` is null when the repository has no version tag; `releaseError` names a failed read instead. With `--number`, `ciState`/`failingChecks` are derived from the same REST `checks`, `recentlyMerged` is `[]`, `defaultBranch` is null, `ciError` is null unless the `merge` settings read failed, `truncated` is false, and `release`/`releaseError` are null. In a shared monorepo both lists are scoped; see [Monorepo subprojects](#monorepo-subprojects-which-project-owns-a-session). Every open row carries `autoMerge` (`{ enabledBy, method }` when GitHub auto-merge is on, else null, from the list's `auto_merge`). Each repository carries `merge`: `{ viewerIsAdmin, adminBypass, autoMergeAllowed, methods }`, or null when it could not be read (`ciError` then names why). It comes from the cached `repos/{r}` read (`permissions.admin`, `allow_auto_merge`, the allowed methods) plus, only for an admin, the default branch's classic protection (`--cache 1h`); `adminBypass` is true when the viewer is an admin and that protection does not enforce on admins, or the branch has none (HTTP 404). Rulesets are not read: their bypass list is GitHub's to apply when the merge runs. Both reads are cached for an hour, so a settings change can take that long to show. |
| `agents projects prs ready <name> --repo owner/repo --number n [--sha <head>] [--json]` | Mark a draft PR ready for review. GitHub has no REST endpoint for this, so it is one GraphQL mutation (`markPullRequestReadyForReview`) after a REST read of the node id; a single mutation does not drain the shared GraphQL budget the way a poll loop does. A PR that is already ready succeeds without a write. With `--sha`, a head that moved is refused before the write (read-then-write, since the mutation takes no SHA). `--json`: `{ repo, number, ready, sha, message }`. |
| `agents projects prs review <name> --repo owner/repo --number n --approve --sha <head> [--body text] [--json]` | Approve a PR with one REST call (`POST pulls/{n}/reviews`, `event=APPROVE`). The live head is read first and a moved head is refused; the review carries `commit_id` set to that full SHA, so it is recorded against the code the caller saw. On the viewer's own PR (the cached `gh api user` login equals the author) it answers "GitHub doesn't let you approve your own pull request" (exit 1) without posting, since GitHub never allows it. `--json`: `{ repo, number, event, submitted, sha, id, url, message }`. |
| `agents projects prs comment <name> --repo owner/repo --number n (--body text \| --body-file path\|-) [--json]` | Post a conversation comment with one REST call (`POST issues/{n}/comments`), not the GraphQL-backed `gh pr comment`. `--body-file -` reads stdin; an empty comment is refused. `--json`: `{ repo, number, commented, id, url, message }`. |
| `agents projects prs merge <name> --repo owner/repo --number n --sha <head> [--method rebase\|squash\|merge] [--admin] [--json]` | Merge one PR with a REST `PUT pulls/{n}/merge` pinned to the head SHA the caller reviewed. Without `--admin`, the PR's live `mergeable_state` is read first: `blocked`, `behind`, `dirty` and `draft` are refused before the PUT. A `blocked` PR (a required check pending or red, or a required review) reads "Blocked by branch protection; pass --admin to merge as an admin"; the others each say why. A state GitHub has not computed (null or `unknown`, which on some repositories never settles) goes on to the pinned PUT, so GitHub's own merge check answers: it merges, or refuses with its reason. `--admin` skips that refusal so a repository admin can merge past branch protection where GitHub allows it (`merge.adminBypass`); it exists for a person's explicit confirm, AGI Menu's "Confirm admin merge", and agents must never pass it (the `gh-merge-guard` rule denies it). GitHub refuses (exit 1, `merged: false`) if the branch moved: a 409 reads "The head moved since you looked", and a 405 naming required checks reads "Required check test hasn't passed"; other refusals are GitHub's own line. With no `--method`, it uses the first of rebase, squash, merge the repository allows. AGI Menu's Merge button runs this. `--json`: `{ repo, number, method, merged, sha, message }`. |
| `agents projects prs automerge <name> --repo owner/repo --number n --sha <head> [--method rebase\|squash\|merge] [--json]`, or `--off` | Turn GitHub auto-merge on, so the PR merges itself once its required checks pass, or off with `--off` (no `--sha` needed). GitHub has no REST endpoint for it, so each is one GraphQL mutation (`enablePullRequestAutoMerge` with `expectedHeadOid` set to the full live SHA `--sha` names, or `disablePullRequestAutoMerge`) after a REST read of the node id and head. The repository must allow auto-merge (`merge.autoMergeAllowed`), and GitHub refuses it on a PR that can already merge. Turning it off when it is not on answers without a write. AGI Menu's "Merge when checks pass" and "Cancel auto-merge" run this. Exit 1 unless auto-merge ends in the requested state. `--json`: `{ repo, number, enabled, method, message }`. |
| `agents projects prs failure <name> --repo owner/repo --sha <commit> [--json]` | Why one commit's CI failed (a PR head, a merge commit, or the default branch head; AGI Menu runs it when a ✗ is clicked). REST only: the commit's check runs and statuses, then each failing GitHub Actions job's log (`GET actions/jobs/{job}/logs`). The excerpt drops timestamps, ANSI colour and the runner's cleanup after `Post job cleanup.`, and keeps the lines that read like an error (`error`, `fail`, `exit code`, `exited with code`, `✗`, `×`) with one line of context on each side, at most 12 (the first seven and the last four around `…` when there are more). `--json`: `{ repo, sha, error, checks: [{ name, url, runId, jobId, conclusion, excerpt, excerptError }] }`. A log that cannot be read empties that check's `excerpt` and says why in `excerptError`; a check that is not an Actions job has `runId`/`jobId` null and no excerpt. `error` is non-null (exit 1) only when the checks themselves could not be read. Reading a log needs a `gh` that knows `--allow-escape-sequences`; an older one says so in `excerptError`. |
| `agents projects prs rerun <name> --repo owner/repo --run-id <id> [--json]` | Re-run the failed jobs of one workflow run (`runId` from `failure --json`) with one REST call (`POST actions/runs/{id}/rerun-failed-jobs`). GitHub refuses a run that is still in progress (exit 1). `--json`: `{ repo, runId, requested, message }`. |
| `agents projects todo add "<text>" [--project P] [--description D] [--assignee A] [--due YYYY-MM-DD] [--priority urgent\|high\|medium\|low\|none] [--json]` | Create a quick to-do in Linear from one typed line (AGI Menu's Home to-do line and quick-add form run it). Each option beats the same field typed in the line. The first standalone `#name` is the project (an `agents projects` definition's Linear project, else a Linear project name), the first day word (`today`, `tomorrow`, `mon`…`sun`, full names too) is the due date (the next such day, today included), and a standalone `!` / `!!` is high / urgent priority (else none). Runs `linear create` assigned to the Linear API key's owner (or `--assignee`, by name or email; `me` is the owner), in the active cycle, status Todo, `--skip-milestone`, no delegate (unowned, so any agent's queue includes it), with `--description` followed by the line `Created from AGI Menu`, which is how `list` finds quick to-dos (no label is added). `--json`: `{ ok, message, todo: { identifier, url, title, project, due, priority, state, createdAt, quick } }`; a refusal is `ok: false` with the reason (exit 1): linear's, or one checked before calling it (a title under 3 or over 120 characters, a malformed or past `--due`, a description over 10,000 characters). |
| `agents projects todo list [--json]` | Your open quick to-dos plus any open issue assigned to you due today or overdue, due ones first (earliest due), then the newest quick to-dos, at most 6. One `linear tasks --assignee me --status open` read. `--json`: `{ todos, total, error }`. |
| `agents projects todo done <id> [--json]` | Mark an issue Done (`linear update --done --proof "Checked off in AGI Menu"`; linear requires proof). Same result shape as `add`. |
| `agents projects todo undo <id> [--json]` | Undo the menu's last action: a Done issue goes back to Todo; a quick to-do still open and created in the last 30 seconds moves to the team's canceled state (linear-cli has no issue archive). Anything else is refused (exit 1) rather than silently ignored. |

Every single-PR verb exits 1 on a refusal and still prints its `--json` result, so a
caller reads the outcome from stdout (`ready` / `submitted` / `commented` / `merged`
is the success bit) and GitHub's own refusal line from `message`. Flags are validated
before any GitHub call.

`agents teams create <team> --project <name>` binds a whole team to a project.

`agents run --project <name>` is unchanged in spelling — it just resolves richer
definitions now, and attaches the project's other directories as `--add-dir`
grants.

## Pulling every reachable checkout

`agents projects pull <name>` fast-forwards every fleet checkout of a named project to
its remote's default branch. It extends the `status` fleet fan-out — the same directory
set that `status` probes is the set `pull` updates.

```bash
agents projects pull rush                        # pull every checkout in the project
agents projects pull rush --device yosemite-s0  # scope to one device
agents projects pull rush --devices s0,s1       # scope to multiple devices
agents projects pull rush --json                # machine-readable results
```

**Safety contract — what pull will and will not do:**

- **Only fast-forwards** — no rebase, no reset, no history rewrite.
- **Dirty trees are blocked immediately.** The fetch is never attempted when there are
  uncommitted changes.
- **Only checkouts on the remote's default branch** are eligible. A checkout on
  `feature/x` is blocked and reported.
- **Local commits ahead of upstream block the pull.** The checkout must be strictly
  behind (or equal to) its upstream before it is updated.
- **Missing checkouts are skipped** — never cloned. If a project directory does not
  exist on a device, it is reported as `missing` and the command moves on.
- **The declared repo slug is verified first, on every device.** A bound directory whose
  `origin` is a different repo than the project declares is blocked, as is one whose
  `origin` cannot be resolved to an `owner/repo` slug at all — the checkout cannot be
  confirmed to be the right repo, so it is never fast-forwarded.
- **Git hooks are never installed** during a pull.

Blocked (`blocked`) and failed (`failed`) checkouts drive a non-zero exit code.
Missing checkouts (`missing`) do not.

**Per-device output:**

```
rush
  yosemite-m1
    ✓ ~/src/github.com/phnx-labs/rush updated (main) a1b2c3d4→e5f6a7b8
    · ~/src/github.com/phnx-labs/rush-infra already current (main)
  yosemite-s0
    ? ~/src/github.com/phnx-labs/rush missing — skipped
  2 updated · 1 current · 1 missing
```

The fan-out uses the same `gatherRemoteAgentsJson` seam as `status`, with a
120-second per-device timeout (vs the default 12s) to allow for large repos and
slow links.

### Devices that did not answer, and devices that answered unverifiably

These are different states and the command keeps them apart:

| State | Meaning | Reported as | Exit code |
|---|---|---|---|
| `unavailable` | The device never answered — offline, no `agents` CLI, or past the 120s budget. Nothing ran there. | `unavailable: <names>` | unaffected |
| `unverified` | The device answered, but its response failed verification (wrong machine id, a target fingerprint that does not match the targets that were sent, or a malformed row). It already ran a real pull whose outcome cannot be read. | `unverified: <names>` | **non-zero** |

An unverifiable answer is worse than silence, so it is never folded into the results as
a device with nothing to report. Under `--json` both notes go to **stderr** (the JSON on
stdout stays a clean result array), matching `projects status --json`.

**How the fan-out stays verifiable.** Each peer runs the hidden
`agents projects pull-local --json --targets <json>`, where `--targets` carries the full
`{path, expectedSlug}` list — not bare paths. Both halves of a target have to cross that
boundary: `expectedSlug` is what makes the peer refuse a directory hosting a different
repo, and it is hashed into the target fingerprint the caller checks the peer's envelope
against. A peer that cannot decode its targets exits non-zero rather than pulling a
guessed subset.

## Importing — from Linear

`--from-linear` imports the workspace's Linear projects through the `linear` CLI.
Each project becomes a def carrying `linear.projectId` and `linear.name` (+ `url` when
the CLI reports one), and the `show` backlink lights up immediately. `linear.name` is the
board's display name verbatim — `AGI`, not the slugified def name `agi`. A Linear project exists because someone
deliberately created it, so the name and the link are trustworthy.

The local checkout is bound **only on an exact normalized-name match** against the
directories under the configured projects root (`matchLocalCheckoutExact`,
`lib/linear-projects.ts`) — "Agents CLI" binds `agents-cli`, and nothing else. The
containment fallback that powers `projects link`'s suggestion is deliberately not
used on this write path: it would silently bind "Agents CLI" to `agents-cli-web`
with nobody looking. A project with no exact local match still imports, carrying
`name` + `linear` and nothing it cannot prove; fill the rest in with
`projects set` or by editing the YAML.

Re-importing is safe. An existing def is preserved field-for-field and only
`linear` is overwritten, so a hand-set `description`, `goals`, `contexts`, or
`integrations` survives. A def that already carries `root`/`repo` is skipped unless `--force`,
so a re-import never re-points a project you have already bound by hand.

Drop a bad import with `agents projects remove <name>` — it only unlinks the YAML, never the repo.

## Not yet (fast-follow)

- **Home-relative cwd matching across machines.** `status` now dials the whole
  fleet by default (live-agent count via the sessions fan-out + per-device
  workspace drift), but cwd matching is still local-home — a session recorded on
  a different-home machine only matches once home-relative cwd matching lands.
- **Re-point `agents factory snapshot`** per-project Linear rollup at defined projects.
- **Per-repo release lines** — the `ships` release tag is the primary repo only.
- **Persisted `project_id` session column** — today membership is derived from cwd.

## The stored `repo` must match the checkout's remote

A definition's `repo` is a plain string, so it can be confidently wrong — a repo cloned to
`~/src/github.com/<you>/agents-cli` whose `origin` is `phnx-labs/agents-cli` might carry
`<you>/agents-cli` when hand-authored or imported from a path-only heuristic.

Both slugs resolve to real repositories, so no call fails. The card simply reads the merged-PR
and release counts from a **different repo** — 0 merges in 7 days instead of 100. A wrong
number that looks right is worse than a missing one. `status` and `show` print the disagreement
with its fix attached whenever a def's `repo` differs from the remote of its `root`:

  ```
  repos    muqsitnawaz/agents-cli
  !        repo is muqsitnawaz/agents-cli but origin is phnx-labs/agents-cli —
           PR and release counts are being read from the wrong repository
           agents projects set agents-cli --repo phnx-labs/agents-cli
  ```

The check is silent when this machine has no checkout to read a remote from — absence of
evidence is not a finding.

## The Linear line is cached, and degrades to stale rather than absent

Linear meters requests and query complexity separately, and only one of them binds. Measured
on this workspace's response headers:

```
x-ratelimit-requests-limit:   2500      remaining: 2
x-ratelimit-complexity-limit: 3000000   remaining: 2999987
```

Requests are scarce; complexity is essentially untouched. Since the card pages every issue in
a project (up to 10 requests each), an agent running `status` in a loop exhausts the budget —
which is exactly how it was exhausted during this feature's development.

Answers are cached under `~/.agents/.cache/linear-projects/` for 10 minutes, matching the
repo's existing `SKILL_INDEX_TTL_MS` convention — **one file per project**, written by atomic
rename. A single shared JSON document would have to be read, modified, and written back, and
that sequence is not atomic across processes: measured with two concurrent writers of 40
distinct keys each, **8 of 80 entries survived**. A machine running a dozen agent sessions
makes that the normal case rather than a corner. Per-key files have nothing to clobber, and the
same measurement now yields 80 of 80. A second `status` inside the window makes no
Linear request at all.

The behavior that matters more is on failure: **a stale answer is served and labelled, never
dropped.** A Linear row that was populated a minute ago must not blank out because one fetch
timed out — the same invariant `mergeAuthHealthEntries` keeps for account health. A 429 records
its reset time so subsequent runs skip the call entirely instead of spending a request to learn
the budget is gone.

`AGENTS_LINEAR_CACHE_PATH` overrides the location (tests use it; `getCacheDir()` resolves
`HOME` once at module load, so a test swapping `process.env.HOME` would otherwise read and
write the developer's real cache).

## The headline counts live agents, and `planPct` is gone

Two numbers used to sit on the headline and neither meant what it looked like.

**The agent count included dead sessions.** A real project read `39 agents` while 19 of those
had crashed. It now reads `19 live`, and the wreckage gets its own row — `dead  19 finished or
lost (19 crashed)` — because 19 crashed sessions is a thing to go fix, not throughput to brag
about. `orphaned` counts as **live**: `lib/session/active.ts` defines it as "alive, but no
client is attached" (the agent outlived its window and is still working), and the repo's own
dead rule (`commands/sessions.ts`) is `closed` and `crashed` only.

The `agents` roster below the headline is filtered the same way. It used to list every matched
session, so a card headed `23 live` went on to print `claude · crashed ×25` — the corpses the
`dead` row already accounts for, shown a second time and contradicting the number above them.
`isDeadStatus` is the single predicate behind both, and a test pins them to agree across every
`ActiveStatus` so they cannot drift apart.

**`planPct` measured whichever agent last wrote a todo list.** It summed each matched session's
most recent checklist snapshot, so:

- no session had ever called `TodoWrite` → `total = 0` → the figure silently disappeared;
- one agent opened a fresh 40-item plan → `0/40` → the whole project read **`0% plan`** while
  everyone else worked.

It also counted crashed sessions' frozen final checklists forever, and summed unrelated
denominators as though they were one plan. No repair makes a cross-session sum of ad-hoc
checklists mean project progress, so it is removed from the card and from `--json`, replaced
there by `live` and `dead`.

## Milestones: all of them, and Linear's own "next"

`status` shows the next checkpoint plus a pointer; `view <name>` shows every declared
milestone with its date and progress. When Linear itself flags one (`status: "next"`) that is
the one used — it is the answer showing in Linear's UI, whereas earliest-dated-unfinished is
only our guess, used when nothing is flagged.

A milestone with no issues assigned reports no progress, and `view` says so once rather than
printing a column of silent `0%`s:

```
    !          no issues are assigned to any milestone — progress against them
               cannot be measured
```

## `focus` — what was actually worked on

The card could say how many agents ran and how many PRs merged, but not *what was worked on*.
That answer is already in the checkout: every commit names the files it touched. `focus` ranks
the directories the window's commits landed in, three levels deep so a monorepo reads as
`cli/src` rather than `apps`:

```
focus    cli/src 2.3k  ·  cli/docs 302  file-touches (7d)  # git log --name-only buckets
```

Local `git log --name-only`, no GitHub API, no credential, no rate-limit budget — measured at
**0.23s** over a 897-commit week, which is why it runs unconditionally rather than behind a flag.
It reads the local ref and never fetches: a status command must not mutate the repo it describes,
so the answer is as fresh as your last fetch.

**Changelog fragments and lockfiles are excluded from the ranking, not just the display.** This
repo files one fragment per PR, so `.changelog` otherwise ranks second by raw file-touches —
presenting PR count as an engineering focus area.

## `schedule` — only what the dates prove

```
schedule 3 milestones, no issues filed against any — progress is not measurable
schedule Beta cut overdue by 6 days
schedule GA due in 9 days
```

| Verdict | Fires when |
| --- | --- |
| `declared` | a human posted a Linear project health update — relayed and attributed (`per Linear: atRisk`) |
| `overdue` | a milestone's `targetDate` has passed and it is unfinished |
| `untracked` | milestones exist but no issue is filed against any of them |
| `due-soon` | the next dated milestone lands within 14 days |
| `scheduled` | dated milestones ahead, none due soon, work is filed |
| `no-dates` | milestones exist, none carries a date |
| `none` | the project declares no milestones — the line is omitted entirely |

**There is deliberately no `on-track` or `at-risk`.** Producing one requires either project
start+target dates to interpolate an expected-progress line, or a scope-history series to
extrapolate a finish date. Probed against a live workspace, every one of those inputs is empty:

```
health: null       startDate: null        targetDate: null
scopeHistory: []   completedScopeHistory: []   inProgressScopeHistory: []
```

So the chip would be invented. A blank is bad; a confident wrong answer that gets trusted is
worse, and it is unfalsifiable from the card. The union has no such member, so it cannot be
produced by accident later either.

## Monorepo subprojects: which project owns a session

Attribution (`projectNameForCwd`) matches a session's cwd against the paths each project
claims, longest match winning so a nested project beats its parent. What a project *claims*
is the part that needed fixing:

- `root` says where the **checkout** is.
- `defaultPath`, when nested under `root`, says which **work** is this project's, and takes
  precedence over `root`.
- a narrowed `root` still claims the rest of its checkout, but only as a fallback: any other
  project claiming that path outright wins. So the umbrella takes `apps/web` when one exists,
  while a lone project keeps attributing work across its own repo.
- each `repos[].path`, and `repos[].path` + `subpath`, anchor as well.

Without this, two definitions sharing one monorepo checkout — an umbrella `rush` at
`~/src/rush` and a subproject `rush-cli` at `~/src/rush` with `defaultPath ~/src/rush/cli`
— both anchored at `~/src/rush`. Longest-match had nothing to separate them, so a session in
`rush/cli` was attributed to whichever definition was listed first, and the answer
changed with definition order.

A subproject scoped to `cli` deliberately does **not** own `apps/web`; that work falls to
the umbrella. Set the scope with `agents projects add <name> --root <monorepo> --path <subdir>`.

When the subproject is the *only* definition on that checkout there is no umbrella to fall to,
so its `root` still covers `apps/web` and the repo root. `--path` chooses where an agent
starts, and it must not silently shrink which work counts as the project's.

The same claim scopes **pull requests** (`agents projects prs`). When a repository is
attached to more than one project, a project that claims part of it lists only the PRs
whose changed files touch its paths (`scope: project`) or touch no sharing project's paths
(`scope: repo-wide`: root config, CI, shared docs). A PR that touches only another
project's subtree is left to that project, and one that touches both is listed under both.
Recently merged PRs are scoped the same way.
A project that claims the whole repository (no narrowed `defaultPath` or `subpath`) still
sees every PR. Changed-file lists are cached per head SHA in
`~/.agents/.cache/project-pr-files.json`; a list never changes for a given head, so only a
new push or a newly merged PR costs a REST read. An entry is kept while its head is still
listed as open or recently merged.
