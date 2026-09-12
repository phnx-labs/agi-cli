# agents-cli (monorepo)

A monorepo housing the `agents` CLI plus its shared libraries and native
helpers. Install, configure, run, and dispatch AI coding agents (Claude, Codex,
Cursor, OpenCode, OpenClaw, Grok, Droid, …) from one place.

> Phoenix Labs · FSL-1.1-Apache-2.0.

**The main project here is the agents CLI** — [`cli`](cli), the
published `@phnx-labs/agents-cli`. Everything else (`packages/*`) is a
**helper app / library for one feature**, not a main project.
**AGI EXT, the VS Code extension, lives in its own repo:
[phnx-labs/agi-ext](https://github.com/phnx-labs/agi-ext)** (private; split out
2026-08-25, RUSH-3189). It consumes this CLI; its thin-client contract lives in
that repo's `AGENTS.md`. **AGI Menu, the macOS menu-bar helper, lives in
[phnx-labs/agi-menu](https://github.com/phnx-labs/agi-menu)** (private; split out
2026-09-10, PHNX-4036). This repo never builds it: it consumes the signed build
that repo publishes on the public `menubar/v<x.y.z>` release tag here
(`cli/docs/menubar.md` is the cross-repo contract).

**This file is the repo map + repo-wide policy — it deliberately stays shallow.**
**Read the nearest component `AGENTS.md` (recursively) before working in it** — for
Claude that's `CLAUDE.md`, a symlink to the same file — and keep going down: the
component file, not this one, is where component-specific detail lives. Every
component with a real `AGENTS.md` carries `CLAUDE.md`/`GEMINI.md` symlinks to it.

## Purpose — keep agents running, land work end to end

agents-cli is a power user's control plane for running many coding agents at once and
driving each one to a **landed** result (merged, shipped, verified), not just started.
Starting an agent is the easy part. The hard part is that agents stall: they stop
mid-task, ask a question and idle, make a statement ("I won't continue…") and sit, fail
to reach for the browser or a secret they already have, or hand work back instead of
finishing it. Every reliability surface in this repo — the daemon **watchdog**,
`needs-you` detection, **resume/restore**, session-status truth, and the AGI EXT
**Fleet** panel (in [phnx-labs/agi-ext](https://github.com/phnx-labs/agi-ext)) —
exists for one job: notice an agent that has stopped making progress
and get it moving again, so work lands end to end without a human babysitting every
session.

**Design consequence — rank by progress, not by liveness.** A *running* session is
making progress and needs nothing from the operator. The sessions that need a human are
the ones that have **stopped** progressing: blocked on a real prompt, stalled on a
statement, **idle mid-task**, or crashed. Idle-but-unfinished work is the
**highest-risk** state, not the lowest, because it is the most likely to be silently
abandoned with no progress ever made. So any status or attention surface (the Fleet
panel, `sessions`, notifications) surfaces not-progressing work **first** and collapses
the healthy running set; it never buries idle work below running work. `done` is a
distinct terminal state from `idle`: an idle session that is genuinely finished is safe
to fold away, while an idle session that is unfinished is exactly the one to raise.

## Repo map

```
apps/
  cli/        @phnx-labs/agents-cli — the `agents`/`ag` CLI (the published npm package)
packages/
  session-tracker/  @agents/session-tracker — SessionStart hook that WRITES live-session state
  agi-cli/          @phnx-labs/agi-cli — DEPRECATED alias; re-exports the canonical @phnx-labs/agents-cli
  swarmify-mirror/  legacy npm-redirect stub (@companion/agents-cli → @phnx-labs/agents-cli)
assets/ website/   Brand + launch demo (under assets/demo/), landing (repo-root, not shipped in any tarball)
```

| Component | What it is | Read |
|---|---|---|
| [`cli`](cli) | The CLI — version mgmt, config sync, sessions, teams, cloud, browser, computer, secrets | [AGENTS.md](cli/AGENTS.md) · [README.md](cli/README.md) |
| [phnx-labs/agi-ext](https://github.com/phnx-labs/agi-ext) | AGI EXT VS Code extension (own repo) — agent terminals as tabs, Fleet dashboard, dispatch | that repo's AGENTS.md |
| [phnx-labs/agi-menu](https://github.com/phnx-labs/agi-menu) | AGI Menu, the macOS menu-bar helper (own repo) — published as `MenubarHelper.app.zip` on this repo's `menubar/v<x.y.z>` tag, installed by `agents menubar` | that repo's AGENTS.md · [cli/docs/menubar.md](cli/docs/menubar.md) (the contract) |
| `@phnx-labs/computer-cli` | The standalone `computer` engine (own repo) — the helper daemons, the RPC, and the autonomous loop behind `agents computer`. agents-cli is a thin consumer of it (PHNX-4075) | [cli/docs/computer.md](cli/docs/computer.md) (the contract) |
| [`packages/session-tracker`](packages/session-tracker) | Live-session **writer** (SessionStart hook) | [AGENTS.md](packages/session-tracker/AGENTS.md) · [README.md](packages/session-tracker/README.md) |
| [`packages/agi-cli`](packages/agi-cli) | Deprecated alias — re-exports the canonical CLI | [README.md](packages/agi-cli/README.md) |
| [`packages/swarmify-mirror`](packages/swarmify-mirror) | Deprecated npm-redirect stub | [README.md](packages/swarmify-mirror/README.md) |

**No JS workspaces.** Each package self-installs (`bun install` inside it). There is
deliberately no root `workspaces` field — adding one changed bun's hoisting and broke
`@inquirer/core` resolution under `--frozen-lockfile`. Don't add it back. There are no
cross-package imports except the CLI resolving the native helpers by relative path.

## Core concepts

What agents-cli actually is: one engine that installs the **resources** an agent needs,
**runs** the agent, and extends it with real-world **tools**, **sessions**, **teams**, and
other **machines**. Deep reference: [`cli/docs/concepts.md`](cli/docs/concepts.md)
and [`architecture.md`](cli/docs/architecture.md).

- **Resources** — the typed things an agent needs, one kind per subdirectory of a
  DotAgents repo (`ResourceKind` in `cli/src/lib/resources.ts`): `rules` (this
  `AGENTS.md` → `CLAUDE.md`/`GEMINI.md`/…), `commands`, `skills`, `hooks`, `mcp`,
  `clis`, `permissions`, `subagents`, `workflows`, `profiles`, `routers`, `secrets`.
  Installed once in `~/.agents/` and synced into each agent's native format.
  Resolution is **layered** — project → user → extra repos → system; the highest
  layer wins a name collision, the rest union (`resolveResource`, `listResources`).
  `plugins` is a capability/sync kind (staleness `ALL_RESOURCE_KINDS`), not a
  `ResourceKind` subdirectory.
- **One execution engine.** Every agent invocation goes through one path —
  `buildExecEnv` → `execAgent` / `runWithFallback` in
  [`cli/src/lib/exec.ts`](cli/src/lib/exec.ts), entered via `agents run`. Each
  agent version runs in an isolated **version home** (`HOME` swapped before exec) so
  configs never bleed between versions.
- **Real-world tool surfaces.** `agents browser` (web) and `agents computer` (native
  desktop, a thin consumer of the standalone `computer` CLI) are the essential tools that
  let an agent act on real UIs — the difference between talking about a task and doing it.
- **Sessions.** Two things wear the name: a durable **transcript** (on disk, indexed in
  `sessions.db`, read by `agents sessions`) and an ephemeral **live identity** (which pid
  is which session right now, surfaced by `--active`). Transcripts sync across the fleet,
  so a session is searchable and resumable **cross-device**.
- **Teams.** `agents teams` runs several agents in parallel on one task, each isolated in
  its own worktree — the multi-agent surface.
- **Devices & hosts.** agents-cli runs commands on other machines over SSH, no daemon:
  **devices** are the Tailscale fleet (`agents devices`), **hosts** are dispatch targets
  (`agents hosts`); `-D/--device <name>` routes a command to any of them. This is the
  cross-device fabric under sessions, teams, run, and cloud.
- **One engine, many consumers.** `cli` owns the state — the session index, the
  pid→id registry, `sessions`/`teams`/`run`/`cloud`, and the SSH fan-out. AGI EXT
  ([phnx-labs/agi-ext](https://github.com/phnx-labs/agi-ext))
  is a **consumer**: the VS Code UI layer projects `agents sessions watch --json` and
  invokes the owning CLI nouns for one-shot reads and actions. It holds presentation
  state, not duplicate session/device/team/ticket/watchdog mechanisms. Fix a mechanism
  in the CLI and every consumer benefits.
- **One scheduler, one executor — fleet-affecting features never run twice.** Anything
  that can *act* on this machine or another fleet device — launch/resume/kill a session,
  fire a routine or monitor, inject into a terminal, rotate an account — has exactly ONE
  scheduler and ONE executor: the agents-cli daemon (`agents __daemon-run`) or a CLI
  command it drives. UI surfaces (the ext, the menubar) are **thin
  wrappers**: they render state and offer controls that call the CLI; they MUST NOT own
  a timer, watcher, or loop that detects a condition and acts on it. Detection and
  decision live in the CLI, which holds the first-party state (sessions.db, usage
  snapshots, the device registry). Where an action needs a UI-owned surface, the UI
  exposes a narrow endpoint the CLI drives (the `/inject` verb is the precedent) — the
  trigger stays in the CLI. Routines are covered by the same rule: `agents routines` +
  the daemon's pid-claimed scheduler (`cli/src/lib/daemon/daemon.ts`) are the only cron
  that fires them; a UI button may *request* a run, never *schedule* one. **Multiple
  devices are fine — shared queues are not.** Every device runs its own daemon, and
  an unrestricted routine MAY fire on all of them when its input is the firing
  device's own state (its repos, sessions, caches). But a job that consumes *shared*
  input (a ticket tracker, a PR queue, the feed, a sync bucket) MUST have exactly
  one executor per work item: an owner pin (`agents routines devices <name> --set
  <one>`), an atomic claim per item (the feed's `O_EXCL` precedent), or verified
  idempotency — otherwise two daemons pick the same task and run it twice.
  Violations are
  the double-fire bug class — the 2026-08-03 incident (the ext's watchdog rotate loop
  racing the daemon, spawning resume-tabs every 120s into exhausted accounts) is the
  canonical example; the consolidation (PR #1914) is the canonical fix. The normative
  contract is [§Scheduling & execution singularity](cli/docs/specifications.md#scheduling--execution-singularity).
- **Credentials are keyed on device role, and the two roles never cross (owner
  rule).** A **personal/desktop (headed)** device — the machine a human works on,
  e.g. `zion` — authenticates ONLY with the harness's normal interactive OAuth
  (native) login, and is where the durable token is minted. A **worker** device
  authenticates with the durable, identity-blind long-term setup-token synced from
  the account bundle. A headed device MUST NOT fall back to the setup-token when its
  native login dies — the fix for that is re-running the native OAuth flow, never the
  token. Provisioning follows one non-reversible flow: mint every interactive login
  on the laptop; for a token-bearing harness (claude/codex/gemini/grok/opencode/droid)
  copy the durable credential out to workers where it auto-injects; a token-less
  harness (kimi, antigravity) is logged in per box. This is a standing, non-negotiable
  owner requirement; the full statement is
  [`cli/docs/credential-management.md` invariant 7](cli/docs/credential-management.md#the-invariants-non-negotiable)
  + [§Provisioning model](cli/docs/credential-management.md#provisioning-model--the-canonical-non-reversible-flow-owner-requirement).

## CLI surface conventions

How the `agents` command surface is shaped. Coding agents invoke these commands under
token pressure, so the surface has to read like the task and teach its own use. These are
design rules for new or changed commands; the reviewer flags a new surface that ignores
them (see [§Code review conventions](#code-review-conventions-the-reviewer-must-enforce-these)).

- **Nest by relatedness, not dogma.** Put a command under the group that owns its noun;
  a free-standing top-level command is right when nothing owns the concept. Navigate by
  noun then action — `agents sessions resume <id>`, not `agents resume --session <id>`.
  Flags refine an action, they don't stand in for the group. Don't force a command under
  the wrong parent just to deepen the tree, and don't flatten a verb that collides with an
  owned noun.
- **Intuitive surfaces over clever flags.** A command reads like the task it performs: the
  primary object sits in the path when there is one, verbs stay consistent across groups
  (`list` / `add` / `remove` / `start` / `done`), and every command that emits data takes
  `--json` for machine callers. Flag soup burns tokens and produces wrong invocations.
- **`browser` and `computer` are similar tool surfaces.** Both drive real UIs (web /
  native desktop, local / remote / cloud) as thin CLI surfaces, not thick SDKs. They need
  not share an identical API — the backends differ (CDP vs Accessibility/UIA) — but they
  share a shape so an agent learns one mental model: pick a target/session, act, observe,
  clean up. When you add an action to one, reuse the analogous verb on the other.
- **Help teaches agents workflows, not man-page flag dumps.** A non-trivial command sets
  an `examples` block (and `notes` for prereqs and follow-ups) via `setHelpSections`
  ([`cli/src/lib/help.ts`](cli/src/lib/help.ts)), so `--help` renders an ordered
  happy-path sequence before the flag list. An agent reading help mid-task needs a
  three-line playbook, not 40 alphabetized options. Don't leave a non-trivial tool on
  commander's default help.

## CI and release latency are correctness requirements

> ### OWNER REQUIREMENTS — stated 2026-08-17, re-affirmed 2026-09-01, binding, do not weaken
>
> These five are the owner's own words, recorded verbatim in intent. The 60s bar
> dates to the 2026-08-17 directive captured in
> [`release-latency-breakdown.md`](.agents/artifacts/2026-08-17/release-latency-breakdown.md), not to the day it was written down here. **No agent may
> relax a number, delete a row, or mark one "not applicable" to make a change fit.**
> A PR that cannot meet one states so explicitly in its description and links the
> owner's decision to accept it — silently regressing a row is a blocking review
> failure ([§Code review conventions](#code-review-conventions-the-reviewer-must-enforce-these)).
>
> | # | Requirement | Bar | Status 2026-09-01 |
> |---|---|---|---|
> | **R1** | Required CI check, event → terminal state | **< 60 s** | p50 120 s · p90 133 s (26 green runs on `main`) |
> | **R2** | Ordinary release, start → registry visible + install smoke | **< 60 s** | never completes unattended — wedges on a missing producer (PHNX-3696) |
> | **R3** | A CLI release rebuilds **nothing** but the CLI — no menubar, no computer helper, no signing, no notarization on the ordinary path | absolute | **held and pinned** — `cli/scripts/release.test.ts` §"an ordinary release is CLI-only" behaviorally asserts no helper-manifest touch and `--with-helpers` defaulting OFF; the no-rebuild/no-notarize claim is pinned separately in §"release.sh attestation promotion (RUSH-2666)" |
> | **R4** | AGI Menu and the computer helpers release **separately**, on their own cadence and their own tags | absolute | held, and further decoupled — AGI Menu on `menubar/v*` with its floor in `cli/src/lib/helper-versions.ts`; the keychain helper ships with the standalone `secrets` CLI (PHNX-3989) and the computer helpers with the standalone `computer` CLI (PHNX-4075), each publishing from its own repo on its own cadence. Nothing about the requirement changed — the separation moved from separate tags in this repo to separate repos |
> | **R5** | An installed CLI and its installed helpers **auto-update** from the public channel | absolute | **held** — the CLI checks `registry.npmjs.org` once per 24h and self-installs (`cli/src/lib/self-update.ts`, entered from `bootstrap.ts` `checkForUpdates()`, opt out with `AGENTS_CLI_DISABLE_AUTO_UPDATE=1`; `agents upgrade --yes` is the non-interactive path). Helpers self-download against the floors in `cli/src/lib/helper-versions.ts`. Homebrew is **not** a channel today; npm is |
>
> R1 and R2 are hard ceilings, not averages. R3/R4/R5 are structural and have no
> percentile — they either hold or the build is wrong. The rendered plan tracing
> these to their implementation is
> [`.agents/artifacts/2026-09-01/plan-release-under-60s.md`](.agents/artifacts/2026-09-01/plan-release-under-60s.md).

**Status: targets not yet met.** As of 2026-09-01 the required Tests workflow runs a
p50 of 120 s and a p90 of 133 s (measured over the last 26 green runs on `main`) —
down from the 6.1 min / 15.8 min baseline of 2026-08-15, and still 2x the R1 bar. See
`.agents/artifacts/2026-08-15/plan-ci-release-near-instant.md` for that baseline and
the RUSH-2666 plan, and the 2026-09-01 plan above for the remaining delta. Treat this
section as the acceptance bar new CI/release work is judged against, not a description
of what CI does today.

The required pull-request check has a hard end-to-end **P99 of 60 seconds** (R1),
measured from the GitHub event timestamp until the single required check reaches a
terminal state. Ten seconds is the cache-hit target. A required job that cannot fit inside the
60-second budget must be split, rewritten, removed as duplicate ceremony, or moved to
post-merge/nightly coverage. It must not silently expand the pull-request gate.

- Run checks for the affected module and its declared reverse dependencies, not the
  whole monorepo. Every source area owns an explicit test/project boundary; an
  unmapped changed file fails impact analysis immediately.
- Keep one app-bound required check identity. The workflow always starts; job-level
  conditions report successful skips. Do not add required workflow path filters,
  duplicate status contexts, or a matrix of independently required shards.
- Execute the fast lane on already-online capacity. Queueing, runner assignment,
  checkout, dependency preparation, tests, and status upload all count toward the
  60-second P99.
- **The required pull-request check runs on GitHub-hosted runners; do not move it
  onto self-managed capacity.** The owner declined operating an executor
  (2026-09-01), and it would not address the bottleneck anyway: a required check
  spends ~19s on a cold `bun install` and ~0.27s executing tests, so runner speed
  is not the lever — caching the setup is. Staying hosted also satisfies the
  fork-isolation rule below for free, which is load-bearing because the repo is
  PUBLIC with forks. `scripts/ci-runner/` (Crabbox + Firecracker) is retained
  machinery, not the direction; see
  `.agents/artifacts/2026-09-01/plan-ci-github-hosted.md`.
  **This scopes the PR gate only.** Post-merge and scheduled lanes MAY use
  self-hosted tailnet capacity where the work genuinely needs it — the live
  precedent is `.github/workflows/tests-windows-host-e2e.yml`, which drives
  `win-mini` over the tailnet on `[self-hosted, crabbox-ci, tailnet]` and
  deliberately carries **no** `pull_request` trigger for exactly the fork reason.
  Keep it that way: the rule is about untrusted PR code, not about never using
  your own machines.
- Fork code never executes on a persistent host and never writes trusted caches. Fork
  jobs receive no durable credentials, host sockets, tailnet access, or host filesystem
  access.
- Slow integration, broad regression, mutation, packaging, and rare-platform suites
  remain valuable but run after merge or nightly. They do not block the required PR
  result or consume fast-lane capacity.
- Windows is not a required pull-request or ordinary-release platform.
  `.github/workflows/tests.yml` runs a best-effort Windows smoke only on push to
  `main`, with `continue-on-error`, and the required `Tests / test` job does not
  wait on it. Remove Windows-only code and the supported-platform claim when no
  demonstrated usage justifies the maintenance cost.
- Keep only tests that protect a distinct product invariant or regression. Delete
  duplicate assertions, implementation-detail tests, constant/trivial-guard tests, and
  tests whose removal does not reduce meaningful mutation or defect coverage.

An ordinary release has a hard **P99 of 60 seconds** (R2), measured from release start
to registry visibility plus a clean-prefix install smoke. Release promotes the exact
tested package artifact; it does not rebuild or rerun the monorepo.

**Every gate on the release path ships with the thing that satisfies it, in the same
PR.** A required proof — an attestation, a manifest, a signature — whose producer is
manual, out-of-band, or "interim" is an unfinished change, not a policy: it converts
every release into a human errand. This is not hypothetical. RUSH-2666 (`bfa1b4eed`,
PR #2751) made a release-commit-tree attestation mandatory and shipped no producer, so
**every** `release.sh --apply` since has wedged at `missing exact attestation key` and
required a hand-run script. It passed review because the release tests assert against
`release.sh` **as text** rather than running it (`cli/scripts/release.test.ts`:
`grep -cE 'expect\(\(RELEASE_SH|waitFunction\)'` = 41 source-text assertions vs
`grep -c 'runRelease('` = 9 real invocations), so they proved the gate was wired and
never that it could be satisfied. A new release gate therefore needs a test that
executes the path, not one that greps the script.

**A CLI release rebuilds only the CLI (R3).** No menubar build, no computer-helper
build, no codesign, no notarization on the ordinary path. Native helpers are
content-addressed and independently versioned on their own tags (R4), so unchanged
helpers are reused and a helper release is its own train. The computer helpers left
this repo entirely with the standalone `computer` engine (PHNX-4075), so there is no
longer a computer-helper publish script here to run. Apple
signing/notarization runs only when a **helper's** own inputs change and is outside the
ordinary release path entirely. The release train remains the only publisher.

**The installed CLI and its helpers update themselves (R5).** Both halves already hold
and must not regress. The CLI checks `registry.npmjs.org` on a 24h cache window and
self-installs (`cli/src/lib/self-update.ts`, entered from `bootstrap.ts`
`checkForUpdates()`); helpers resolve on demand against the floors in
`cli/src/lib/helper-versions.ts`. A user who installed once keeps getting fixes without
being told to run anything. Removing or gating either path is a blocking regression.
npm is the channel; adding Homebrew would be an addition, not a replacement.

## Entry points — always build and release through the scripts

Never hand-roll a build or a release. A bare `tsc` / `bun run build` / `npm publish` /
`vsce publish` skips the version stamping, gates (tests + semver + CHANGELOG), and
sign/notarize + tap/marketplace steps these scripts own — a green local compile that
ships broken. Each component's `scripts/` dir is the contract — the table below is
the canonical entry point per task; add a `scripts/<verb>.sh` there rather than a
one-off command in a PR.

| Task | Script | Contract |
|---|---|---|
| CLI build | [`cli/scripts/build.sh`](cli/scripts/build.sh) `[<version>] [--clean]` | builds into `cli/dist` |
| CLI dev install | [`cli/scripts/install.sh`](cli/scripts/install.sh) `[--bounce-daemon]` | side-by-side dev build at `~/.local/agents-cli-dev`, invoked as **`agents-dev`** (and `ag-dev`); never creates or touches `~/.local/bin/{agents,ag,browser}` |
| CLI tests | [`cli/scripts/test.sh`](cli/scripts/test.sh) `[--shard <n>] [--devices a,b,c] [--device <box>\|auto] [--crabbox] [--here]` | the full vitest suite. **Auto-picks a fleet worker by default** — `agents devices pick` resolves the least-loaded reachable POSIX box from the same auto pool `agents run --device auto` uses, so `role=worker`/`role=personal` marks govern it. `--device <box>` names one, `--crabbox` uses a disposable crabbox via [`sandbox.sh`](cli/scripts/sandbox.sh), `--here` pins this machine. **`--shard <n>` fans the suite across n workers** and is the fastest option: the suite is throughput-bound (measured 3079s CPU at 11.5x parallelism on one box, so wall == CPU/workers), so dividing the CPU across machines is what shortens it — 3 boxes ≈ 93s, 9 ≈ 31s, against 269s on one. `--shard` takes a minimum of 2 (for a single worker use `--device auto`) — a floor `--devices` shares, so `--devices onebox` is refused too — and cannot be combined with `--device`/`--here`/`--crabbox` — conflicting flags fail loud rather than silently picking one by argument order. `--devices a,b,c` names the workers explicitly, which also skips the `devices pick --json` requirement. Needs `agents` ≥ 1.22.49 for `devices pick --json`. Never runs locally unless you pass `--here`, and fails loud rather than falling back. `bun run test` is the raw in-place runner the offload targets invoke; do not call it directly on a machine someone is using |
| CLI release | [`cli/scripts/release.sh`](cli/scripts/release.sh) `<version> [--apply]` | zero-config self-routing publish of `@phnx-labs/agents-cli` to npm: runnable from any fleet box with an empty environment — requires an exact-tree attestation (it runs **no** tests itself; `release-attestation-produce.sh` does, offloaded via `test.sh`), PR + CI, then a promote-only publish on the home base — any OS, `mac-mini` by default, overridable with `--device <name>` (RUSH-3026: the tarball no longer needs per-release signing); prints a `[n/6]` phase tracker. After publish it redeploys the managed share OG-cover Worker when `worker-template.ts` changed (`--deploy-worker auto\|on\|off`, default `auto`; PHNX-3403) so prod can't drift from the shipped template. Legacy `@swarmify` shim built for reference, not published |
| ext / agents-dbg build + release | in [phnx-labs/agi-ext](https://github.com/phnx-labs/agi-ext) `scripts/` | AGI EXT and the agents-dbg app moved with the extension repo (RUSH-3189) |
| AGI Menu (menubar) build + release | in [phnx-labs/agi-menu](https://github.com/phnx-labs/agi-menu) `scripts/release.sh <x.y.z>` | builds + signs + notarizes the helper there and publishes `MenubarHelper.app.zip` + `.sha256` + `menubar-source.txt` on THIS repo's `menubar/v<x.y.z>` tag (PHNX-4036). Bump the `menubar` floor in [`cli/src/lib/helper-versions.ts`](cli/src/lib/helper-versions.ts) afterwards |
| AGI Menu (menubar) stage | [`cli/scripts/stage-menubar-helper.sh`](cli/scripts/stage-menubar-helper.sh) `[--fetch-only] [--json]` | downloads the published `menubar/v<floor>` asset, verifies its sha256 (+ codesign, Gatekeeper, and the DR-pin gate on macOS) and stages it at `cli/bin/MenubarHelper.app`; `--fetch-only` is what `release-attestation-produce.sh --with-helpers` records the helper manifest from. Never builds — there is no menubar source in this repo |

### Never install a dev build over the user's `agents`

**This repo builds the `agents` command itself, so the usual "install it globally
and run it" advice is exactly wrong here — it overwrites the CLI the user (and
every other agent on the fleet) depends on.** The general rule *"no locally built
CLIs — install globally with `npm i -g`"* does **not** apply to `cli`; this
paragraph overrides it for this repo.

To run your changes:

```bash
cd cli
bun run test                      # the suite, locally
scripts/test.sh                   # the suite, on an auto-picked fleet worker (default)
scripts/test.sh --device mark-1   # the suite, on an explicit fleet Linux box
scripts/test.sh --crabbox         # the suite, on a disposable crabbox

scripts/install.sh --skip-tests   # build + install this working tree
agents-dev sessions --active      # drive YOUR build
agents     sessions --active      # the installed CLI, unaffected
```

Hard rules:

- **Never `npm i -g` / `npm link` from the working tree.** That writes over the
  registry install at `$(npm root -g)/@phnx-labs/agents-cli`.
- **Never create `~/.local/bin/{agents,ag,browser}`.** Those names belong to the
  registry install. A dev build answering to `agents` makes PATH order decide
  which code runs, and a cleaned dev prefix leaves the production command
  dangling. `install.sh` publishes `agents-dev` / `ag-dev` instead, and removes
  any such shadow link an older revision of it left behind.
- **The daemon is shared.** `install.sh` leaves it on production code; pass
  `--bounce-daemon` only when you specifically need the browser IPC and routines
  scheduler running your build — that affects the user's everyday `agents`, not
  just `agents-dev`. (The secrets broker is a separate process the standalone
  `secrets` CLI owns, PHNX-3989 — this daemon never hosts it.)
- `agents doctor` reports a `binary-shadow` warning when something has taken the
  name; `agents fleet update` reports a dev-shadowed box as **not upgraded**.

## The `.agents/` workspace

The repo's own `.agents/` dir is where agent working files go — use it instead of `/tmp`
or the repo root so the tree stays clean. What's committed vs gitignored is deliberate
([`.gitignore`](.gitignore)):

| Path | Git | For |
|---|---|---|
| `.agents/worktrees/<slug>/` | ignored | PR-bound worktrees, one per change (see [§Conventions](#conventions-repo-wide)) |
| `.agents/scratch/` | ignored | throwaway working files |
| `.agents/artifacts/<yyyy-mm-dd>/` | committed | every durable output — plans, reports, rendered visuals — filed under the day it was authored |
| `.agents/artifacts/private/` | **ignored** | durable output that must never land — personal data (contact lists, message-derived context, anything naming real people) |

Rule of thumb: **ephemeral → the gitignored dirs; durable → `.agents/artifacts/<yyyy-mm-dd>/`.**
One dated layout, no kind-based subdirs: a plan, a report, and a rendered visual authored on
the same day sit side by side in `.agents/artifacts/2026-08-09/`. Name the file for what it
is (`plan-<slug>.html`, `<topic>-audit.md`) and render HTML next to its Markdown source.
Everything committed here is public, so anonymize people, account handles, emails, device
names, session identifiers, local paths, tailnet addresses, and
absolute home paths before it lands. Never scatter scratch in `/tmp` or the repo root.

When the output *is* the personal data — a contact list, an outreach roster, anything
built from messages or an address book — anonymizing it would destroy it. Put that under
`.agents/artifacts/private/`, which `.gitignore` excludes, and keep it in the repo so the
work stays with the project instead of drifting into `/tmp` or a home directory.

**Confidential GTM, monetization, pricing, revenue, and competitor material never lands in
public artifacts.** Files whose names or content signal go-to-market strategy, pricing
models, revenue/ARR/MRR/churn figures, launch venues, GitHub stars playbooks, or competitor
intelligence belong in `.agents/artifacts/private/` or a private repo — never in the
committed `.agents/artifacts/<yyyy-mm-dd>/` tree. The required Linux PR check runs
`scripts/guard-artifacts-confidential.ts` and fails loud with the offending paths and the
right home if one is staged.

## Conventions (repo-wide)

- **`AGENTS.md` is the canonical memory file.** `CLAUDE.md` / `GEMINI.md` are symlinks
  to it (`ls -la *.md`). **Edit `AGENTS.md` only** — a symlink target edited directly
  gets stomped on the next sync. This holds at the repo root and in every component.
- **Real services only — no mocking.** Tests must exercise the actual critical path.
  Test file sits next to source (`read.ts` → `read.test.ts`); integration tests in each
  package's `tests/`.
- **PRs are auto-reviewed by `prix/code-reviewer`** ([`.github/rush.yml`](.github/rush.yml)) —
  it reviews every PR to `main` and posts its verdict as the **`prix-cloud`** comment. That
  is the non-author review: rely on it and merge on green, don't spawn a redundant subagent
  reviewer. Review manually only if `prix-cloud` hasn't posted after CI settles or flags
  something to dig into. (It's a cloud reviewer configured in `.github/rush.yml`, not a
  `.github/workflows/` Action.) The
  reviewer reads this file before every review and enforces the conventions in
  [§Code review conventions](#code-review-conventions-the-reviewer-must-enforce-these) —
  that block is what it checks the diff against, not just prose for humans.
  - **Currently PAUSED (#1767).** Since 2026-08-02 every run crashed on startup and each
    failure minted + logged a live 1-year Anthropic token, so the trigger in
    [`.github/rush.yml`](.github/rush.yml) is disabled until the upstream Rush Cloud
    agent-host capture bug is fixed. **Until it is restored, the non-author review is a
    subagent reviewer** (spawn one, have it verify the diff and post its verdict as a PR
    comment, then merge on green) — the documented fallback, not a redundant extra pass.
    Do not re-enable the trigger until #1767 is resolved.
- **The default branch is untouchable.** Every change is a git worktree + PR — never
  edit or commit on `main`. Worktrees live under `.agents/worktrees/<slug>/`.
- **Query GitHub over the REST API, not GraphQL — the GraphQL limit is fleet-shared
  and cheap to exhaust.** `gh pr view/list --json <field>` and `gh pr checks` resolve
  through GitHub's GraphQL API (a 5,000-**point**/hr budget shared across every agent
  and machine on the account); a status poll loop drains it in minutes and then
  *every* agent's `gh` calls 401 with `API rate limit already exceeded`, plus a
  separate secondary anti-abuse limit that trips on bursty calls. Use the REST API
  instead — a distinct 5,000-**request**/hr pool, and cacheable:
  - PR state / mergeability → `gh api repos/{owner}/{repo}/pulls/{n} --jq '{state,mergeable,mergeable_state}'`
  - CI checks → `gh api repos/{owner}/{repo}/commits/{sha}/check-runs`
  - review verdict → `gh api repos/{owner}/{repo}/pulls/{n}/reviews`
  Reuse the canonical REST helpers in `cli/src/lib/github/rest.ts` rather than
  hand-rolling: `prHead` (resolves the head SHA — PR state/mergeable itself comes from the raw
  `pulls/{n}` read above), `rollupForSha` / `pendingCheckSuites` (checks), and
  `isRateLimitError` (to back off). Do NOT copy
  `cli/src/lib/github/pr-mergeable.ts`'s `listMergeableRefs` — it still calls
  `gh pr list --json …statusCheckRollup`, the exact GraphQL pattern this rule bans
  (migrating it onto `rest.ts` is part of PHNX-3557). NEVER poll in a tight loop —
  arm a daemon monitor (`agents monitors add`, 10-min cadence) or a single spaced
  check; on a rate-limit error, back off, do not retry. Mutations
  (`gh pr merge`, `gh pr create`, and `gh pr comment`) also resolve through GraphQL,
  not REST — but each is a single call, so it does not *drain* the budget the way a
  poll loop does. It will still *fail* once the shared GraphQL budget is already
  exhausted, so when the budget is tight prefer the REST equivalent — e.g. post a PR
  comment with `gh api repos/{owner}/{repo}/issues/{n}/comments -f body='…'` rather
  than `gh pr comment`. Making the `gh` overload auto-route `pr view/list`/`pr checks`
  to REST so no agent has to remember this is
  [PHNX-3557](https://linear.app/getrush/issue/PHNX-3557).
- **The `swarm-ext://` URI authority is the extension id `swarmify.swarm-ext`.**
  The extension itself lives in [phnx-labs/agi-ext](https://github.com/phnx-labs/agi-ext)
  (its frozen publish identity is documented there), but the CLI emits into that
  URI (`cli/src/lib/terminal/inject.ts`, `backends/vscodium-agent.ts`) — a
  CLI change must never assume a different extension id.

## Code review conventions (the reviewer must enforce these)

`prix/code-reviewer` reads this section on every PR and flags any violation with a
`file:line` reference. These are blocking unless the PR description explicitly justifies
the exception.

- **No stubs, placeholders, or unimplemented paths.** A function that returns a canned
  value, `throw new Error("not implemented")`, an empty body where behavior is expected, a
  hardcoded mock standing in for a real call, or a `// TODO`/`// FIXME` that defers the
  actual work — none of these merge. Flag every one with `file:line` and the concrete
  behavior that's missing. Real implementation or nothing; a stub is a bug the diff is
  hiding, not progress. (If work genuinely must be deferred, it carries a linked tracking
  ticket in the comment and the PR says so — an intent-only `// TODO` with no ticket does
  not qualify.)
- **Harness parity for cross-agent features.** The CLI integrates many agent harnesses —
  Claude, Codex, Gemini, Cursor, OpenCode, OpenClaw, Grok, Droid, Copilot, Goose,
  Antigravity, Kimi, Warp (Oz), Forge. When a change adds or extends a capability that applies across
  harnesses (subagents, hooks, MCP, allowlists, config sync, skills, workflows), it should
  cover **every** harness the capability applies to — or the PR states which are out of
  scope and why. Flag a diff that wires up two or three agents and silently skips the rest.
  The registry-driven integrations are the pattern to follow (one table entry, e.g.
  `SUBAGENT_TARGETS` in `cli/src/lib/subagents-registry.ts`, gated by
  `capableAgents(...)` — not near-identical `else if (agent === '...')` arms), and the
  completeness tests that pin the registry to the capability list must still pass.
- **The capability table stays truthful, in lockstep with the code.** A harness that lacks
  a capability must read as unsupported in its registry/map *before* any write path assumes
  it, and a capability flips to supported only in the **same PR** that lands its real code
  path — never ahead of it. A map asserting a capability the code doesn't implement is a
  lying table; flag it with `file:line`.
- **Surface parity for propagation / cross-cutting features.** When a change adds data
  that must ride the exec env or a spawn — actor/provenance, identity, session lineage,
  credentials — it must be wired through **every** exec boundary that data is meant to
  reach: the local spawn (`buildExecEnv`), `--device` SSH dispatch, `agents ssh`
  passthrough, teams (local **and** remote teammates), and routines/cron — or the PR
  states which boundaries are out of scope and why. The tell is an **absence** at a
  remote call site (no `SetEnv`/`--env` forwarding across the SSH hop), so check the
  remote dispatch builders (`cli/src/lib/hosts/dispatch.ts`, `hosts/remote-cmd.ts`),
  not just the changed files — a diff that wires only the local path and silently drops
  the data at the first SSH boundary is incomplete. (RUSH-2028 fixed exactly this gap for
  actor provenance, which PR #1525 shipped local-only.)
- **Docs stay in sync with behavior.** A change to a flag, command, config key, or
  user-visible behavior updates the docs that cover it — the relevant component
  `AGENTS.md`, its `README.md`, and `cli/docs/`. Flag a diff that adds or changes a
  surface but leaves the docs describing the old behavior, and flag examples/command names
  in docs that the change has made stale. Exempt: pure internal refactors, test-only
  changes, self-evident renames.
- **Core command groups stay in sync with fleet guidance.** A change to a core
  group such as `sessions`, `devices`, `teams`, `run`, `secrets`, or `browser`
  MUST audit the hooks, skills, commands, and rules in the companion
  `phnx-labs/.agents` repo (formerly `.agents-system`) that invoke or teach that
  group. Land the
  relevant companion edits in the same delivery and link both PRs; when the
  audit finds no consumer, state that explicitly in the agents-cli PR. A CLI
  surface is incomplete while the fleet guidance still teaches its old shape.
- **README / feature list for core features.** A new core capability (a new top-level
  command or a substantial subsystem) updates the README and any feature/command index so
  it's discoverable — shipping it code-only, invisible to users, is incomplete.
- **CHANGELOG for user-visible changes.** `cli` ships as the published
  `@phnx-labs/agents-cli` npm package. A change to a flag, command, or behavior adds a
  CHANGELOG entry under the next version. Same exemptions as docs.
- **No fallback band-aids.** Reject "just in case" branches, defensive lookups that paper
  over a data-shape inconsistency, or a second code path added to tolerate bad input.
  Standardize at the source — every fallback is a bug being hidden.
- **Fail loud at boundaries.** At an integration boundary (a harness the code path doesn't
  handle, an unsupported target, a missing prerequisite) the code raises a clear error or
  skips with a stated reason, never a silent no-op or a wrong path that looks like success.
  Flag any branch that swallows an unsupported case and returns as if it worked.
- **New commands follow the [CLI surface conventions](#cli-surface-conventions).** Flag a
  new or changed command that flattens a verb colliding with an owned noun, leans on flag
  soup where an object-in-path reads clearer, or ships a non-trivial tool on commander's
  default help instead of a workflow-first `setHelpSections` block.
- **No second scheduler.** A PR that adds a timer, watcher, or polling loop in
  a UI surface (the AGI EXT repo, the menubar) that *acts* — spawns, resumes, kills, injects,
  dispatches, rotates, fires a routine — rather than polling read-only state for
  rendering is a double-fire bug in waiting. Flag it with `file:line`. The action
  belongs in the CLI daemon or a CLI command; the UI may only render the state and wire
  controls to CLI calls. (Canonical incident: the ext watchdog rotate loop,
  2026-08-03; canonical fix: PR #1914. See
  [§Scheduling & execution singularity](cli/docs/specifications.md#scheduling--execution-singularity).)
- **Owner latency/packaging requirements R1-R5 are not negotiable in a diff.** A PR
  that raises a latency ceiling, deletes or softens a row in the
  [OWNER REQUIREMENTS table](#ci-and-release-latency-are-correctness-requirements),
  adds a rebuild of the menubar/computer helpers to the ordinary CLI release path (R3),
  merges a helper release back into the CLI train (R4), or removes an auto-update path
  (R5) is **blocking** unless the PR description states the regression outright and
  links the owner's decision to accept it. Flag it with `file:line`. Restating a bar as
  "aspirational", moving it to a comment, or marking it not-applicable counts as
  deleting it.
- **A required gate ships with its producer, in the same PR.** Flag any diff that adds
  a mandatory check — attestation, manifest, signature, proof artifact — on the release
  or CI path without the automated thing that satisfies it. "Interim producer an
  operator runs by hand" is the anti-pattern (RUSH-2666 → PHNX-3696); it makes every
  future release a manual errand. A test that greps the script's source text does not
  count as covering the gate — the test must execute the path.
- **No dead or commented-out code.** Removed logic is deleted, not commented out "for
  later." git history is the archive.
- **Tests exercise the real path.** New behavior ships with a test that hits the actual
  critical path (no mocking — see the repo-wide rule above); a bugfix ships with a test
  that reproduces the bug. Flag new behavior or a fix that lands without one.

## Security

**No sensitive data in any DotAgents repo** — all three (`project` / `user` / `system`)
are designed to be safely version-controlled. Use `agents secrets` (macOS
Keychain-backed, metadata only, never raw credentials on disk). Committed a secret by
accident? Rotate immediately — git history persists.

**Never attach a raw session transcript.** Before linking a session from a PR, issue,
or ticket, run `agents sessions render <id> -o /tmp/session.md` and attach or place
that redacted Markdown file in a secret gist. The renderer masks credential-shaped
values and local home paths by default. `--no-redact` output is local-only and must
never be shared.

## Assets & voice

Only if you touch `assets/` (incl. `assets/demo/`) or `website/`. Visual language is terminal-coded —
`#0a0a0a` bg, `#a3e635` lime accent, JetBrains Mono for the wordmark + code, Inter for
prose. Voice is direct-developer: verb + artifact, no marketing claims — closer to a
`man` page than a landing pitch. (AGI EXT keeps its own `swarmify` publish identity,
documented in [phnx-labs/agi-ext](https://github.com/phnx-labs/agi-ext).)

## Detailed design

[`cli/docs/`](cli/docs/README.md) is the source-grounded reference. Start
with [`architecture.md`](cli/docs/architecture.md) for the CLI/extension layering
and the session mechanisms, then [`concepts.md`](cli/docs/concepts.md) for
the resource model and resolution semantics of the CLI.

**Normative contract.** The major subsystems carry a source-of-truth spec
(RFC-2119 MUST/SHOULD + Given/When/Then, cited to `file:line`) that a change MUST
NOT silently deviate from — [`cli/docs/specifications.md`](cli/docs/specifications.md)
(§[Sessions](cli/docs/specifications.md#sessions) ·
§[Secrets](cli/docs/specifications.md#secrets) ·
§[Agent execution](cli/docs/specifications.md#agent-execution) ·
§[Scheduling & execution singularity](cli/docs/specifications.md#scheduling--execution-singularity) ·
§[Watchdog](cli/docs/specifications.md#watchdog)). Its
[coverage inventory](cli/docs/specifications.md#coverage-inventory) names every
other command group as documented-elsewhere or unspecified — check it before assuming
a surface has a contract.
