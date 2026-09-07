# Changelog

## Unreleased

- **A pushed bundle now lands in the root the receiving agents-cli reads, so a worker actually provisions the slot; and a Cursor slot launch on a worker no longer answers "not installed" (PHNX-3940).** Two seams closed after 1.22.90 delivered the `__cursor__` push. (1) agents-cli runs its local `secrets` under `SECRETS_HOME=~/.agents` (MIG-1) and the worker daemon reads pushed bundles from that root, but the remote half of the push ran the receiving `secrets` under its own default `~/.secrets`: zion logged `auth-sync: pushed __cursor__ (1 key(s)) to yosemite-m0` while yosemite-m0 kept answering `no readable durable key on this box yet` — the bundle sat in `~/.secrets/.cache/secrets`, keyed by a different machine-local passphrase than `~/.agents`. The one client wrapper every push goes through (`pushBundleToHost` / `pushBundleToHostAsync` in `secrets-client.ts`) now names the remote root (`withRemoteStateRoot`, `REMOTE_USER_AGENTS_DIR = '~/.agents'`), which secrets-cli 0.1.2 applies to the import, the read-back verify and literal restoration (`PushBundleOptions.remoteSecretsHome`). (2) With the key in place, `agents run cursor#gmail` on the worker still failed: the account slot launch hands the direct alias `HOME=<slot dir>` (real home in `AGENTS_REAL_HOME`), and the alias anchored its binary on `$HOME`, so `cursor-agent@main` reported `cursor@main not installed`; even under a plain HOME, cursor's own HOME swap ran before the launch lease, and `agents __launch-lease` (state root `$HOME/.agents`) failed with `No installation directory for cursor@main`. The versioned alias (schema 20, regenerated on next sync) now anchors every agents-owned path on `AGENTS_REAL_HOME`, takes the launch lease under the real home before any harness HOME swap, and cursor swaps HOME only when the spawner has not already chosen one. Test pin `STANDALONE_SECRETS_VERSION` → 0.1.2. Source: `cli/src/lib/secrets-client.ts`, `cli/src/lib/secrets-client.test.ts`, `cli/src/lib/secrets-types.ts`, `cli/src/lib/installations/shims.ts`, `cli/src/lib/installations/shims.test.ts`, `cli/tests/secrets-standalone.ts`.

- **Worker devices now actually receive Cursor, Codex and Grok worker keys — the reserved `__<harness>__` store is a file-backed bundle the daemon push can read (PHNX-3940).** `accounts add cursor gmail` on the laptop stored the Cursor API key in `__cursor__` as a bare `store.set` file item with no bundle record (the standalone rejected the `__`-wrapped name as a bundle at the time), while the only transport to a worker — `syncReservedStores` → `pushBundleToHost` — reads the store as a bundle. Every auth-sync tick therefore failed for every worker before the SSH hop, logged only as `auth-sync: reserved-store yosemite-m0: Secrets operation failed (OPERATION_FAILED)` (the real cause, `Invalid bundle name '__cursor__'`, is sanitized by the standalone), and on yosemite-m0 `agents run cursor#gmail` answered `cursor#gmail has no slot on this device` although the account row had synced. `seedReservedStoreKey` now writes the store as a FILE-backed, policy-`never` bundle — the same shape as the legacy `auth` bundle — so the existing push, the remote `secrets import <bundle> --from - --backend file`, and the worker's `readReservedCredential` all see the same item (`agents-cli.secrets.__<harness>__.<KEY>`, unchanged). Keys already written in the bare shape by 1.22.84–1.22.89 are adopted into their bundle on the publisher by the next tick (`adoptLegacyReservedStoreItems`, logged as `auth-sync: adopted N legacy reserved item(s)`), so nothing has to be re-added by hand. Requires `@phnx-labs/secrets-cli` 0.1.1, which accepts the `__<name>__` bundle shape. Source: `cli/src/lib/auth-mint.ts`, `cli/src/lib/auth-mint.test.ts`, `cli/src/lib/secrets-policy.ts`, `cli/src/lib/secrets-policy.test.ts`, `cli/src/lib/daemon/auth-sync-service.ts`, `cli/docs/credential-management.md`, `cli/tests/secrets-standalone.ts`.

- **The daemon now actually relaunches onto a new release, so a fix that ships reaches every worker's daemon without a hand `agents daemon restart` (PHNX-3940 rollout).** Two defects kept every fleet daemon on the code it booted with. (1) `resolveRunningPackageRoot(__dirname)` (`cli/src/lib/self-update.ts`) answered `path.resolve(dirname, '..')`, which is the package root only for a module directly under `dist/`; from `dist/lib/daemon/self-update-service.js` it returned `dist/lib`, so `deriveGlobalPrefix` threw `… is not an npm-managed install` on every one of the daemon's 75-minute self-update ticks. Eight Linux workers logged that ERROR for days and stayed on 1.22.79 code while their on-disk install (auto-updated by every operator-typed `agents` command) moved through 1.22.85–1.22.88 — which is why the PHNX-3940 worker-slot fix, merged and released, provisioned nothing until each daemon was restarted by hand. It now walks up from the calling module to the `package.json` naming this package (fixing the same call from `self-heal/checks/install-staging.ts`). (2) The self-update tick only exited after an install IT performed; when another process had already replaced the install underneath it, the tick compared the registry against the memoized boot version and did nothing useful, and on a box with a second `agents` copy on PATH (`/usr/local/bin`, an nvm prefix) it declined silently forever. The tick now compares the on-disk `package.json` version (`getCliVersionFresh`) with the version it booted with and, when the disk is newer and the install has settled (`installLooksSettled`: `package.json` at rest for a minute and every `bin` entry present, because bun's write is not atomic), exits for the OS-supervisor relaunch without downloading anything — the process that wrote the install already byte-verified it. That stale-install relaunch runs ahead of the shadow decline (a relaunch installs nothing, so a shadow copy is irrelevant to it), and the shadow decline itself is now logged once per daemon process instead of being a silent permanent no-op. Also, `auth-sync` now logs the accounts it skipped because their durable key is not readable on the box (previously invisible: yosemite-m0 sat at 0 slots with 9 keys in the bundle because the `secrets` on the daemon's PATH could not decrypt the store). Source: `cli/src/lib/self-update.ts`, `cli/src/lib/self-update.test.ts`, `cli/src/lib/daemon/self-update-service.ts`, `cli/src/lib/daemon/self-update-service.test.ts`, `cli/src/lib/daemon/auth-sync-service.ts`.

- **`agents artifacts share visibility` no longer 403s the handle owner on pages the fleet write token published — the owner can now hide them.** The managed Worker's PATCH route ran a per-object `owner === userId` check after the handle-claim check, so any page under a claimed namespace whose stamp was not the caller's userId — a `SHARE_WRITE_TOKEN` publish from an `agents run` (stamped `owner = <namespace>`), a page from an earlier userId `transferHandle` never saw, or a pre-stamp page — answered `403 forbidden` to a visibility change while the same caller could `DELETE` it. In practice 112 of 171 pages under one handle could not be taken from public/unlisted to `me`, and the only remedy was takedown. PATCH now settles ownership exactly as DELETE does (the `__handles/<handle>` claim, or the pre-claim rival-userId scan); a rival Phoenix userId is still refused. The `owner` stamp is deliberately left untouched — the anonymous lazy-expiry path refunds the stamped owner's usage ledger, and a fleet/BYO page was never charged to a Phoenix ledger, so re-stamping it would credit the caller's quota on expiry. Because the stamp stays, the `me` read gate now also honors the handle claim (`gateVisibility` → `holdsHandleClaim`), so the owner who hides such a page can still open it instead of getting a 404 after a 200 PATCH. Source: `cli/src/lib/share/worker-template.ts`, `cli/src/lib/share/visibility.test.ts`, `cli/src/lib/share/worker-template.test.ts`.

- **`sessions --active` / `sessions watch --json` rows now carry `launchId` and `terminalId`, the stable keys an editor tab uses to re-identify its session (PHNX-3768).** `ActiveSession` gained a declared `launchId` field (from `AGENT_LAUNCH_ID`, stamped on every agent at spawn), and both `launchId` and `terminalId` are now populated on the live-row builders — `listTerminalsActive` (which previously set neither) and `listUnattributedActiveLive` (pid-registry entry, with a SessionStart-hook-record fallback). Because `SessionWatchRow` spreads `ActiveSession`, both ride the watch stream automatically, the same enrichment path as `account` (PHNX-3184) and `version` (RUSH-2205). Non-Claude and remote agents mint their `sessionId` only after boot and store it on the remote box, so a tab had nothing stable to join on and sat on "tracking session" indefinitely; `launchId` exists from the first tick and is identical locally and across an SSH hop, giving the AGI EXT status bar a durable terminal→session join off the single `sessions watch --json` stream (foundation for session-state centralization; unblocks PHNX-3011/3587/3319). Source: `cli/src/lib/session/active.ts`, `cli/src/lib/session/remote/watch.test.ts`.

- **The project-resource sync now gitignores its own generated per-harness dirs, so launching an agent no longer dirties the working tree (PHNX-3717).** `syncProjectResourcesToAgent` copies `.agents/{commands,skills,subagents,workflows}` into each harness's in-tree discovery dir (`.factory/`, `.opencode/`, `.gemini/antigravity-cli/`, … 15 roots) on every launch and writes a `.agents-managed.json` manifest — but never told git to ignore the copies. They are regenerable build output (byte-for-byte copies of the committed `.agents/` source), yet showed as permanent `?? .factory/` untracked noise and could hard-block `git merge`/`checkout` with "untracked working tree files would be overwritten" when a stray commit of the same path collided. The only defense was a hand-maintained `.gitignore` list that always lagged the harness roster. Now, at the manifest-write chokepoint, `reconcileProjectGitignore` writes a per-agent marker-delimited block in `<projectRoot>/.gitignore` listing exactly the manifest's managed paths — anchored, POSIX, scoped to the harness dir. It is idempotent and convergent (writes only when content changes, so the launch hot path never churns the file), prunes the block when a sync clears a harness, and never creates a `.gitignore` in a non-git directory. Two guards keep it honest: it ignores only paths the sync itself generated (pre-existing/committed files are skipped and never recorded, so a repo that commits its own `.claude/CLAUDE.md` keeps it), and it drops any path that escapes the harness root (grok writes commands back into the tracked `.agents/` tree via a `../` subdir — ignoring that would hide tracked source; separate bug, PHNX-3718). Source: `cli/src/lib/project-resources.ts`, `cli/src/lib/project-resources.test.ts`.

- **Balanced routing to a worker no longer launches into a weekly-maxed account behind a days-stale usage cache (PHNX-3479).** Two fixes to the "usage × balanced × device" path. (1) `pullUsageFromPrimary` (`cli/src/lib/accounting/usage-sync.ts`) judged "is my local cache fresh?" by comparing the on-disk cache **to itself** on window *count* (`exportRows()` vs `readRow()`, both the same file) — so any non-empty worker cache skipped the pull forever. A worker cannot self-read usage (setup-token lacks `user:profile`, RUSH-2392), so its only fresh source is the daemon sync; the dead gate left worker caches days stale. It now pulls whenever the newest local row is older than `USAGE_SYNC_MAX_AGE_MS` (30m = 2× the 15m sync tick), by `capturedAt`. (2) `weightedRandomByCapacity` (`cli/src/lib/accounting/rotate.ts`) weighted a candidate by its snapshot's frozen `usedPercent` even when that snapshot failed `isUsageVerified` — so under the `'representative'` narrowing regime (verified accounts a minority, e.g. the usage endpoint 429-throttling the box), a day-old "45% used" competed as live headroom and could win the draw over a verified-healthy account. An unverified snapshot now weights as `UNVERIFIED_WEIGHT` (the floor), so a verified account wins the vast majority of draws; `nowMs` is threaded through the account and cross-harness samplers so a fixed-clock caller stays consistent. Deferred follow-ups (still on PHNX-3479): gating balanced on a fresh live `rate_limited` verdict, and a usage-freshness check in the `--device auto` eligibility gate (`hosts/ready.ts`). Source: `cli/src/lib/accounting/usage-sync.ts`, `cli/src/lib/accounting/rotate.ts`, `cli/src/lib/accounting/usage-sync.test.ts`, `cli/src/lib/accounting/rotate.test.ts`.

- **`sessions --active` / `sessions watch --json` rows now carry the session's `account`, backfilled from the index like `version` (PHNX-3184).** `ActiveSession` gained an `account` field, and `backfillActiveRowsFromMeta` fills it from the indexed `SessionMeta.account` by session id — the same render-time enrichment as `version` (RUSH-2205), never asserted by a live source, live value wins. Because `SessionWatchRow` spreads `ActiveSession`, the account rides the watch stream automatically. This lets the AGI EXT status bar read a remote tab's account off the single `sessions watch --json` stream instead of spawning a per-tab `agents sessions <id> --device <host> --json` — the event-pumped respawn behind the 2026-08-25 CPU incident (agi-cli#3019). Source: `cli/src/lib/session/active.ts`, `cli/src/commands/sessions.active-row.test.ts`.

- **`agents sessions preview <id> --json` now carries the per-file changed paths, not just roll-up counts (PHNX-2973).** `buildSessionPreviewDigest` computed the full `FileChange[]` (real path + `created`/`modified`/`deleted` op) via `classifyFileChanges`, then collapsed it to bare `{created,modified,deleted}` counts and discarded the paths — so `SessionPreviewDigest` (and thus the `preview` JSON) exposed only totals. It now keeps a bounded `changedFiles: FileChange[]` (capped at 200, counts stay the true totals) alongside `changes`, letting a consumer render a per-file diff list — the AGI EXT Fleet detail panel — at parity with the CLI. `sanitizeRemoteDigest` validates/scrubs peer-supplied `changedFiles` (well-formed `{path, op}` only), and `PREVIEW_EXTRACTOR_VERSION` bumps 1→2 so cached v1 digests recompute with the new field. Additive: the wire `schemaVersion` stays `1` and every existing consumer of `changes` is untouched. Source: `cli/src/commands/sessions-picker.ts`, `cli/src/lib/session/db.ts`, `cli/src/commands/sessions-picker.test.ts`.

- **Traces insight engine stops booking hours of human-away idle against a single tool failure (PHNX-3423).** `computeInsights` counted *any* ≥60s gap after a failed call as failure-loop waste. In an async channel session (a Slack thread the user replies to hours later) that mis-attributed the entire idle gap to the failure: a `user_location` GPS call that failed at 14:16 and whose next call fired at 18:56 when the human returned showed ~4.7h "wasted" — ~98% of it the person being away from chat, not compute. Now a single inter-call gap contributes at most `MAX_GAP_ATTRIBUTION_MS` (30m) to `wastedMs`, in BOTH the retry-loop and lone-stall branches. This matters because the retry-loop test (`nextIsSameFailure`) compares only `(tool, cause, normalized-key)` with no temporal check, so a deterministic failure that recurs identically hours apart (a permanently-denied GPS capability the user re-asks for at 2pm and 6pm) would otherwise look like an "active retry loop" and absorb the whole multi-hour gap — the same artifact. A genuine active loop is many short gaps that each clear the cap and still sum large, so the bound doesn't hide it; real single-tool stalls (a hung typecheck, a slow build) are minutes and stay fully counted. The fuller fix — persist per-call end timestamps and attribute a call's own blocking duration — is a noted follow-up. Source: `cli/src/lib/traces/insights.ts`, `cli/src/lib/traces/insights.test.ts`, `cli/AGENTS.md`.

- **CI guard blocks confidential GTM/monetization content from public `.agents/artifacts/` (PHNX-3033).** The required Linux PR check now runs `scripts/guard-artifacts-confidential.ts`, which fails loud when a staged file under `.agents/artifacts/<yyyy-mm-dd>/` (not the gitignored `.agents/artifacts/private/`) matches sensitive-strategy filename or content signals — GTM, monetization, pricing models, revenue/ARR/MRR/churn figures, launch venues, stars playbooks, or competitor intel. The error points authors to `.agents/artifacts/private/` or a private repo. Source: `scripts/guard-artifacts-confidential.ts`, `scripts/guard-artifacts-confidential.test.ts`, `.github/workflows/tests.yml`.

- **`agents browser record` now provisions ffmpeg and reliably bootstraps the CDP frame stream (PHNX-2600).** Recording resolves one usable ffmpeg from `PATH` or the managed `~/.agents/.cache` locations and, when absent, installs it with Homebrew, apt, winget, or an available Linux package manager; an exhausted auto path fails loud with the exact manual command. The screencast listener is registered before `Page.startScreencast`, filters by the outer CDP session, enables Page events, requests Chrome's stored last frame, and receives every paint before clocking the latest real frame into ffmpeg at `--fps`—avoiding both the old `everyNthFrame` deadlock and one-frame/0.04s output on static tabs. Start refuses to report success until a real frame has reached ffmpeg. This fixes empty/corrupt WebMs whose stdin never received a frame. Source: `cli/src/lib/browser/ffmpeg.ts`, `cli/src/lib/browser/cdp.ts`, `cli/src/lib/browser/service.ts`.

- **`agents monitors add` refuses immediately when a reachable peer already has the same watcher (PHNX-3299).** The fleet duplicate guard used to collect every peer before reporting a clash, so a single slow box forced the full 12-second timeout even when another peer had already answered with the same fingerprint. The fan-out now aborts remaining SSH captures the moment a peer reports a matching monitor, while the no-match path still waits for the whole fleet so uniqueness can be proved. Source: `cli/src/commands/monitors.ts`, `cli/src/lib/monitors/remote.ts`.
- **A bare `agents browser start` no longer auto-detects and silently creates a
  logged-out `auto-chrome` profile — the default browser is now a choice you make
  in `agents setup` (PHNX-3296).** `ensureDefaultBrowserProfile` used to probe the
  installed Chromium-family browsers and mint an `auto-chrome` profile
  (`cdp://127.0.0.1:922x`) on the spot, so an agent could pop a signed-out Chrome
  on your machine unbidden. It now resolves only a configured default or an
  existing launchable profile; when neither exists it throws an actionable error
  pointing at `agents setup` / `agents browser use <name>` (or, for a headless
  worker, `agents config set browser.device <host>`). A pre-existing
  `auto-chrome`/legacy `default` is still recognized, so existing installs keep
  resolving it. The interactive `agents setup` browser pick still lets you choose
  and pin one — now with an explicit "None — this box uses the fleet hub" opt-out
  in place of the silent auto-detect.
  A non-interactive / headless `agents setup browser` likewise no longer mints a
  profile silently — it recognizes an existing one and otherwise defers to the
  fleet hub.

- **A fleet browser hub lets every box drive one shared logged-in browser with no `--device` (PHNX-2010).**
  New `browser.device` config key (user scope, so a single value in the central
  `agents.yaml` syncs fleet-wide). When set, a bare `agents browser start` forwards to
  that hub instead of launching locally: the hub resolves its own default profile and
  browser, and the task→device index carries every later verb (`navigate`, `screenshot`,
  `stop`, …) to the same hub — so a headless Linux worker with no local browser drives
  the fleet's logged-in Comet on a Mac seamlessly, without `agents ssh` or a bespoke
  `ssh://` profile. The hub names itself, so there it short-circuits to a local run,
  which is what makes one synced value safe. `agents browser use` surfaces the configured
  hub; set it with `agents config set browser.device <device>`. `--device`/`--profile`
  still override per-command.

- **Self-updating Cursor and Grok installs keep account slots separate from vendor releases (PHNX-3250).** A concrete `agents add <agent>@<label>` now preserves that label as the stable version-home identity while recording the current self-updated binary in `installation.json.releaseVersion`. Multiple homes can therefore carry the same current release without sharing credentials, and `remove --isolated` can no longer target a normal install merely because both report the same vendor version.

- **`agents sync <agent> system` now reconciles system-layer plugins (RUSH-3207).**
  `resourceSourceMap` hardcoded every plugin's source layer to `'user'`, so a
  `system:*` selection expanded to zero plugins and a `system`-scoped sync silently
  skipped system-layer plugins (like the `swarm` plugin). A merged plugin change never
  reached installed agents via `agents sync <agent> system`, and `agents plugins list`
  still reported "Synced: everywhere" because the synced-status check is existence-only.
  Plugins are now attributed to the layer they actually resolve from (system / user /
  project / extra), the same first-wins resolution the plugins staleness checker uses,
  so a `system` sync includes system-layer plugins and the existing content fingerprint
  reinstalls them when their content changed even if the manifest version did not.

- **Balanced rotation no longer pins every launch to one account when the usage
  refresher is throttled (RUSH-2858).** `preferVerified` narrowed the candidate
  pool to accounts with a <5-minute usage snapshot before the weighted-random
  draw. Under Anthropic's per-machine 429 throttling of the usage endpoint,
  exactly one account tends to be that fresh at any moment, so the "random"
  draw ran over a one-element list and `--strategy balanced` launched the same
  account/version every time — and launching into it kept its snapshot fresh,
  locking the loop in while the other accounts were never picked or probed.
  For the weighted-random balanced chooser, verified-only narrowing now applies
  only when verified accounts cover at least half the pool; below that, the
  whole pool competes, with fresh accounts weighted by their confirmed numbers
  and stale/unknown ones at the default full weight. The deterministic choosers
  (`--strategy available`, run-auto harness classification) keep strict
  verified-first narrowing — a deterministic pick cannot spread load, so
  relaxing it would only reintroduce the stale-snapshot inversion. The
  `usageUnverified` flag now reports whether the PICKED account's usage was
  verified, not merely whether the whole pool was stale. Source:
  `apps/cli/src/lib/accounting/rotate.ts` (`preferVerified`).

- **`agents doctor --fix` names the exact removal command for a duplicate install it will not purge, and the multi-install banner only advertises `--fix` when it can really resolve the peer (RUSH-2705).** A healthy `>=1.22.30` duplicate
  global (for example a second install under nvm) was detected and nagged about on
  every command, but `--fix` deliberately never deletes it and ended on
  "Everything in sync" — the advertised remedy was a no-op, so the nag returned
  forever. `doctor --fix` and the post-upgrade purge now list such peers with the
  `npm uninstall -g --prefix <peer prefix> @phnx-labs/agents-cli` command that
  removes them, and the startup banner prints that same command instead of
  pointing at `--fix`. Auto-purge itself is unchanged (npx-cache / unsafe-legacy /
  pre-1.22.30 copies only; the running copy is never deleted). Source:
  `apps/cli/src/lib/self-update.ts`, `apps/cli/src/commands/doctor.ts`,
  `apps/cli/src/bootstrap.ts`.

- **`agents open` resumes a session from an `agents://` deep link, and registers the OS URL-scheme handler.** A rendered artifact (plan/report) can now carry an
  `agents://session/<id>` link in its provenance line; clicking it hands off to the
  OS, which runs `agents open <url>`, parses it, and routes the id into the existing
  resume engine (`sessions focus`) — reopening the terminal on the session's owning
  host with the cursor in the input bar. `agents setup` registers the scheme
  automatically (idempotent); `agents open register` / `unregister` / `status` manage
  it manually. Linux (`.desktop` + `xdg-mime`), macOS (AppleScript app + `lsregister`),
  and Windows (`HKCU` registry) are supported. The session id is validated and passed
  as argv, never interpolated into a shell. Source: `apps/cli/src/commands/open.ts`,
  `apps/cli/src/lib/deeplink/`.

- **The macOS `computer` helper's `trust_status` RPC now reports Screen Recording trust, not just Accessibility (RUSH-1882).** It previously returned only
  `AX.isTrusted()`, so a missing Screen Recording grant only surfaced indirectly
  when a `screenshot` capture timed out after 5s. Adds a `screen_recording` field
  via the non-prompting `CGPreflightScreenCaptureAccess()`, additive and
  backward-compatible with callers that only read `trusted`/`pid`/`path`. Source:
  `native/computer-mac/Sources/ComputerHelper/RPC.swift`,
  `native/computer-mac/Sources/ComputerHelper/Screenshot.swift`.

- **`agents devices list` moves "Leased boxes" behind `--all`; the default list no longer touches the keychain or pops Touch ID (RUSH-2190).** See
  `apps/cli/.changelog/next/devices-list-all-flag.md`.

- **Scheduled routines no longer overlap or outlive their configured timeout (RUSH-2186).** See
  `apps/cli/CHANGELOG.md`.

- **Codex hook sync no longer leaves startup warnings after upgrades.** See
  `apps/cli/.changelog/next/codex-hook-sync-warnings.md`.

- **Session lifecycle status is explicit (RUSH-2066).** `agents sessions --active`
  now reports dead processes as `closed` and days-stale/dangling sessions as
  `abandoned`, and `agents hq floor` no longer renders those rows as idle. See
  `apps/cli/CHANGELOG.md`.

- **Project routines opt-in + host placement strategy (RUSH-2035).** `agents routines enable-project` / `sync` / `--placement local|host|fleet|cloud`. See `apps/cli/CHANGELOG.md`.

- Secrets: name the requesting harness, bundle, reason, and duration in macOS
  Touch ID prompts, and scope cached unlocks to the harness type, with
  `secrets unlock --for <agent>`. Agent-triggered approval is **not** part of
  this: an agent launch never raises a sheet, it fails fast naming
  `agents secrets unlock <bundle>`. Only an `agents secrets` command run in a plain
  shell prompts; beneath an agent it inherits `AGENTS_RUNTIME` and refuses too.

### Added

- **`ag view grok` now shows usage limits.** It parses the latest billing period config and subscription tier from Grok's local `unified.jsonl` log, avoiding the need for an inaccessible network endpoint.

- **`agents sessions migrate` (alias `detach`) relocates a RUNNING session onto another
  machine, then stops the source here (RUSH-1977).** Move the live agent — not just its
  transcript — off the interactive laptop and onto a fleet worker, a registered device, or
  a warm/fresh ephemeral crabbox box, so the interactive machine reclaims its compute. With
  no `[session-id]` it resolves the session in THIS tmux pane (`$TMUX_PANE` matched against
  `provenance.mux.pane`); `--auto` scores the fleet (reachable + dispatchable + not this
  machine/source, ranked by platform-match, warm-worker-over-fresh-box, then live headroom),
  `--host <name>` names a target, and `--lease` provisions a fresh box. It wraps up a dirty
  working tree into a draft WIP PR (or, with `--agent-wrapup`, delegates that to the running
  agent), ships the transcript to the target's live agent dir (same path under the shared
  `$HOME`), resumes on the target in a detached tmux session, confirms the pane is live, and
  only then kills the source (`--keep` copies instead of moving). `--mode rehydrate` (default)
  starts the target agent with a prompt to read the transported session via `agents sessions
  <id>` (its own `--last`/`--include` judgment so long tool output can't blow context) and
  continue — robust across every harness; `--mode resume` attempts a best-effort native
  `<agent> --resume` and falls back to rehydrate when the target can't register the session.
  Every migrate is recorded in an append-only ledger at `~/.agents/.history/migrations.jsonl`,
  viewable with **`agents sessions migrations`** (the border tracker: `from → to`, mode,
  move-vs-copy, status; a session that hops A→B→C leaves its full lineage). Invariant: the
  source is never stopped before the transcript is on the target and its session is confirmed
  live. Source: `apps/cli/src/commands/sessions-migrate.ts`,
  `apps/cli/src/lib/session/migrate-targets.ts`, `apps/cli/src/lib/session/migrations.ts`,
  `apps/cli/src/commands/sessions.ts`, `apps/cli/docs/05-sessions.md`.

- **The configured model now shows wherever an agent is displayed.** `agents view`,
  `agents view <agent>@<version>`, `agents use`, `agents add`, `agents status`, and
  `agents inspect` now surface the model a given agent+version is actually set to run
  with — placed right beside the version at the same priority (no `model:` label, no
  parentheses), forming the identity cluster `agent · version · model · account`. The
  model is resolved with clear precedence: the agents.yaml `run.defaults`, then the
  agent's own native `settings.json` model, then the CLI's built-in default (the
  catalog's flagged default, or the literal `default` for agents like Claude whose
  runtime picks its own). `agents view --json` gains a `configuredModel { model, source }`
  field — the only surface that exposes the resolution `source`. New shared helpers
  `resolveConfiguredModel` / `formatAgentIdentity` in `apps/cli/src/lib/models.ts` keep
  every surface consistent. Source: `apps/cli/src/lib/models.ts`,
  `apps/cli/src/commands/view.ts`, `apps/cli/src/commands/versions.ts`,
  `apps/cli/src/commands/status.ts`, `apps/cli/src/commands/inspect.ts`.

- **Interactive session browser: preview-by-default with clickable ticket + PR links.**
  The `agents sessions` / `--active` browser now shows the highlighted row's preview
  pane **open by default** (matching the static picker) instead of hiding it behind
  `tab` — arrow through rows and read prompt/activity/last-response inline; `tab`
  toggles it off. The preview gains a **links line**: the worked-on ticket and the PR
  the session opened render as **OSC 8 hyperlinks** (clickable in supporting
  terminals) — the ticket to Linear, the `PR#` to GitHub. The Linear workspace slug is
  resolved config-first (`LINEAR_WORKSPACE` env, else the linear-cli config's
  `workspaceUrlKey`), never hardcoded, so tickets stay plain text when it's unknown.
  Source: `apps/cli/src/lib/picker.ts`, `apps/cli/src/commands/sessions-picker.ts`,
  `apps/cli/src/commands/sessions-browser.ts`, `apps/cli/src/lib/session/render.ts`,
  `apps/cli/src/lib/session/linear.ts`.
- **`agents resources --merged` shows the effective DotAgents resource surface (RUSH-1770).**
  The command lists the merged skills, commands, MCP servers, hooks, rules, plugins,
  workflows, and subagents resolved through project > user > system > extras, with
  each row tagged by its winning layer. Bare `agents devices` now runs the same list
  view as `agents devices list`, and `agents plugins add <spec>` aliases
  `agents plugins install <spec>`. Source: `apps/cli/src/commands/resources.ts`,
  `apps/cli/src/commands/ssh.ts`, `apps/cli/src/commands/plugins.ts`.
- **Factory: fleet-aware Launch Matrix — spawn a Quick Launch agent on a specific
  device or balanced across the fleet.** Each Quick Launch slot (⌘⇧0–9) gains a
  **Run on** target: this Mac (default), a registered device (offloaded over SSH via
  `agents run --host`), or ⚖ Balanced — auto-pick the least-busy online device, with
  an optional pool restriction. The collapsed row shows the target (`↗ <device>` /
  `⚖ balanced`). New optional chord **⌘⌥⇧0–9** fires a slot but prompts for the host
  once. Every non-shell agent (Claude, Codex, Gemini, OpenCode, Cursor, Antigravity,
  Grok, Kimi, Droid) also gains palette commands mirroring the version triad on a
  host axis: **(Pick Host)**, **(Pick Version & Host)**, **(Auto Host)**, plus generic
  `New Agent (Pick Host)` / `(Pick Version & Host)`. Balanced picks by fewest running
  agents, excluding the local interactive machine. Source: `apps/factory/src/core/settings.ts`,
  `apps/factory/src/core/launchHost.ts`, `apps/factory/src/vscode/extension.ts`,
  `apps/factory/ui/settings/components/panel/LaunchMatrix.tsx`, `apps/factory/package.json`.

### Security

- **`agents plugins update` no longer silently executes a compromised upstream (RUSH-1757).**
  A plugin's upstream is mutable: `updatePlugin` used to `git pull --ff-only` (or
  re-copy) straight over the live plugin tree, then re-sync — and when the new
  revision added an executable surface (`hooks/`, `.mcp.json`, `bin/`, `scripts/`,
  `settings.json`, `permissions/`) it only *declined to add* an enablement key,
  never *removed* a pre-existing one. A benign, already-enabled plugin whose
  upstream was later compromised would therefore execute new hooks/MCP on the next
  update without renewed consent. The update now fetches the incoming revision into
  a **quarantine** dir first, diffs its capabilities against the current on-disk
  baseline, and applies to the live tree only after the trust decision: an update
  that introduces a *new* exec surface is **refused** (last-good content kept in
  place) unless the user re-consents with `agents plugins update <name>
  --allow-exec-surfaces`. A surface the user already trusted is not "new" and does
  not re-trigger the gate. Source: `apps/cli/src/lib/plugins.ts` (`updatePlugin`,
  `newExecSurfaceLabels`), `apps/cli/src/commands/plugins.ts`.
- **`launch_app` on Windows rejects UNC/remote and protocol/URL targets (RUSH-1763).**
  Explicit `path` values used to flow straight into `ProcessStartInfo` with
  `UseShellExecute=true`, so a caller could launch `\\server\share\payload.exe`
  or `http://…` / `ms-settings:…` handlers. `launch_app` now rejects UNC/remote
  paths, protocol/URL schemes, and `..` path segments; explicit `path` must be
  a local drive-rooted absolute path (`C:\…`). Short names (`notepad`, `msedge`)
  still resolve via PATH / App Paths. Source: `native/computer-win/LaunchTarget.cs`,
  `native/computer-win/Apps.cs`.
- **The Windows `computer` daemon now requires authentication.** `computer-helper-win`
  previously started with `authed = expectedToken == null` and the CLI never provisioned a
  token, so it ran open on `127.0.0.1` — and loopback TCP on Windows is not user/session
  scoped, letting **any** local process drive full screen capture, input injection, and
  program launch. The daemon now **refuses to start without a `--token-file`**
  (`native/computer-win/Program.cs`), and `agents computer setup --host` generates a
  shared-secret token, writes it on the remote with an owner-only ACL, registers the task
  with `--token-file`, and persists it locally so `start --host` authenticates
  (`apps/cli/src/lib/ssh-tunnel.ts`). Existing token-less setups must re-run
  `agents computer setup --host <device>` (the daemon will otherwise refuse to start).
- **Plugin exec-surface detection now sees inline manifest `hooks`/`mcpServers`.**
  `inspectPluginCapabilities` classified a plugin as having an execution surface only
  from filesystem artifacts (a `hooks/` dir, a `.mcp.json` file), but the official plugin
  format also allows `hooks`/`mcpServers` declared **inline** in `.claude-plugin/plugin.json`.
  A cloned repo's project plugin declaring exec config inline was therefore not detected,
  so `project-launch` auto-enabled it — clone-to-code-execution on the next agent launch
  without `--allow-exec-surfaces`. Detection now also treats a non-empty inline
  `hooks`/`mcpServers` (event map or path string) as an execution surface
  (`apps/cli/src/lib/plugins.ts`). (`apps/cli/src/lib/types.ts` gains the manifest fields.)
- **SSH option-injection containment for `browser` over `ssh://`.** The `user`/`host`
  from an `ssh://` browser profile endpoint (git-tracked user config) are now validated
  with `assertValidSshTarget` before every raw `ssh` spawn — the remote-launch
  (`ensureRemoteBrowser`), remote-kill (`runSSHCommand`), and `-L` tunnel
  (`startSSHTunnel`) sinks in `apps/cli/src/lib/browser/drivers/ssh.ts` and
  `apps/cli/src/lib/ssh-tunnel.ts`. A crafted endpoint like `ssh://-Fattacker@victim`
  can no longer place `-Fattacker` at the ssh target position (parsed as `-F <file>`),
  which an attacker-supplied ssh config's `ProxyCommand` would have turned into local
  code execution.
- **Path-traversal containment for untrusted-input filesystem sinks.**
  - Routine job names (from routine YAML `name:` / file basename, which can arrive via a
    synced user/system config repo) are now contained to a single path segment beneath
    the routines dir at **every** sink. A crafted name such as `../../../..` can no longer
    steer the overlay HOME setup — whose teardown does a recursive `rmSync`
    (`apps/cli/src/lib/sandbox.ts`) — nor the per-run directory that the daemon's
    load/schedule path `mkdirSync`s and writes `stdout.log`/`meta.json`/`report.md` into
    (`getJobRunsDir`/`getRunDir` in `apps/cli/src/lib/routines.ts`, used by
    `apps/cli/src/lib/runner.ts`), outside `~/.agents/routines` and
    `~/.agents/.history/runs`. `validateJob` also rejects unsafe names.
  - Session-sync **pull** now validates the peer-controlled `machine` and `relKey` fields
    before writing a mirrored transcript, matching the guard the push side already applied.
    A malicious fleet peer can no longer use a manifest `relKey` like
    `../../../.ssh/authorized_keys` to write attacker content outside the backups mirror
    (`apps/cli/src/lib/session/sync/agents.ts`). The new containment rejection is caught
    per-session in `apps/cli/src/lib/session/sync/sync.ts` and around the umbrella-sync
    stage in `apps/cli/src/lib/sync-umbrella.ts`, so one malicious manifest entry can't
    wedge the whole sync tick (skipping `savePullState`) or the `agents sync` reconcile
    stage for everyone else.
  - Shared containment helpers `isSafeSegmentName` / `assertWithin` added to
    `apps/cli/src/lib/paths.ts`.
- **`agents sessions <id> --json` now redacts secrets by default.** The JSON render
  path emitted raw transcript events with no redaction, while `--markdown` masked
  them by default — so the output format an agent scripts against was the one that
  leaked credentials. `renderJson` now runs the whole payload (events *and* the
  session meta, including `topic`/`plan` — verbatim message excerpts) through the
  same `redactSecrets` pass as markdown, covering the JSON-only leak vector of raw
  tool-call `args`. Additionally, `--no-redact` now actually works: it read the
  wrong Commander property (`options.noRedact`, never populated) so the flag was a
  dead no-op for **both** formats; it now reads `--no-redact`'s real `redact`
  property and genuinely disables redaction when passed. Source:
  `apps/cli/src/lib/session/render.ts` (`renderJson`, `redactDeep`),
  `apps/cli/src/commands/sessions.ts`.

### Added

- **`agents run <agent>@` now opens a safe per-run account picker.** The picker
  shows one row per installed version with account identity, exact version,
  login state, plan, and available session/weekly/monthly capacity. Logged-out,
  rate-limited, and out-of-credit rows stay visible but cannot be selected;
  signed-in rows without provider quota data remain selectable and say `limits
  unavailable`. The selected version is pinned for that run only. Ambiguous
  combinations (`--resume`, strategy overrides, leases, remote hosts, profiles,
  and workflows) fail before dispatch. Source:
  `apps/cli/src/commands/run-account-picker.ts`,
  `apps/cli/src/commands/exec.ts`, `apps/cli/src/lib/rotate.ts`.

- **Routine `meta.json` now includes `duration` and `errorMessage` (RUSH-1281).**
  `RunMeta` records wall-clock `duration` in milliseconds and a machine-readable
  `errorMessage` on failure paths (spawn errors, timeouts, loop errors, host-reconcile
  failures, and monitor-reaped runs). Populated on every terminal state in
  `apps/cli/src/lib/runner.ts` via the new `finalizeRunMeta` helper in
  `apps/cli/src/lib/routines.ts`.

- **`agents run --lease` is now frictionless end-to-end (RUSH-1723).** Leasing a
  disposable cloud box to run an agent — the BYO-your-own-cloud way to offload heavy
  work when local CPU cores are exhausted — no longer needs an env var, a flag, or a
  hand-made keychain bundle:
  - **Headless by default (RUSH-1724).** `--lease` no longer blocks on an interactive
    runtime picker or confirm — it infers the one runtime the run needs from the agent,
    and copies the account the run's own `balanced` strategy would pick (a healthy,
    non-rate-limited one), never the whole set of signed-in tokens and never a throttled
    account.
  - **`agents lease setup` (RUSH-1728).** A one-time wizard opens the Hetzner token page,
    validates the token against the live API, stores it in the `hetzner.com` keychain
    bundle, and sets it as the default. First-run `--lease` detects a missing credential
    and runs this automatically, then continues.
  - **No more `AGENTS_LEASE_SECRETS_BUNDLE=` (RUSH-1728).** New `lease.secretsBundle`
    config, plus auto-detection of the first bundle that declares a provider token
    (`HCLOUD_TOKEN`/`AWS_ACCESS_KEY_ID`/`DIGITALOCEAN_TOKEN`) — only that key is injected
    into crabbox (least privilege).
  - **`agents lease gc` (RUSH-1726).** Reclaim expired, idle "orphan" boxes that hold a
    provider's server quota (the cause of a Hetzner `server_limit` 403, which is now an
    actionable error). Conservative: only stops boxes whose lease expired AND that have
    been untouched past a safety window, and requires `--yes` or a TTY confirm.

  Source: `apps/cli/src/commands/lease.ts`, `apps/cli/src/commands/exec.ts`,
  `apps/cli/src/lib/crabbox/cli.ts`, `apps/cli/src/lib/crabbox/runtimes.ts`,
  `apps/cli/src/lib/crabbox/lease.ts`, `apps/cli/src/lib/types.ts`.

### Fixed

- **Factory Floor cards keep their task context and their section counts agree.**
  Cross-host sessions now recover the original task from `topic`, legacy `prompt`,
  `firstUserMessage`, label, worktree, or branch before showing a clear `No topic`
  placeholder. Background/headless runs are hidden by default and available through
  the new **Background** feed toggle. One view-model partition now supplies both the
  rendered Needs you / active / done cards and their displayed counts (RUSH-2031).

- **`agents run <agent> --fallback …` no longer disables account rotation.**
  A `--fallback` chain skipped strategy resolution entirely ("strategy balanced
  ignored: --fallback pins versions directly"), so the bare primary always ran on
  the pinned default version — one fixed account, every run. On a multi-account
  host this silently stopped rotation for exactly the runs that most need it
  (unattended monitors dispatching with a cross-agent fallback chain). The
  fallback chain only names where to cascade; it never pinned the primary, so
  the strategy now resolves the primary's version/account as usual. The
  same-agent rotation failover (#348) also now composes with an explicit chain:
  the other healthy accounts are unshifted ahead of the cross-agent entries, so
  a rate limit exhausts same-agent accounts before switching CLIs. Explicit
  `@version` pins and profiles keep their pinning behavior.

- **Fallback now cascades on Claude billing refusals ("monthly spend limit",
  "out of usage credits").** Two gaps: the messages matched no
  `RATE_LIMIT_PATTERNS` entry, and Claude prints them to **stdout** while the
  cascade only scanned stderr — so a capped account failed the whole run
  (exit 1) with codex/droid sitting unused in the chain. Added both patterns,
  and `runWithFallback` now tees a bounded stdout tail per attempt
  (`captureStdoutTail`) and scans it alongside stderr. Output remains mirrored
  to the parent's stdout exactly as before.

- **`agents run --resume <id>` now spawns from the session's origin directory.**
  Native resume (claude/codex) resolves the transcript relative to the working
  directory (`projects/<cwd-hash>/`), but the resolver found the session across all
  projects and then invoked the agent from the *current* cwd — so a resume from a
  different directory (most importantly a routine daemon firing `agents run --resume`)
  failed with "No conversation found with session ID". It now `cd`s to the resolved
  session's own `cwd` (honoring an explicit `--cwd`). This makes `routines add
  --resume` (self-scheduled wake-ups) actually reopen the session end-to-end.

### Added

- **Allowlist (permissions) support for OpenClaw (RUSH-1570).** Permission
  groups now sync to OpenClaw. Because OpenClaw gates at TOOL granularity only,
  just **blanket** (whole-tool) rules map into `~/.openclaw/openclaw.json`
  `tools.alsoAllow` (allow) / `tools.deny` (deny) — `bash → exec`,
  `read → read`, `write`/`edit → write`, `webfetch → web_fetch`,
  `websearch → web_search`; sub-command/path/domain rules (`Bash(git:*)`,
  `Write(secrets/**)`, `WebFetch(domain:x)`) are skipped. The absolute
  `tools.allow` list and all other config keys are preserved. Source:
  `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/permissions.ts`,
  `apps/cli/src/lib/resources/permissions.ts`,
  `apps/cli/src/lib/staleness/detectors/permissions.ts`.

### Fixed

- **`agents add grok@latest` now places the Grok binary in the new version's
  isolated home.** The x.ai installer writes to `~/.grok/downloads`, which
  resolved to the previous default home during install, leaving `agents view`
  and `agents run` pointing at the old version. The installer-dropped binary is
  now relocated into the target version home automatically.

- **`agents run` user splits close automatically instead of leaving dead husks.**
  `createSession` now applies `remain-on-exit` only to the agent pane and reverts
  the global default, so splits opened with `agents tmux split` (or tmux
  keybindings) close when their shell exits. The guarded `pane-died` hook still
  detaches the client on agent pane death, and its `kill-pane` fallback remains
  for legacy sessions that still carry the old global setting. This removes the
  async cleanup race that made the guarded-hook test flake in CI.

### Added

- **Hooks support for Hermes Agent (RUSH-1687).** Central hooks now register into
  Hermes' `~/.hermes/config.yaml` under a `hooks:` block (YAML, gated to Hermes
  ≥ 0.11.0). The registrar read-modify-writes the shared config so `mcp_servers`
  and other keys survive, maps canonical events to Hermes' snake_case lifecycle
  names (`pre_tool_call`, `post_tool_call`, `on_session_start`, `on_session_end`,
  `pre_llm_call`, `on_session_finalize`, `subagent_stop`), and caps each timeout
  at 300s. Source: `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/hooks.ts`,
  `apps/cli/src/lib/staleness/writers/hooks.ts`.

- **`agents routines add --resume <sessionId>` — wake an existing session instead
  of starting fresh.** At fire time the job runs `agents run <agent> --resume <id>`,
  so the *actual* prior session reopens with its full context and the routine's
  `--prompt` becomes its next turn. Powers self-scheduled wake-ups (an agent that
  hibernates on a long external wait and resumes itself later). Without it, a routine
  spawns a context-less fresh agent, which correctly refuses an opaque instruction it
  has no memory of. Requires `--agent claude` or `codex` (native resume, validated);
  the job runs **un-sandboxed** so `--resume` can find the session in the real agent
  home, and — like workflow jobs — its command is never binary-pinned.
- **Cursor CLI receives synced subagents.** cursor-agent custom subagents are
  installed as `.md` profiles under `~/.cursor/agents/` (matching cursor-agent's
  native format), with matching list, remove, and stale-state behavior.
  (RUSH-1388)

- **`agents output` — productivity: token burn vs shipped output.** A new command
  that joins spend (`$` cost, from the offline price table) to what actually
  shipped: real generated **output tokens** plus **commits across every git
  identity** and **PRs opened/merged** (`gh`), with burn-vs-output ratios
  (`$/PR`, `$/commit`, output-tokens/`$`). Supports `--since`, `--by
  agent|project|day`, `--repos-dir`, `--author`, `--login`, `--no-prs`, `--json`,
  and `--host`. Leads with output tokens because the raw session `token_count`
  sums cache-read/-write context re-counted every turn and runs ~100–400× the
  real generation — an honest "work produced" signal, not the inflated total.
  `--all-hosts` folds in every online device (`ag devices`) over SSH for one
  fleet-wide burn-vs-output view (unreachable/older machines are labeled, not
  dropped). `--since` accepts `1h`, `24h`, `7d`, `4w`, `1mo`, `1y`, or an ISO
  date.

- **`parseTimeFilter` gains month (`mo`) and year (`y`) units.** Additive and
  non-breaking — `m` still means minutes; `1mo` = 30 days, `1y` = 365 days.
  Shared by `output`, `cost`, and `sessions --since`.

- **`output_tokens` recorded per session (schema v12).** The session scanners now
  capture real generated tokens separately from `token_count` for claude, codex,
  gemini, opencode, kimi, and droid, surfaced via `queryUsageRollup`. Existing
  session databases migrate additively and backfill on the next scan (the first
  run re-indexes once).

- **Interactive session browser — `agents sessions --active` and a bare `agents sessions`
  now open a live, filterable picker on a TTY (RUSH-1802).** One canonical filter driven by
  single keys, re-pulled across the fleet as you toggle: `s` search, `r` running-only, `c`
  teams, `a` agent (cycles), `d` device (cycles), `p` this-repo↔all-dirs, `w` time window;
  filters **stack** (AND together) and the active set shows in the header, with a live
  preview of the highlighted row and `⏎` to resume/attach via the existing dispatch. Every
  hotkey mirrors a flag, so the view is reproducible as a command — `y` copies (and
  `--print-cmd` prints) the exact `ag sessions …` line the filters map to, bridging the
  human picker and the agent/script flag surface. The interactive front-end is TTY-only:
  `--json`, a pipe, or the new `--no-interactive` keep the existing static listing verbatim,
  so scripts and headless agents are unchanged. Adds `-p` as the short form of `--project`,
  `--print-cmd`, `--preview` (`agents sessions <id> --preview` prints the compact digest
  without the pager), and `--no-interactive`. Built on a new async-refetch `dynamicPicker`
  variant that reuses the existing render/pagination/preview machinery, the fleet SSH
  fan-out, and the resume/focus path. Source: `apps/cli/src/lib/picker.ts` (`dynamicPicker`),
  `apps/cli/src/commands/sessions-browser.ts` (+ `sessions-browser.test.ts`),
  `apps/cli/src/commands/sessions.ts`.

- **`agents setup` is now a capability hub with guided `browser` / `computer` / `share`
  subcommands.** Bare `agents setup` still clones the system repo and imports unmanaged
  agents, but on a TTY it now also offers to set up the optional capabilities a fresh
  machine needs. Each is also runnable on its own and is idempotent (re-run to change
  settings): `agents setup browser` detects an installed Chromium-family browser and
  creates/points the `default` profile; `agents setup share` provisions or joins a
  Cloudflare share endpoint (reusing `agents share setup`/`join`); `agents setup computer`
  installs the macOS helper and walks you through the Accessibility + Screen-Recording
  grants — opening the exact System Settings panes and polling until trust lands. The
  existing `agents share setup` / `agents computer setup` remain for scripted use. Source:
  `apps/cli/src/commands/setup.ts`, `setup-browser.ts`, `setup-computer.ts`,
  `setup-share.ts` (+ `setup.test.ts`), `apps/cli/src/lib/browser/chrome.ts`
  (`listInstalledBrowsers`), `apps/cli/src/commands/share.ts`.

- **The macOS `agents computer` helper now ships as a signed + notarized release asset,
  downloaded on demand.** A fresh `npm i -g @phnx-labs/agents-cli` no longer needs to build
  the Swift helper from source: `agents computer setup` / `agents setup computer` fetch
  `ComputerHelper.app.zip` from the matching `v<version>` GitHub release, verify it against
  the published `.sha256`, and re-check the code signature (Developer ID Team `2HTP252L87`)
  and notarization (`spctl --assess`) before it is ever copied to /Applications — mirroring
  the Windows helper's distribution. The helper is version-stamped at build time and the
  release pipeline publishes the asset automatically. Source:
  `apps/cli/src/lib/computer/download.ts` (+ `download.test.ts`),
  `apps/cli/src/lib/computer-rpc.ts`, `apps/cli/src/commands/computer.ts`,
  `native/computer-mac/scripts/build.sh`, `apps/cli/scripts/publish-computer-helper-mac.sh`,
  `apps/cli/scripts/release.sh`.
- **`agents ssh` propagates your terminal's terminfo to the remote (RUSH-1811).**
  Modern terminals (Ghostty, kitty, Alacritty, WezTerm, foot, rio) advertise a
  custom `TERM` — e.g. `xterm-ghostty` — whose terminfo ships with the terminal,
  not with the remote host's ncurses. SSH into a box that lacks the entry and the
  session is subtly broken: wrong backspace, missing colors, a garbled
  clear/alt-screen. Ghostty's shell integration fixes the bare `ssh` command, but
  `agents ssh` (spawned directly, Tailscale-relayed) bypassed it. Now, on an
  interactive POSIX login, `agents ssh` exports the local entry (`infocmp -x`) and
  compiles it on the remote (`tic -x -`, into the user's `~/.terminfo`, no sudo).
  It is **fail-safe** — any error, timeout, or missing remote `tic` is swallowed
  so the login is never blocked or delayed beyond a short push cap — and
  **cached** per host+`TERM`, so only the first login to each host pays one extra
  round-trip. Skipped for Windows/PowerShell devices (the console ignores
  terminfo), non-interactive command runs, and terminfo names ncurses ships
  everywhere. Source: `apps/cli/src/lib/devices/terminfo.ts`,
  `apps/cli/src/commands/ssh.ts`.

- **`agents devices list` / `agents fleet status` are cache-first now — instant by
  default, `--refresh` (alias `--live`) for a live probe.** Both used to live-SSH
  every registered box for load/mem on every call, so a glance at a dozen-device
  fleet (a few cold or timing out) hung for seconds. Resource stats now serve from
  a small on-disk cache (`.fleet-stats.json`) that the daemon warms ~every 3 min;
  a default read probes only *this* machine (locally, no ssh) plus any device
  missing from the cache. Pass `--refresh`/`--live` to force a full live probe.
  Cache-served output carries an "`updated … — pass --refresh (--live)`" age note.
  `agents view` (usage already stale-while-revalidate cached) gains the same
  `--live` alias for its `--refresh`. Source: `apps/cli/src/lib/devices/stats-cache.ts`,
  `apps/cli/src/commands/ssh.ts`, `apps/cli/src/commands/view.ts`,
  `apps/cli/src/lib/daemon.ts`.

- **`agents fleet status` gains an Auth column — see which accounts are actually
  logged in, per device.** Reads the shared auth-health cache (no network) and
  rolls each host up into four honest buckets so it never cries wolf:
  `●live` (verified), `·present` (signed in but the agent has no live-probe
  endpoint — codex/grok/antigravity/opencode — benign), `◐degraded`
  (soft/self-healing: expired/limited/error), `○revoked` (server rejected —
  re-login now). Remote hosts self-report their rollup through `doctor --json`, so
  the column is current without a fleet-wide `agents fleet ping`. The daemon also
  refreshes this host's auth verdicts alongside the stats warm. Source:
  `apps/cli/src/lib/auth-health.ts` (`summarizeHostAuth`),
  `apps/cli/src/lib/devices/health-report.ts`, `apps/cli/src/commands/doctor.ts`.
- **`agents usage --json`.** `usage` was the only per-account numeric command with
  no machine-readable output (its siblings `cost`/`budget`/`view`/`doctor`/`models`
  all have `--json`), forcing a scripting agent to scrape colored text. It now emits
  a per-agent snapshot array (`{ agent, label, status, email?, usage? }`); the text
  and JSON renderers share one `collectAgentUsage` data path. Source:
  `apps/cli/src/commands/usage.ts`.
- **`agents fork` now exits non-zero on failure.** Every failure path (no match,
  ambiguous id, unforkable agent, fork error) printed to stdout and returned exit
  code **0**, so `agents fork <id> && agents resume <new>` proceeded on a *failed*
  fork. Failures now write to stderr and set exit code 1. Source:
  `apps/cli/src/commands/fork.ts`.
- **Removed the dead `--json` flag on `agents sessions tail`.** It was declared but
  never read — output is always raw JSONL — so it advertised a toggle that did
  nothing. Dropped from `tail`'s own surface (and its `TailOptions` type); output is
  unchanged, and a script still passing `--json` is unaffected since the parent
  `sessions --json` option keeps it a recognized (no-op) flag. Source:
  `apps/cli/src/commands/sessions-tail.ts`.

- **`agents fleet update` / `agents fleet run` now upgrade THIS machine too,
  instead of failing to ssh to it.** Both fanned out over ssh to every registered
  device including the current one — and a box usually has no authorized key to
  itself, so the local machine came back `Permission denied (publickey)` while all
  the remotes upgraded. `runFleet` now detects the self device (`machineId()`) and
  runs the command as a local process (`runLocalCommand`), so `fleet update` on a
  12-device fleet reports `12 ok` rather than `11 ok · 1 failed`. Source:
  `apps/cli/src/lib/devices/fleet.ts` (`runFleet`, `runLocalCommand`),
  `apps/cli/src/commands/ssh.ts`.
- **`run --copy-creds` and `hosts add` no longer hang a headless caller.** Both
  ran an interactive `@inquirer` prompt (a runtime picker + a confirm; a bootstrap
  install/upgrade confirm) with no TTY guard, so a non-TTY/piped invocation blocked
  forever on stdin. `run --copy-creds` now fails clean via `requireInteractiveSelection`
  in a non-TTY shell (it ships live credentials, so it deliberately stays
  interactive-only rather than auto-selecting), and `hosts add`'s best-effort
  bootstrap reports the version state and returns instead of prompting. Source:
  `apps/cli/src/commands/exec.ts`, `apps/cli/src/commands/hosts.ts`.
- **`agents logs <id> --json`.** The primary run-log view was text-only while its
  `audit`/`stats` subcommands already emitted JSON — so the command an agent most
  needs structured (what a dispatched run produced) was the one it couldn't parse.
  `logs <id> --json` now emits a host-dispatch task as `{ kind, task, log }` and a
  session as the redacted `{ session, events }` — the exact shape `sessions <id>
  --json` produces, via a shared renderer, so there's one session JSON contract, not
  two. Source: `apps/cli/src/commands/logs.ts`, `apps/cli/src/commands/sessions.ts`
  (`renderSessionLogJson`), `apps/cli/src/lib/hosts/logs.ts` (`hostTaskLogJson`).
- **`--json` on resource `list` commands (`skills`/`commands`/`mcp`/`subagents`).**
  The config-authoring commands were table/picker-only, so an agent enumerating
  installed resources had to scrape colored text. `--json` is added at the source —
  the shared `showResourceList` helper (`apps/cli/src/commands/resource-view.ts`)
  now emits each row's metadata + per-agent-version sync targets as JSON — so every
  command built on it inherits one machine-readable contract. Wired into `skills`,
  `commands`, `mcp`, and `subagents` `list`. (`rules`/`permissions`/`hooks`, which
  render bespoke, follow next.)

## 1.20.58

### Added

- **Cursor CLI allowlists sync into its native permission store.** Shell, file,
  web, and MCP grants now write to `~/.cursor/cli-config.json` without changing
  Cursor's existing deny rules. (RUSH-1387)

- **GitHub Copilot CLI and Kiro CLI receive synced subagents.** Copilot custom
  agents are installed as `.agent.md` profiles, while Kiro custom agents are
  installed as native JSON definitions with matching list, remove, and stale-
  state behavior. (RUSH-1390, RUSH-1393)

- **Active-session JSON includes attachment metadata for Factory previews.**
  Prompt images and documents now surface their path, name, media type, and size
  so consumers can render thumbnails and open the originals. (RUSH-1524)

- **Kiro CLI allowlists sync as v3 capability rules.** Shell, filesystem, and
  web permissions now merge into Kiro 2.8.0+ while preserving user-authored
  rules and removing duplicate generated entries.

- **Remote runs honor `--cwd`, with `--project` as a project-name shortcut.**
  Host dispatch re-roots home-anchored paths on the remote machine, while
  `--project <slug>[@worktree]` resolves configured project roots locally or
  over `--host`.

### Fixed

- **Self-updating agents are modeled as one live binary, not fictional version
  homes.** `agents view` reports the installed binary's version and folds away
  stale per-version directories; `agents add <agent>@<version>` gracefully keeps
  or installs the current release for Droid, Grok, Cursor, Kiro, Goose, Hermes,
  and other single-binary agents. (RUSH-1321)

- **Stopped teammate resumes are transactional.** Failed local and remote resume
  launches preserve the existing teammate record and runtime state, terminate
  the replacement process group and descendants, restore the prior log cursor,
  and preserve the original launch error even if the restore write also fails.
  Successful resumes restart log parsing at byte zero after truncation. (#1104,
  #1108)

- **Menu-bar Quick Dispatch keeps drafts when focus is stolen and carries every
  selected screenshot into filed tickets.** Reopening the panel restores its
  text and selections, while ticket-agent briefs now require the attached files
  to be uploaded to the resulting Linear issue. (RUSH-1592, RUSH-1668)

- **The always-on daemon is the sole persistent secrets-broker host.** Upgrades
  retire the legacy `com.phnx-labs.agents-secrets-agent` launchd service before
  restarting the daemon, and the `secrets start`, `stop`, and `status` commands
  now report and control broker reachability without reinstalling that service.
  (#416, step 2)

- **Interactive remote secret reveals do not leave an SSH control master
  behind.** The one-shot TTY reveal path now disables multiplexing, so it exits
  immediately after Touch ID or passphrase authorization.

- **Global npm upgrades restart the scheduler through the installed CLI.** The
  macOS postinstall self-heal now passes the resolved signed CLI path into daemon
  startup explicitly, so launchd never records `scripts/postinstall.js` as the
  scheduler command.

- **Daemon-hosted and standalone secrets brokers share one race-safe socket
  binder.** Either startup order now preserves the live owner; the losing broker
  stays quiescent without triggering launchd restart churn, takes over if the
  owner stops, releases its standby PID on service shutdown, and only reclaims
  an unreachable stale socket.

- **Daemon service manifests pin the active Node runtime.** Symlinked and
  extension-less Node entrypoints launch through `process.execPath`, and service
  PATHs no longer hardcode a removable nvm patch version.

## 1.20.57

### Added

- **Stopped teammates can resume with a follow-up message.**
  `agents teams resume` re-enters the teammate's captured session, while
  `agents teams message` routes to a live mailbox or resumes a stopped teammate.

- **The always-on daemon hosts the secrets broker socket-first.** Secret reads
  can use the supervised daemon immediately after start without changing the
  broker wire protocol.

### Changed

- **Secret policy labels use one `policy · state` vocabulary.**
  `agents secrets list` now reports `daily`, `daily · held 7d`,
  `always · prompt`, and `never · no prompt`.

## 1.20.56

### Fixed

- **Installed native CLIs supervise daemons through their physical executable.**
  Bun standalone binaries expose an embedded `/$bunfs/root/agents` entry at
  `process.argv[1]` and report that virtual entry as existing. Daemon service
  manifests now resolve that case through the physical on-disk `process.execPath`,
  so `agents routines start` works from the published macOS standalone binary
  while the virtual-path safety guard remains enforced.

- **Standalone self-spawns use the physical CLI binary.** `agents teams`,
  `agents message`, and `agents profiles check` no longer pass Bun's virtual
  entry back as a subcommand, restoring those flows for signed native installs.

## 1.20.55

### Added

- **Heartbeat watchdog** — the daemon writes a heartbeat (timestamp + pid) every
  monitor tick; `agents routines status` now distinguishes `running` / `wedged` /
  `stopped`. A wedged daemon (pid alive but heartbeat stale >3 ticks) is reported
  with a restart hint. (RUSH-1670)

- **Opportunistic orphan reaper** — `agents routines list` and `status` now call
  `monitorRunningJobs()` on entry (best-effort, swallowed errors), so orphaned
  `running` records finalize even when the daemon is down. (RUSH-1671)

- **Pid-reuse-safe reaper + max wall-clock** — `monitorRunningJobs()` records
  `spawnedAt` (epoch ms) at spawn and verifies process identity via `ps` before
  treating a pid as alive, preventing recycled-pid false positives. Runs exceeding
  24 hours are finalized as `timeout` regardless of pid state. (RUSH-1672)

- **Daemon binary path guard** — `getDaemonLaunch()` rejects `/$bunfs/root/…`
  (bun virtual filesystem) paths with a hard error and warns when the resolved
  binary sits inside `.agents/worktrees/`. `agents routines status` now prints the
  resolved daemon binary path. (RUSH-1673)
