---
kind: report
title: Component Health
updated: 2026-10-04
commit: 4b709a7e5c7026f4dcc56336235180386a992b03
---

# cli — Component Health

## Summary

`cli/src` holds **193,077 lines of production code** in 806 files, plus 74,358 comment
lines and 21,688 blank lines. Tests are separate: **185,262 code lines** in 1,041 files.
No size budget has been agreed, so this is a baseline, not a pass/fail.

Removing duplication and dead code alone recovers about **2,300 production lines (~1.2%)**
and **~3,200 test lines**, with no behavior decision required. The larger reductions are
owner decisions: retiring one-time migrations (~1,600 lines) and the PHNX-4227 removal of
the `agents sessions` command group (~8,000+ lines). Shrinking this codebase meaningfully
is a scope question, not a cleanup question.

Revalidated against
[`4b709a7e5`](https://github.com/phnx-labs/agents-cli/commit/4b709a7e5c7026f4dcc56336235180386a992b03)
after the first baseline at
[`6143f3743`](https://github.com/phnx-labs/agents-cli/commit/6143f3743a1076deed79822f96c808d4f1a8d787)
(+486 production code lines). Intervening source: `projects prs` CI/merged work,
`gen-command-index` extraction onto `@phnx-labs/cli-docs`, sessions-client preferring the
installed `sessions` bin, menubar viewer identity, and atomic identity session writes.
Cleanup findings below were spot-checked; none were invalidated.

<div class="artifact-grid artifact-grid-3">
<div class="artifact-stat"><div class="artifact-stat-value">193,077</div><div class="artifact-stat-label">production code lines (806 files)</div></div>
<div class="artifact-stat"><div class="artifact-stat-value">~2,300</div><div class="artifact-stat-label">removable with no owner decision</div></div>
<div class="artifact-stat"><div class="artifact-stat-value">~3,200</div><div class="artifact-stat-label">test lines covering an external package</div></div>
<div class="artifact-stat"><div class="artifact-stat-value">~1,600</div><div class="artifact-stat-label">in one-time migrations an owner could retire</div></div>
<div class="artifact-stat"><div class="artifact-stat-value">~8,000+</div><div class="artifact-stat-label">leaves with PHNX-4227 (sessions group)</div></div>
<div class="artifact-stat"><div class="artifact-stat-value">240</div><div class="artifact-stat-label">harness-name branches outside registries</div></div>
</div>

<figure class="artifact-figure">
<svg class="artifact-diagram" viewBox="0 0 720 470" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Estimated production lines removed per cleanup, no owner decision needed">
<text x="242" y="25.4" text-anchor="end" font-size="13" fill="currentColor">Dead exports (many files)</text>
<rect x="250" y="10" width="384" height="22" rx="3" fill="#a3e635"/>
<text x="640" y="25.4" font-size="13" fill="currentColor">~480</text>
<text x="242" y="55.4" text-anchor="end" font-size="13" fill="currentColor">Library / built-in swaps</text>
<rect x="250" y="40" width="216" height="22" rx="3" fill="#60a5fa"/>
<text x="472" y="55.4" font-size="13" fill="currentColor">~270</text>
<text x="242" y="85.4" text-anchor="end" font-size="13" fill="currentColor">feed/activity.ts leftovers</text>
<rect x="250" y="70" width="176" height="22" rx="3" fill="#a3e635"/>
<text x="432" y="85.4" font-size="13" fill="currentColor">~220</text>
<text x="242" y="115.4" text-anchor="end" font-size="13" fill="currentColor">Small helpers re-defined</text>
<rect x="250" y="100" width="160" height="22" rx="3" fill="#a3e635"/>
<text x="416" y="115.4" font-size="13" fill="currentColor">~200</text>
<text x="242" y="145.4" text-anchor="end" font-size="13" fill="currentColor">Two SSH transport stacks</text>
<rect x="250" y="130" width="144" height="22" rx="3" fill="#a3e635"/>
<text x="400" y="145.4" font-size="13" fill="currentColor">~180</text>
<text x="242" y="175.4" text-anchor="end" font-size="13" fill="currentColor">Cloudflare provisioning x2</text>
<rect x="250" y="160" width="136" height="22" rx="3" fill="#a3e635"/>
<text x="392" y="175.4" font-size="13" fill="currentColor">~170</text>
<text x="242" y="205.4" text-anchor="end" font-size="13" fill="currentColor">Shell quoting x16</text>
<rect x="250" y="190" width="100" height="22" rx="3" fill="#a3e635"/>
<text x="356" y="205.4" font-size="13" fill="currentColor">~125</text>
<text x="242" y="235.4" text-anchor="end" font-size="13" fill="currentColor">Daemon service boilerplate</text>
<rect x="250" y="220" width="88" height="22" rx="3" fill="#a3e635"/>
<text x="344" y="235.4" font-size="13" fill="currentColor">~110</text>
<text x="242" y="265.4" text-anchor="end" font-size="13" fill="currentColor">Staleness checker template</text>
<rect x="250" y="250" width="88" height="22" rx="3" fill="#a3e635"/>
<text x="344" y="265.4" font-size="13" fill="currentColor">~110</text>
<text x="242" y="295.4" text-anchor="end" font-size="13" fill="currentColor">MCP writer + stripJsonComments</text>
<rect x="250" y="280" width="84" height="22" rx="3" fill="#a3e635"/>
<text x="340" y="295.4" font-size="13" fill="currentColor">~105</text>
<text x="242" y="325.4" text-anchor="end" font-size="13" fill="currentColor">GitHub/gh helpers</text>
<rect x="250" y="310" width="60" height="22" rx="3" fill="#a3e635"/>
<text x="316" y="325.4" font-size="13" fill="currentColor">~75</text>
<text x="242" y="355.4" text-anchor="end" font-size="13" fill="currentColor">npm upgrade pipeline x2</text>
<rect x="250" y="340" width="56" height="22" rx="3" fill="#a3e635"/>
<text x="312" y="355.4" font-size="13" fill="currentColor">~70</text>
<text x="242" y="385.4" text-anchor="end" font-size="13" fill="currentColor">Duration parsing x6</text>
<rect x="250" y="370" width="48" height="22" rx="3" fill="#a3e635"/>
<text x="304" y="385.4" font-size="13" fill="currentColor">~60</text>
<text x="242" y="415.4" text-anchor="end" font-size="13" fill="currentColor">Atomic-write bypasses</text>
<rect x="250" y="400" width="36" height="22" rx="3" fill="#a3e635"/>
<text x="292" y="415.4" font-size="13" fill="currentColor">~45</text>
<text x="242" y="445.4" text-anchor="end" font-size="13" fill="currentColor">Frontmatter splitters x6</text>
<rect x="250" y="430" width="32" height="22" rx="3" fill="#a3e635"/>
<text x="288" y="445.4" font-size="13" fill="currentColor">~40</text>
</svg>

<figcaption>Estimated net production lines removed per cleanup that needs no owner decision. Green: duplicate or dead code folded into an existing owner. Blue: replaced by croner, Node built-ins, fs.cpSync, ora or simple-git. Estimates from the five area scans, re-checked by direct reads where marked confirmed below.</figcaption>
</figure>

<div class="artifact-callout">The largest single lever is not deduplication. It is deciding which migrations and command groups the CLI still owns.</div>

What makes a typical change expensive for a human:

- **Very large files and functions.** `commands/sessions.ts` (6,623 lines),
  `lib/session/db.ts` (5,951), `lib/session/discover.ts` (5,690), `lib/accounting/usage.ts`
  (4,432), `commands/exec.ts` (4,060, where `registerRunCommand` alone is ~3,240 lines from
  `commands/exec.ts:819`).
- **Harness branching outside the registries.** The pattern scan finds 240
  `agent === '…'` style arms; the densest are `lib/exec.ts` (26), `lib/models.ts` (24),
  `lib/plugins/plugins.ts` (20), `lib/session/discover.ts` (19). The repo's chosen pattern
  is a registry entry gated by `capableAgents(...)` (AGENTS.md §Code review conventions).
- **The same helper re-written per file.** Shell quoting exists 13 times (POSIX) plus 3
  (PowerShell); duration parsing 6 times; tmp-file-then-rename JSON writes about 25 times
  beside `lib/fs-atomic.ts`.
- **Comment density.** Comment lines are 38% of code lines. Many are load-bearing
  incident rationale; the ratio says where to look, not what to delete.

## Findings

Estimates are net lines removed after replacement code. **Confirmed** means both
implementations and their callers were read; **candidate** means plausible but not traced
end to end.

### Reductions that need no owner decision

| # | Opportunity | Kind | Est. lines | Status |
|---|---|---|---:|---|
| 1 | `lib/session/__tests__/render.test.ts` + `parse-*.test.ts` (~3,200 lines) only exercise `@phnx-labs/sessions-cli/reader`; that package now owns the parsers. Keep one version-pin contract test here, move the rest to sessions-cli | dead (tests) | ~3,200 test | confirmed |
| 2 | Dead exports: `plugins/skills.ts` install/compare API (`installSkillToVersion`, `skillContentMatches`, …), `versions.ts` `getInstalledVersion` + local `skillDirsMatch`/`copyDir`, 9 unused `state.ts` path aliases, `permissions.ts` `*ToCanonical` (test-only), `device-config.ts:1182-1286` auto-launch helpers, `git.ts` `initRepo` (and test-only `getTrackedFiles`), `crabbox/runtimes.ts` `pickRuntimes`, `remote-list.ts` `parseRemoteList`, and others | dead | ~480 | confirmed |
| 3 | `lib/feed/activity.ts`: 14 of 26 exports have no production caller outside the file; they are leftovers of the `agents activity` command removed in c3e792dd0 | dead | ~220 | confirmed |
| 4 | Cloudflare provisioning twice: `session/sync/worker-template.ts:813` and `traces/worker-template.ts:279` share `defaultVerifyPhoenixToken`/`json()`/`authorizeRead`; `session/sync/provision.ts:52` "mirrors" `traces/provision.ts:45` | duplicate | ~170 | confirmed |
| 5 | Two SSH transport stacks: `devices/connect.ts:397` `buildSshInvocation` spawned by hand at 4 sites vs `ssh-exec.ts` `sshExec*`; `-i … IdentitiesOnly=yes` hand-built at 19 sites | duplicate | ~180 | confirmed |
| 6 | Shell quoting: 13 POSIX copies (e.g. `teams/agents.ts:258`, `daemon/runner.ts:951`, `installations/shims.ts:295`) and 3 PowerShell copies (`pwsh.ts:17`, `hosts/remote-cmd.ts:273`, `devices/connect.ts:146`); `-EncodedCommand` wrapper inline 17 times. Owners: `ssh-exec.ts` (add always-quote variant) and `pwsh.ts` | duplicate | ~125 | confirmed |
| 7 | Daemon services: both base classes in `daemon/service.ts:108,149` declare `onStart`/`onStop` abstract, forcing 34 empty overrides, and copy the same lifecycle code | duplicate | ~110 | confirmed |
| 8 | Four staleness directory checkers (`staleness/checkers/{skills,subagents,workflows,plugins}.ts`) are one template differing by marker file | duplicate | ~110 | candidate |
| 9 | MCP config written by two paths (`agent-spec/agents.ts:2906-2976` and `mcp.ts:619` `writeMcpConfig`); `stripJsonComments` defined twice (`agents.ts:3009`, `permissions-registry.ts:155`) | duplicate | ~105 | candidate / confirmed |
| 10 | npm upgrade pipeline twice: `bootstrap.ts:351,382` vs `daemon/self-update-service.ts:125,163`; move both into `lib/self-update.ts` | duplicate | ~70 | confirmed |
| 11 | Duration / `--since` parsing in 6 places (`commands/logs.ts:192`, `commands/events.ts:72`, `commands/mailboxes.ts:120`, `monitors/config.ts:232`, `scheduling/routines.ts:1928`, `hooks/cache.ts:56`); the three `parseSince` copies are byte-identical | duplicate | ~45-70 | confirmed |
| 12 | ~25 hand-rolled tmp+rename writes bypass `lib/fs-atomic.ts` (e.g. `monitors/state.ts:101`, `mailbox.ts:207`) | duplicate | ~45 | confirmed |
| 13 | Six YAML frontmatter fence splitters (`plugins/skills.ts:120`, `subagents.ts:43`, `workflows.ts:167,1018,1094`, `commands.ts:165`) | duplicate | ~40 | candidate |
| 14 | GitHub helpers: owner/repo parsing 4x and origin-URL reads 7x (owner: `git.ts`); hardened `gh` env twice (`github/pr-mergeable.ts:44`, `gh-overload.ts:121`) with 9 raw `gh` call sites skipping it; `parseNdjson` twice | duplicate | ~75 | confirmed |
| 15 | Small helpers re-defined: `percentile` (`analytics/recipes.ts:38` copies `lib/percentile.ts`; `traces/sync.ts:544` = `traces/segments.ts:400`), Levenshtein 3x (owner `lib/fuzzy.ts`), `compareVersions` 3x (owner `agent-spec/primitives.ts:42`), `mapBounded` 3x (owner `lib/concurrency.ts:24`), `skillDirsMatch` 2x, run-mode parsing 5x, `getGitRoot`/`hasUncommittedChanges` re-implemented in `teams/worktree.ts` | duplicate | ~200 | confirmed |
| 16 | Eight `lib/session/*` re-export shims (`width.ts`, `short-id.ts`, …) kept "so existing importers don't break" | dead | ~30 | confirmed |

### Hand-rolled code a stable library or built-in replaces

Prefer built-ins and dependencies already in `cli/package.json`. Each was checked against
the installed version, not a package name.

| Custom code | Replacement | Est. lines | Evidence |
|---|---|---:|---|
| `alignedSlotForFire` walks cron windows by hand; one-shot schedule timezone math rests on a "croner has no year" comment | `croner` 10.0.1 (installed) `previousRuns(1, ref)` and 7-part patterns | ~80 | ran `new Cron('0 9 * * 1-5').previousRuns(1, 2026-10-04T12:00Z)` → `2026-10-02T09:00Z` |
| 6 `sleep` helpers + 28 inline `new Promise(r => setTimeout(r, ms))` | `node:timers/promises` `setTimeout` (abortable) | ~15 | `commands/watchdog.ts:148`, `lib/concurrency.ts:20`, … |
| Three recursive `copyDir`/`removePath` pairs | `fs.cpSync(src, dest, { recursive, filter })`, already used at `plugins/skills.ts:311` | ~45 | `staleness/writers/skills.ts:20`, `writers/hooks.ts:18`, `agent-spec/materialize.ts:56` |
| Crabbox spinner (`crabbox/progress.ts:74-152`) | `ora` 9.4.1, already used in 23 files | ~45 | single caller `commands/exec.ts:1884` |
| ANSI stripping for parsing CLI stdout (`auth-mint.ts:138`, inline regexes in `models.ts`) | `node:util` `stripVTControlCharacters` | ~25 | layout code keeps `lib/text/width.ts` |
| Hand-rolled PATH walk `models.ts:290`; `which` in `cloud/codex.ts:27`, `cloud/factory.ts:46` | existing `lib/platform/exec.ts:37` `findExecutable` | ~30 | `which` is POSIX-only |
| Raw `git` spawns in `teams/worktree.ts`; deadline `Promise.race` timers | `simple-git` (installed); `AbortSignal.timeout()` | ~30 | `fanOutDevices` deadline timer is never cleared |

Evaluated and **rejected**: `semver` (would invert OpenClaw's `-N` rebuild suffix that
`primitives.compareVersions` handles), `jsonc-parser` (accepts trailing commas that today's
parse rejects), `gray-matter` (`yaml` already parses the block; the fence is ~15 lines),
`ms`/`parse-duration` (no compound `1h30m` with a cap), `string-width`/`strip-ansi` (would
lose OSC-8 hyperlink safety in `text/width.ts`). `cronstrue` could replace `humanizeCron`
(~70 lines) but adds a dependency and changes wording: an owner choice.

### Owner decisions (not cleanups)

| Item | Lines | Why it is a decision |
|---|---:|---|
| PHNX-4227: remove `agents sessions` (and browser/computer/secrets) groups | ~8,000+ | in progress; AGI EXT and the menubar still consume `sessions watch --json` |
| `lib/accounts/migrate.ts` v2 account-slot migration | 805 | still wired to `agents accounts migrate` and runs on every upgrade (`installations/migrate.ts:2202`) |
| `lib/devices/config-migration.ts` legacy device stores | 512 | runs from `device-config.ts:42`, `daemon.ts:996`, `installations/migrate.ts:20`; safe once the fleet has converged |
| Three daemon/scheduling migration shims | ~270 | same convergence question |
| `routines scheduler-logs` duplicates `daemon logs` | ~25 | removes a user-facing command |
| Duration/age formatters (7 variants: `1m 20s` vs `1m20s`) | ~30 | changes user-visible text |

### Correctness issues found along the way

Not the purpose of this report; listed so they are not lost.

- `cloud/codex.ts:46` `runCodex` has no `'error'` handler, so a spawn failure leaves its
  promise pending forever (confirmed by reading).
- Raw `gh` call sites `JSON.parse` output that `FORCE_COLOR` can paint, the failure mode
  documented at `github/pr-mergeable.ts:38`.
- `mailbox.ts:207` writes to `${dest}.tmp`, which is not unique per process.
- The daemon start lock and the feed answer-release token share a create-exclusive +
  stale-reclaim pattern that may let two reclaimers both win. Not reproduced.

## Evidence

**Scope.** `cli/` at commit `4b709a7e5`, assessed in a clean worktree
(`.agents/worktrees/cli-health-refresh`). Other packages, most of `scripts/`, and the
companion repos were not assessed. Uncommitted changes: none in the assessed tree before
this report edit.

**Counts.** `cloc 2.06` via `bunx cloc`, TypeScript only, over `git ls-files` list files:

- production: `cli/src/**/*.ts{,x}` excluding `*.test.ts`, `*.bench.ts`, `__tests__/`,
  `testdata/` → 806 files, 193,077 code / 74,358 comment / 21,688 blank.
- tests: `cli/**/*.test.ts{,x}` and `__tests__/` → 1,041 files, 185,262 code
  (`--timeout 0`).

Delta vs first baseline (`6143f3743`): +1 production file, +486 code, +175 comment,
+54 blank; +12 test files, +2,088 test code. Largest physical files unchanged in rank:
`commands/sessions.ts` (6,622), `lib/session/db.ts` (5,950), `lib/session/discover.ts`
(5,690), `lib/accounting/usage.ts` (4,432), `commands/exec.ts` (4,060).

**Scanners.** Prior assessment used `refactor/modules.ts` (depth 2), `refactor/patterns.ts`
(825 files scanned, 77 unparsed, 95 discriminator families, 1,740 collapsible arms), and
`review/signatures.ts` (38 candidate clusters). This refresh re-ran modules + cloc and
spot-checked findings with `rg`/direct reads. Pattern families are keyed by variable name,
so the 240 `agent` arms are a pointer for inspection, not a count of registry bypasses
(exact `agent === '…'` matches are fewer).

**Area scans.** Five read-only scans from the first baseline (against `6143f3743`), reused
after spot-check because intervening diffs are localized:

| Area | Agent | Non-test lines |
|---|---|---:|
| Resource install/sync (installations, agent-spec, plugins, hooks, rules, staleness, mcp, permissions) | grok | 40,672 |
| Sessions + traces (`lib/session`, `commands/sessions*.ts`, `lib/traces`, view, inspect) | cursor | ~45,000 |
| Execution + fleet fan-out (exec, teams, hosts, devices, fleet, ssh, tmux, terminal) | claude | 41,968 |
| Daemon + scheduling (daemon, feed, monitors, scheduling, triggers, watchdog, menubar) | claude | 35,128 |
| Accounts, cloud, release plumbing + repo-wide utility sweep | claude | 28,967 |

Re-checked on `4b709a7e5`: shellQuote still defined in ≥8 places (owner
`lib/ssh-exec.ts:43`); `parseSince` still duplicated in `logs.ts`/`events.ts`; Cloudflare
`authorizeRead`/`defaultVerifyPhoenixToken` still in both worker templates; `buildSshInvocation`
still parallel to `ssh-exec`; reader-only `lib/session/__tests__/parse-*.test.ts` +
`render.test.ts` still import `@phnx-labs/sessions-cli/reader`; `gen-command-index.ts` is
now 35 lines (extraction landed — positive precedent, not a new cleanup item).

**Not covered.** Internals of `lib/session/db.ts` and `discover.ts`; per-provider
fetchers inside `accounting/usage.ts`; per-harness registrars in `hooks/install.ts`;
`runner.ts` `executeJob*` variants; inline retry loops. The five standalone-CLI clients
(`artifacts-`, `browser-`, `computer-`, `secrets-`, `sessions-client.ts`)
repeat the same resolve/`invocation`/error-class skeleton; PHNX-4227 changes most of them,
so no estimate is given. No test suite was run; nothing here changes behavior.
