---
kind: report
title: Component Health
updated: 2026-10-09
commit: ef9ff0d5b507f30afab80ec61723a8271012e1bf
---

# cli — Component Health

## Summary

`cli/` is the `agents` CLI: it installs agent harnesses into isolated version homes, syncs
resources into each harness's native format, runs agents locally or over SSH, and keeps a
daemon that indexes sessions, schedules routines and watches for stalls. Its shape problem
in one sentence: **per-harness knowledge is spread across about ten files instead of the
registries that already exist, and small helpers are re-written per file instead of
imported from their owners.**

`cli/src` holds **194,628 lines of production code** in 811 files and **184,346 test code
lines** in 1,052 files. No size budget has been agreed, so this is a baseline, not a
pass/fail. Since the previous baseline (`6143f3743`, 2026-10-04) the diff shows 107,203
deleted lines, but **production code grew by 2,037 lines**: the deletions were comments
(74,183 → 1,719 under the repo's comment ceiling in `scripts/comment-budget.json`), the
removed `monitors` group (PHNX-4241) and PHNX-4267's retired command groups. None of the
sixteen 2026-10-04 findings is fully fixed.

<div class="artifact-grid artifact-grid-3">
<div class="artifact-stat"><div class="artifact-stat-value">194,628</div><div class="artifact-stat-label">production code lines (811 files), +2,037 since 10-04</div></div>
<div class="artifact-stat"><div class="artifact-stat-value">~1,500</div><div class="artifact-stat-label">dead production lines: 8 unimported files + dead exports</div></div>
<div class="artifact-stat"><div class="artifact-stat-value">~1,300</div><div class="artifact-stat-label">duplicate lines folded into an existing owner</div></div>
<div class="artifact-stat"><div class="artifact-stat-value">278</div><div class="artifact-stat-label">literal harness-name branches outside the registries</div></div>
<div class="artifact-stat"><div class="artifact-stat-value">~10</div><div class="artifact-stat-label">files edited to add one harness</div></div>
<div class="artifact-stat"><div class="artifact-stat-value">6</div><div class="artifact-stat-label">confirmed correctness bugs found along the way</div></div>
</div>

<figure class="artifact-figure">
<svg class="artifact-diagram" viewBox="0 0 1000 670" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="C4 container view of the agents CLI with numbered finding markers">
<defs>
<marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker>
</defs>
<g fill="currentColor">
<rect x="10" y="65" width="175" height="62" rx="8" fill="none" stroke="#60a5fa" stroke-width="2"/>
<text x="22" y="86" font-size="12" font-weight="700">Operator [Person]</text>
<text x="22" y="103" font-size="11">terminal user or agent;</text>
<text x="22" y="117" font-size="11">sends argv over a TTY</text>
<rect x="10" y="145" width="175" height="92" rx="8" fill="none" stroke="#a1a1aa" stroke-width="2"/>
<text x="22" y="166" font-size="12" font-weight="700">AGI EXT · AGI Menu</text>
<text x="22" y="181" font-size="11">[External system, own repos]</text>
<text x="22" y="198" font-size="11">reads watch --json NDJSON</text>
<text x="22" y="212" font-size="11">from stdout; receives inject</text>
<text x="22" y="226" font-size="11">via editor URI</text>
<rect x="205" y="30" width="430" height="625" rx="10" fill="none" stroke="currentColor" stroke-dasharray="7 5" stroke-width="1.5"/>
<text x="217" y="50" font-size="12" font-weight="700">agents CLI [Software system: cli/src]</text>
<rect x="225" y="65" width="395" height="110" rx="8" fill="none" stroke="#a3e635" stroke-width="2"/>
<text x="238" y="88" font-size="12" font-weight="700">CLI process</text>
<text x="238" y="104" font-size="11">[Container: Node 24 / Bun, commander]</text>
<text x="238" y="122" font-size="11">61 command groups, 483 commands; one exec</text>
<text x="238" y="137" font-size="11">engine (buildExecEnv → execAgent); harness</text>
<text x="238" y="152" font-size="11">registries AGENTS, HarnessAdapter, AGENT_COMMANDS</text>
<rect x="225" y="215" width="185" height="100" rx="8" fill="none" stroke="#a3e635" stroke-width="2"/>
<text x="237" y="238" font-size="12" font-weight="700">Version homes, shims</text>
<text x="237" y="254" font-size="11">[Container: dirs + bash]</text>
<text x="237" y="272" font-size="11">per-harness HOME swap;</text>
<text x="237" y="286" font-size="11">generated launcher scripts</text>
<text x="237" y="300" font-size="11">in .cache/shims</text>
<rect x="435" y="215" width="185" height="100" rx="8" fill="none" stroke="#a3e635" stroke-width="2"/>
<text x="447" y="238" font-size="12" font-weight="700">State dir ~/.agents</text>
<text x="447" y="254" font-size="11">[Container: JSON/YAML files]</text>
<text x="447" y="272" font-size="11">routines, teams, devices,</text>
<text x="447" y="286" font-size="11">.history, .cache; paths</text>
<text x="447" y="300" font-size="11">owned by lib/state.ts</text>
<rect x="225" y="365" width="185" height="105" rx="8" fill="none" stroke="#a3e635" stroke-width="2"/>
<text x="237" y="388" font-size="12" font-weight="700">Daemon</text>
<text x="237" y="404" font-size="11">[Container: same binary,</text>
<text x="237" y="418" font-size="11">__daemon-run]; started by</text>
<text x="237" y="432" font-size="11">CLI spawn + pid files</text>
<text x="237" y="450" font-size="11">22 services: index, routines</text>
<text x="237" y="464" font-size="11">runner, watchdog, self-update</text>
<rect x="435" y="365" width="185" height="105" rx="8" fill="none" stroke="#ef4444" stroke-dasharray="6 4" stroke-width="2"/>
<text x="447" y="388" font-size="12" font-weight="700">Unwired lib modules</text>
<text x="447" y="404" font-size="11">[Retired: no importers]</text>
<text x="447" y="422" font-size="11">1Password reader, OpenClaw</text>
<text x="447" y="436" font-size="11">keychain, hook matcher,</text>
<text x="447" y="450" font-size="11">template, +4 more</text>
<text x="447" y="464" font-size="11">(8 files, ~920 lines)</text>
<path d="M225,537 a92,11 0 0,0 185,0 v85 a92,11 0 0,1 -185,0 z" fill="none" stroke="#a3e635" stroke-width="2"/>
<ellipse cx="317.5" cy="537" rx="92.5" ry="11" fill="none" stroke="#a3e635" stroke-width="2"/>
<text x="317" y="575" font-size="12" font-weight="700" text-anchor="middle">sessions.db</text>
<text x="317" y="592" font-size="11" text-anchor="middle">[SQLite: bun:sqlite /</text>
<text x="317" y="606" font-size="11" text-anchor="middle">node:sqlite]</text>
<rect x="435" y="530" width="185" height="100" rx="8" fill="none" stroke="#a3e635" stroke-width="2"/>
<text x="447" y="553" font-size="12" font-weight="700">Feed hub</text>
<text x="447" y="569" font-size="11">[Container: unix socket]</text>
<text x="447" y="587" font-size="11">event envelopes for</text>
<text x="447" y="601" font-size="11">agents feed watch</text>
<rect x="700" y="40" width="290" height="56" rx="8" fill="none" stroke="#a1a1aa" stroke-width="2"/>
<text x="712" y="60" font-size="12" font-weight="700">Harness binaries</text>
<text x="712" y="76" font-size="11">claude, codex, … · spawn with isolated</text>
<text x="712" y="90" font-size="11">env + argv; pty or tmux pane</text>
<rect x="700" y="106" width="290" height="56" rx="8" fill="none" stroke="#a1a1aa" stroke-width="2"/>
<text x="712" y="126" font-size="12" font-weight="700">Standalone CLIs</text>
<text x="712" y="142" font-size="11">secrets, browser, computer, sessions, …</text>
<text x="712" y="156" font-size="11">spawn; JSON over fd3/fd4 or stdout</text>
<rect x="700" y="172" width="290" height="56" rx="8" fill="none" stroke="#a1a1aa" stroke-width="2"/>
<text x="712" y="192" font-size="12" font-weight="700">Fleet devices</text>
<text x="712" y="208" font-size="11">remote agents commands · ssh with</text>
<text x="712" y="222" font-size="11">ControlMaster; PowerShell on Windows</text>
<rect x="700" y="238" width="290" height="56" rx="8" fill="none" stroke="#a1a1aa" stroke-width="2"/>
<text x="712" y="258" font-size="12" font-weight="700">GitHub</text>
<text x="712" y="274" font-size="11">PR, checks, releases · gh api (REST),</text>
<text x="712" y="288" font-size="11">some gh --json (GraphQL); HTTPS</text>
<rect x="700" y="304" width="290" height="56" rx="8" fill="none" stroke="#a1a1aa" stroke-width="2"/>
<text x="712" y="324" font-size="12" font-weight="700">npm registry · unpkg</text>
<text x="712" y="340" font-size="11">latest version, CHANGELOG · HTTPS;</text>
<text x="712" y="354" font-size="11">self-install · spawn npm i -g</text>
<rect x="700" y="370" width="290" height="56" rx="8" fill="none" stroke="#a1a1aa" stroke-width="2"/>
<text x="712" y="390" font-size="12" font-weight="700">Rush API</text>
<text x="712" y="406" font-size="11">cloud runs, transcripts, traces link,</text>
<text x="712" y="420" font-size="11">owner notify · HTTPS REST</text>
<rect x="700" y="436" width="290" height="56" rx="8" fill="none" stroke="#a1a1aa" stroke-width="2"/>
<text x="712" y="456" font-size="12" font-weight="700">Cloudflare API · R2</text>
<text x="712" y="472" font-size="11">Worker deploy, secrets · HTTPS REST;</text>
<text x="712" y="486" font-size="11">session bundles · HTTPS SigV4</text>
<rect x="700" y="502" width="290" height="56" rx="8" fill="none" stroke="#a1a1aa" stroke-width="2"/>
<text x="712" y="522" font-size="12" font-weight="700">Linear API</text>
<text x="712" y="538" font-size="11">project issue counts, read only ·</text>
<text x="712" y="552" font-size="11">HTTPS GraphQL</text>
<rect x="700" y="568" width="290" height="56" rx="8" fill="none" stroke="#a1a1aa" stroke-width="2"/>
<text x="712" y="588" font-size="12" font-weight="700">Tailscale</text>
<text x="712" y="604" font-size="11">device list, whois · spawn</text>
<text x="712" y="618" font-size="11">tailscale status/whois --json</text>
<g stroke="currentColor" stroke-width="1.3" fill="none">
<line x1="185" y1="96" x2="223" y2="96" marker-end="url(#ah)"/>
<line x1="185" y1="160" x2="223" y2="160" marker-end="url(#ah)"/>
<line x1="223" y1="170" x2="187" y2="185" marker-end="url(#ah)"/>
<line x1="317" y1="175" x2="317" y2="213" marker-end="url(#ah)"/>
<line x1="527" y1="175" x2="527" y2="213" marker-end="url(#ah)"/>
<path d="M232,175 V190 H215 V418 H223" marker-end="url(#ah)"/>
<line x1="317" y1="470" x2="317" y2="524" marker-end="url(#ah)"/>
<line x1="400" y1="470" x2="455" y2="528" marker-end="url(#ah)"/>
<path d="M380,365 V340 H660"/>
<path d="M620,120 H660"/>
<line x1="660" y1="68" x2="660" y2="596"/>
<line x1="660" y1="68" x2="698" y2="68" marker-end="url(#ah)"/>
<line x1="660" y1="134" x2="698" y2="134" marker-end="url(#ah)"/>
<line x1="660" y1="200" x2="698" y2="200" marker-end="url(#ah)"/>
<line x1="660" y1="266" x2="698" y2="266" marker-end="url(#ah)"/>
<line x1="660" y1="332" x2="698" y2="332" marker-end="url(#ah)"/>
<line x1="660" y1="398" x2="698" y2="398" marker-end="url(#ah)"/>
<line x1="660" y1="464" x2="698" y2="464" marker-end="url(#ah)"/>
<line x1="660" y1="530" x2="698" y2="530" marker-end="url(#ah)"/>
<line x1="660" y1="596" x2="698" y2="596" marker-end="url(#ah)"/>
</g>
<text x="322" y="198" font-size="10">exec, swapped HOME</text>
<text x="532" y="198" font-size="10">read/write files</text>
<text x="322" y="500" font-size="10">SQL upserts, queries</text>
<text x="440" y="505" font-size="10">events</text>
<text x="600" y="333" font-size="10">to bus</text>
<g font-size="11" font-weight="700" text-anchor="middle">
<circle cx="562" cy="65" r="10" fill="#f59e0b"/><text x="562" y="69" fill="#0a0a0a">1</text>
<circle cx="586" cy="65" r="10" fill="#f59e0b"/><text x="586" y="69" fill="#0a0a0a">3</text>
<circle cx="610" cy="65" r="10" fill="#f59e0b"/><text x="610" y="69" fill="#0a0a0a">8</text>
<circle cx="400" cy="215" r="10" fill="#f59e0b"/><text x="400" y="219" fill="#0a0a0a">1</text>
<circle cx="610" cy="215" r="10" fill="#f59e0b"/><text x="610" y="219" fill="#0a0a0a">5</text>
<circle cx="400" cy="365" r="10" fill="#f59e0b"/><text x="400" y="369" fill="#0a0a0a">2</text>
<circle cx="610" cy="365" r="10" fill="#f59e0b"/><text x="610" y="369" fill="#0a0a0a">6</text>
<circle cx="980" cy="106" r="10" fill="#f59e0b"/><text x="980" y="110" fill="#0a0a0a">4</text>
<circle cx="980" cy="172" r="10" fill="#f59e0b"/><text x="980" y="176" fill="#0a0a0a">7</text>
<circle cx="980" cy="238" r="10" fill="#f59e0b"/><text x="980" y="242" fill="#0a0a0a">7</text>
<circle cx="980" cy="304" r="10" fill="#f59e0b"/><text x="980" y="308" fill="#0a0a0a">5</text>
<circle cx="980" cy="370" r="10" fill="#f59e0b"/><text x="980" y="374" fill="#0a0a0a">5</text>
<circle cx="980" cy="436" r="10" fill="#f59e0b"/><text x="980" y="440" fill="#0a0a0a">7</text>
</g>
<rect x="10" y="480" width="175" height="150" rx="6" fill="none" stroke="currentColor" stroke-width="1"/>
<text x="22" y="500" font-size="12" font-weight="700">Legend</text>
<rect x="22" y="510" width="20" height="12" fill="none" stroke="#a3e635" stroke-width="2"/><text x="50" y="520" font-size="11">container</text>
<rect x="22" y="530" width="20" height="12" fill="none" stroke="#a1a1aa" stroke-width="2"/><text x="50" y="540" font-size="11">external system</text>
<rect x="22" y="550" width="20" height="12" fill="none" stroke="#60a5fa" stroke-width="2"/><text x="50" y="560" font-size="11">person</text>
<rect x="22" y="570" width="20" height="12" fill="none" stroke="#ef4444" stroke-dasharray="4 3" stroke-width="2"/><text x="50" y="580" font-size="11">retired / unused</text>
<line x1="22" y1="598" x2="42" y2="598" stroke="currentColor" stroke-width="1.3" marker-end="url(#ah)"/><text x="50" y="602" font-size="11">flow (label = what, how)</text>
<circle cx="32" cy="618" r="8" fill="#f59e0b"/><text x="32" y="622" font-size="11" font-weight="700" text-anchor="middle" fill="#0a0a0a">n</text><text x="50" y="622" font-size="11">finding number</text>
</g>
</svg>
<figcaption>C4 container view (level 2) of <code>cli/src</code> at <code>ef9ff0d5b</code>, traced from code (spawn sites, fetch URLs, SQLite and socket owners), not docs. Flows to the left-hand and right-hand systems are described inside each box. The CLI and daemon reach every external system through one bus, and both read and write <code>sessions.db</code> (one arrow drawn). The daemon has no control socket: its lifecycle is spawn plus pid and heartbeat files. Omitted: Worker internals, per-service daemon detail, the session-tracker hook package.</figcaption>
</figure>

<div class="artifact-callout">The highest-leverage change is not deleting duplicates. It is making the harness registries carry the per-harness decisions that ~278 inline branches make today, so adding a harness touches one entry instead of about ten files.</div>

What makes a typical change expensive for a human:

- **Adding or changing a harness** touches `types.ts`, `agent-spec/agents.ts`, an adapter,
  the `exec.ts` arms, `shims.ts` twice, `models.ts`, `permissions.ts`, `hooks/install.ts`
  twice, a `discover.ts` scanner, a `usage.ts` probe and the daemon runner.
- **Very large files.** `lib/session/db.ts` (4,097 code lines), `lib/session/discover.ts`
  (3,951), `commands/sessions.ts` (3,574), `commands/exec.ts` (2,930, one `.action`
  closure of ~2,200 lines from `commands/exec.ts:918`), `lib/accounting/usage.ts` (2,790),
  `lib/hooks/install.ts` (2,579). `lib/installations/versions.ts` (2,392) has the most
  importers (80).
- **Library code lives in command files.** Four `lib/` modules dynamically import
  `commands/`, which closes a 48-module import cycle through `lib`.
- **The same helper re-written per file.** Shell quoting 13 times, tmp+rename writes 28
  times beside `lib/fs-atomic.ts`, frontmatter splitting 14 times, `--since` parsing 6
  ways, standalone-CLI binary resolution 7 times.

## Findings

Estimates are net production lines removed after replacement code. **Confirmed** means the
implementations and callers were read; **candidate** means plausible but not traced end to
end. Numbers match the markers in the figure.

### 1. Harness dispatch bypasses the registries that exist (confirmed, ~400-450)

Three overlapping per-agent registries exist: `AGENTS` (data, `lib/agent-spec/agents.ts:250`),
`HarnessAdapter` (behavior, `lib/harness/adapter.ts`; 9 of 15 agents have one) and
`AGENT_COMMANDS` (`lib/exec.ts:445`), plus about 25 `Partial<Record<AgentId,…>>` tables.
Production code still has **278 literal agent-name arms**.

| Where | What bypasses the registry | Registry fix | Est. |
|---|---|---|---:|
| `lib/permissions.ts:1140-1439` | `applyPermissionsToVersion`, ~300 lines of `if (agentId === …)` for 11 agents; more dispatch at `:945`, `:1105`, `:1674-1730` | add `fromCanonical`/`write` to `PermissionTarget` (`permissions-registry.ts:281`, read-only today) | ~150 |
| `lib/hooks/install.ts:1475-1555` | two parallel 12-arm switches over the same agents | one `HOOK_TARGETS` table, the `SUBAGENT_TARGETS` pattern | ~60 |
| `lib/exec.ts:642-810` | `buildExecCommand` reads `AGENT_COMMANDS`, then special-cases ~10 agents (subcommand drop, session-id flag, reasoning-flag position, prompt flag) | template fields on `AGENT_COMMANDS` | ~60 |
| `lib/models.ts:111-199, 733-743, 935-952` | model source, catalog extractor and effort flags per agent | adapter `models` hook or the existing `NATIVE_MODEL_CONFIGS` (`:848`) | ~60 |
| `lib/installations/shims.ts:812-945` | `generateVersionedAliasScript` re-copies adapter `shimConfigEnvBash` blocks and the binary resolution from `generateShimScript` (`:402-460`); the copy has already drifted (no `adopted_original_bin`, no self-shim guard) | one adapter `shimResolveBinary` hook | ~110 |

Related config drift: "which agents can resume" is three different lists
(`lib/session/recovery.ts:24`, `lib/scheduling/routines.ts:844`, `lib/watchdog/rotate.ts:271`);
the teams agent set is stated four times (`lib/teams/parsers.ts:3`, `lib/teams/agents.ts:212`,
`commands/teams.ts:103,115`); `AGENTS[*].sessionDir` has no reader while
`lib/daemon/runner.ts:413-425` keeps a more complete transcript-path table, so the registry
field is the stale one. Fix: capability flags (`resumable`, `teams`, `sessionRoots`) read via
`capableAgents()`.

### 2. The daemon runner keeps a second exec path (confirmed command builder, candidate env; ~60)

`lib/daemon/runner.ts:462` `buildJobCommand` builds argv in parallel to `buildExecCommand`
and already diverges: codex reasoning flags are spliced at index 1 by `exec.ts:694` but
appended by the routine path. `buildRoutineSpawnEnv` (`runner.ts:1014-1023`) re-copies the
Claude adapter's credential policy (`lib/harness/adapters/claude.ts:12-30`) because
`buildExecEnv` spreads `...options.env` (`exec.ts:401`) after the adapter runs
(`exec.ts:323`). Apply the adapter last, then delete the copy. The runner also hand-writes
SIGTERM→SIGKILL at four spawn sites (`:1052, :1563, :1755, :1852`).

### 3. Library logic lives in command files (confirmed; structural)

| File | Library logic it holds | In flight? |
|---|---|---|
| `commands/sessions.ts` | query scoring, resume argv, fleet metadata, Claude history; 14 commands import it | yes: PHNX-4227 PRs #3824, #3826, #3827, #3835 move ~3,000 lines out |
| `commands/exec.ts` | `resolveRunCwd` `:483`, `runWorkflowForEach` `:396`, always-fresh repos `:310-319`, `computeNetMode` `:291` | no |
| `commands/teams.ts` | snapshot/classify `:966-1180`, PR-watch state IO `:565-618`, one ~400-line action `:1553-1956` | no |
| `commands/ssh.ts` | fleet probes `probeRemoteHarnesses` `:840`, `collectFleetHarnesses` `:857`; ~1,040-line `registerDevicesCommands` | no |

Upward imports that close the import cycle: `lib/smart-launch.ts:150` → `commands/ssh.js`;
`lib/snapshot.ts:111-112` → `commands/view.js`, `commands/ps-roster.js`;
`lib/accounts/migrate.ts:245` → `commands/view.js`; `lib/accounts/add.ts:622` →
`commands/utils.js` (a pass-through re-export of `lib/format.ts:90` that ~31 files import).
Moving those four functions into `lib/` breaks the cycle.

### 4. Standalone-CLI clients repeat one skeleton (confirmed, ~120)

Binary resolution (env override → `findInPath` → cache → hint error) is written 7 times
(`artifacts-client.ts:18`, `secrets-client.ts:141`, `sessions-client.ts:54`,
`browser-client.ts:39`, `computer-client.ts:48`, `term-client.ts:13`,
`recordings/transcode.ts:18`); `invocation()` 5 times; 5 near-identical `*ClientError`
classes. `browser-client.ts` and `computer-client.ts` share a ~110-line resolve/spawn/fd4
event skeleton. Two passthroughs exit with `res.status ?? 1` and lose signals
(`commands/secrets-passthrough.ts:41-50`, `index.ts:146-153`). What remains: one
`lib/standalone-cli.ts`. Size after #3820 (secrets client) and #3835 merge.

### 5. Hardcoded config that bypasses its owner (confirmed, ~250 + 4 bugs)

Most configuration has a single owner (`STANDALONE_TOOL_PINS`, `SSH_OPTS`,
`helper-versions.ts`, `RUSH_API_BASE`, `model-tiers.ts`, `prices.json`). The problems are
sites that skip it:

| Value | Owner | Bypassing sites | Consequence |
|---|---|---|---|
| `process.env.AGENTS_REAL_HOME \|\| os.homedir()` | none; should be `lib/state.ts` | 16 exact copies in 9 files (e.g. `accounting/usage.ts:988`, `agent-spec/agents.ts:1059`, `daemon/runner.ts:713`); three disagreeing `realHome()` helpers (`uninstall.ts:58`, `sandbox.ts:12`, `mcp-registry.ts:5`, the last returns the version home) | wrong-home reads |
| `~/.agents/...` paths | `lib/state.ts` getters | `watchdog/log.ts:6` ignores `AGENTS_LOGS_DIR`; `daemon/leaked-daemons.ts:9` ignores `AGENTS_DAEMON_DIR`; ~10 more sites | **bug**: env override ignored |
| Rush API base | `lib/rush-api.ts:1` | `traces/sync.ts:217` hard-codes the traces URL; `feed-broadcast.ts:149` a console URL | **bug**: `RUSH_PROXY_BASE` ignored |
| npm package / repo slug | `lib/self-update.ts:14`, `helper-download.ts:11` | `bootstrap.ts:164,398`; `menubar/resolve-version.ts:10`; `star-nudge.ts:7`; same YAML header 4x in `installations/migrate.ts`; menubar bundle id 3x; three npm "latest" fetchers (`bootstrap.ts:254,398`, `daemon/self-update-service.ts:60`) | drift risk |
| sessions-cli floors | `lib/standalone-tools.ts:14-20` | `sessions-client.ts:11,13` floors `0.2.0`/`0.2.1` below the pinned `0.5.0` | **dead gates** |
| Org-specific data in the published CLI | user config | `factory/snapshot.ts:14-20` hard-codes a private project roster (config already has `per_project`); `factory/snapshot.ts:202` assumes a personal skill path; `watchdog/runner.ts:760` puts the owner's first name into every stall prompt | personal data ships to npm |
| Time units | none | 53 inline day-ms expressions; `HOUR_MS` defined 3x | noise |
| Webhook port, Linear endpoint | `daemon-webhooks.ts:15`, `linear-project-counts.ts:34` | `commands/webhook.ts:12`, `session/discover.ts:433` | drift risk |

Fine as they are: model IDs, named timeouts (251 constants; no same-meaning timeout with two
values), service domains and buckets.

### 6. Dead code (confirmed, ~1,500 production + ~2,850 test)

| Item | Evidence | Est. |
|---|---|---:|
| 8 production files with no production importer (static or dynamic) | `lib/onepassword.ts`, `lib/openclaw-keychain.ts`, `lib/hooks/match.ts`, `lib/version-duplicates.ts`, `lib/artifact-actions.ts`, `lib/template.ts`, `lib/linear-autoclose.ts`, `lib/session/resume-command.ts` | ~920 |
| 33 exports with no reference anywhere, e.g. `installSkillToVersion` + `skillContentMatches` (`plugins/skills.ts:511,321`), `healBrokenDefaultLaunches`, `getInstalledVersion` (`installations/versions.ts:1706,1579`), `removeMcpServerConfig` (`mcp.ts:816`, still in `docs/resource-sync.md`), `getServiceSupervisorHealth` (still in `lib/daemon/AGENTS.md`), `*ToCanonical` (`permissions.ts:1477-1508`), 4 `state.ts` getters, dead `skillDirsMatch`/`copyDir` in `versions.ts` | `ts-unused-exports` + token search | ~400 |
| `lib/feed/activity.ts`: 13 exports with no production use, leftovers of the removed `agents activity` | `:235, :334, :382, :547-723` | ~185 |
| Legacy subagent functions superseded by `subagents-registry.ts` | `lib/subagents.ts:414-466` | ~50 |
| `sshStreamWithArgs` (test-only bridge) | `ssh-exec.ts:238` | ~75 |
| Session tests that only exercise `@phnx-labs/sessions-cli/reader` | `lib/session/__tests__/render.test.ts`, `parse-*.test.ts` (keep the kimi/cursor meta tests and one version-pin test) | ~2,850 test |
| 9 one-line `export *` shims | 8 in `lib/session/`, plus `lib/agents.ts` (~83 importers) | 9 files |

A further **180 exports are referenced only by tests** (~1,800 lines). Each needs a decision
on whether its test guards behavior or keeps dead code alive; they are candidates, not
counted above. Another ~1,900 exports are used only inside their own file (unneeded
`export`, not dead code).

### 7. Duplicate helpers with an existing owner (confirmed, ~1,300)

| Concern | Copies (current file:line) | Owner | Est. |
|---|---|---|---:|
| Atomic writes | 28 hand-rolled tmp+rename sites in ~22 files (e.g. `feed/feed.ts:985`, `project-resources.ts:85`, `mailbox.ts:138`) | `lib/fs-atomic.ts` | ~55 |
| SSH invocation | `buildSshInvocation` spawned by hand at 5 sites; `-i … IdentitiesOnly=yes` built at 17 sites (`teams/agents.ts:698…`, `hosts/dispatch.ts:124,179`); `devices/connect.ts:185-205` builds its own options | `hosts/types.ts:53` `hostIdentityArgs`, `ssh-exec.ts` `SSH_OPTS` | ~100 |
| Shell / PowerShell quoting | 13 POSIX always-quote copies; 3 PowerShell quoters; 3 UTF-16 base64 encoders; `-EncodedCommand` inline at 19 sites | `ssh-exec.ts:21`, `pwsh.ts` | ~70 |
| Frontmatter fences | 14 copies (`workflows.ts` 5x, `subagents.ts` 2x, `command-skills.ts` 2x, `commands.ts:141`, `plugins/skills.ts:104`, `commands/exec.ts:2155`, `commands/inspect.ts:1832`, `convert.ts:11`) | new helper beside `yaml` | ~35 |
| Duration / `--since` | identical copies in `commands/events.ts:43`, `logs.ts:164`, `mailboxes.ts:89`; other grammars at `text/relative-time.ts:63`, `hooks/cache.ts:32`, `scheduling/routines.ts:1283` | `text/relative-time.ts` (make strict) | ~40 |
| GitHub | owner/repo parsing 5x; origin-URL reads 7x bypassing `git.ts:619`; hardened `gh` env 2x; 11 raw `gh` sites; `parseNdjson` 2x; rate-limit regex 2x (`github/project-prs.ts:342` vs `rest.ts:84`) | `lib/github/rest.ts`, `git.ts` | ~90 |
| Cloudflare provisioning | `session/sync/provision.ts` vs `traces/provision.ts`; `defaultVerifyPhoenixToken`/`json` byte-identical across the two worker templates | `lib/cloudflare/provision.ts` | ~90 |
| Daemon service bases | `BasePeriodicService` re-implements `BaseDaemonService` (`daemon/service.ts:41,73`); abstract hooks force 36 empty overrides in 17 files | no-op defaults + `extends` | ~60 |
| Staleness checkers | `staleness/checkers/{skills,subagents,workflows,plugins}.ts` differ only in marker file (diffed) | one factory | ~110 |
| Self-update | metadata fetch and install+relink in `bootstrap.ts:254,285` and `daemon/self-update-service.ts:60,80` | `lib/self-update.ts` | ~50 |
| MCP config | `agent-spec/agents.ts:2064` writer ignores `MCP_TARGETS` formats; `stripJsonComments` 2x (`agents.ts:2130`, `permissions-registry.ts:93`) | `lib/mcp.ts:467` | ~95 |
| Process helpers | `recordings/process.ts:33-106` re-implements `exec-bounded.ts:20`; 4 SIGTERM→SIGKILL copies; 5 `ps -o lstart` + 4 `ps -o etime` copies | `exec-bounded.ts`, `platform/process.ts` | ~120 |
| New in `ps-roster.ts` / `project-prs.ts` | `hostToken`/`shouldIncludeLocal`/`remoteHostsToDial` copied from `feed.ts:215-227`; `shortCwd` from `sessions.ts:401`; `mapBounded` at `project-prs.ts:519` | `feed.ts`, `concurrency.ts` | ~40 |
| Small helpers | `percentile` (2 semantics, 4 copies), Levenshtein 3x, naive `compareVersions` 2x (`bootstrap.ts:152`, `commands/view.ts:190`) that ignore suffixes, `normalizeContent` 4x, sha256 helpers 5x, ~9 home-to-`~` shorteners, `getGitRoot`/`hasUncommittedChanges` in `teams/worktree.ts`, `assertContained` vs `paths.ts:40`, 13 duration formatters, 2 padding modules | `fuzzy.ts`, `primitives.ts:15`, `percentile.ts`, `git.ts`, `text/` | ~250 |
| Rush API fetch wrappers | `cloud/rush.ts:105`, `session/cloud.ts:26`, `owner-notify.ts:119` (differ in 401 handling) | candidate | ~30 |

### 8. Hand-rolled code a built-in or installed library replaces (confirmed, ~250)

Each was checked against the version in `cli/package.json`/`node_modules`.

| Custom code | Replacement | Est. |
|---|---|---:|
| 9 `sleep` helpers + 29 inline `new Promise(r => setTimeout(r, …))` | `node:timers/promises` (zero uses today) | ~25 |
| 4 recursive `copyDir` + 4 `removePath` (`project-resources.ts:306`, `staleness/writers/*`, `agent-spec/materialize.ts:36`) | `fs.cpSync` (already used at 17 sites), `fs.rmSync` | ~50 |
| Crabbox spinner `crabbox/progress.ts:45-106` | `ora` 9.4.1 (already a dependency) | ~55 |
| 9 ANSI-strip regexes, 2 `stripAnsi` defs | `node:util` `stripVTControlCharacters` | ~15 |
| PATH walks `models.ts:216`, `cli-resources.ts:551`, `shims.ts:693`; raw `which` at 5 sites | `platform/exec.ts:13` or `agents.ts:114` `findInPath` (pick one; two exist) | ~35 |
| `alignedSlotForFire` steps up to 20,000 `nextRun`s (`scheduling/routines.ts:1395`) | `croner` 10.0.1 `previousRuns(n, ref)` | ~15 |
| Hand-written TOML at `convert.ts:32-49` (no escaping) | `smol-toml` 1.7.0 `stringify` | ~15 |
| Retry loop at `fs-atomic.ts:121-143` | `proper-lockfile` `retries` (used at 5 sites) | ~20 |
| 3 extra worker pools (`fleet/apply.ts:434`, `bench/runner.ts`, `project-prs.ts:519`) | `concurrency.ts` `mapBounded` | ~25 |

Previously evaluated and still rejected: `semver`, `jsonc-parser`, `gray-matter`, `ms`,
`string-width`/`strip-ansi` (reasons in the 2026-10-04 baseline: each changes accepted input
or loses a guarantee).

### 9. API reference and docs drift (confirmed)

The command reference (`cli/docs/command-reference.html`, linked from `README.md:47`) is
generated from the live commander tree by `cli/scripts/gen-command-index.ts`; `--check`
passed and a regenerated copy is byte-identical (61 groups, 483 commands). CI runs the check
only when `cli/src/commands/**`, `cli/src/cli/**` or the reference inputs change
(`cli/ci/test-ownership.yaml:63-85`), so a `lib/**` or `bootstrap.ts` change can stale it
until the next release. Problems are in the prose around it:

- **No rendered URL.** The README's "searchable HTML page" opens as source on GitHub; the
  homepage domain serves the installer and returns 404 for every reference path probed.
- **Stale command docs:** `agents hosts` (now `agents devices`) taught 21 times in
  `cli/docs/hosts.md` and in `README.md:726-842`; `agents perf` (now `agents insights perf`)
  in `cli/docs/hooks.md:176-224`; `agents focus`/`go` (now `agents ps focus`) at
  `cli/AGENTS.md:1550`, `cli/docs/routines.md:754`.
- **Generator text is wrong:** `gen-command-index.ts:12` says hidden aliases are registered
  in `src/index.ts`; they are in `src/bootstrap.ts:461-532`.
- **Help coverage:** 99 of 174 non-trivial commands have no `examples` block, including
  `routines add` (37 options), `teams add` (19), `harness add/fork/edit`, `logs audit`.
- `agents monitors` was removed without a tombstone in `RETIRED_TOP_LEVEL_COMMANDS`
  (`lib/startup/command-registry.ts:58-62`), so it fails as an unknown command.

### Owner decisions (not cleanups)

| Item | Lines | Why it is a decision |
|---|---:|---|
| PHNX-4227: move `sessions` (and browser/computer/secrets) out | ~3,000+ in flight | open PRs #3824, #3826, #3827, #3835, #3820 |
| Retire one-time migrations (`accounts/migrate.ts`, `devices/config-migration.ts`, daemon shims) | ~1,600 | safe only once the fleet has converged |
| `feed/activity.ts:724-1527`: ~800-line Python hook stored as a `String.raw` constant | 0 net | ship it as a real file with its own tests |
| Duration/age formatter wording (13 variants) | ~30 | changes user-visible text |
| Pick one `percentile` semantics | ~15 | trace statistics would shift |

### Correctness issues found along the way

Not the purpose of this report; listed so they are not lost. All confirmed by reading.

1. `lib/cloud/codex.ts:39-49` `runCodex` listens only for `'close'`; a spawn failure raises
   an unhandled `'error'` and crashes the process (`cloud/factory.ts:47` handles it).
2. `commands/daemon.ts:479`: an unparseable `--since` becomes `0`, so
   `agents daemon logs --since 1week` silently prints nothing.
3. `lib/daemon/daemon.ts:1279` busy-waits (`while (Date.now() < waitUntil) {}`) in
   `waitForPid`; `sleepSync` exists in `fs-atomic.ts`.
4. `lib/auto-pull-worker.ts:37-51` takes its lock with a stat-then-write, no `O_EXCL`; two
   processes can both acquire it (the one-executor rule).
5. `lib/mailbox.ts:138` writes `${dest}.tmp`, not unique per process.
6. `lib/watchdog/log.ts:6` and `lib/daemon/leaked-daemons.ts:9` ignore the
   `AGENTS_LOGS_DIR`/`AGENTS_DAEMON_DIR` overrides; `lib/traces/sync.ts:217` ignores
   `RUSH_PROXY_BASE`.

Also: `github/project-prs.ts:183`, `factory/snapshot.ts:213` and `feed/pr-status.ts:11` use
GraphQL `gh … --json` reads that the repo's REST-only rule forbids.

## Evidence

**Scope.** `cli/` at `ef9ff0d5b` (fresh `origin/main`), assessed in a clean linked worktree.
`packages/*`, the root `scripts/`, and the companion repos were not assessed except where a
finding names them. No uncommitted changes were assessed.

**Counts.** `cloc 2.06` (`npx cloc@2.6.0`), TypeScript only, over `git ls-files`:

- production: `cli/src/**/*.ts{,x}` excluding `*.test.ts`, `*.bench.ts`, `__tests__/`,
  `testdata/` → 811 files, 194,628 code / 1,719 comment / 22,495 blank.
- tests: `cli/**/*.test.ts{,x}` and `__tests__/` → 1,052 files, 184,346 code
  (`--timeout 0`).
- previous baseline at `6143f3743`: 805 files, 192,591 code / 74,183 comment.
- `git diff --shortstat 6143f3743 HEAD -- cli/src`: 1,780 files, +18,560 / −107,203.

**Scanners.** From the `code` skills: `refactor/modules.ts --scope cli/src --depth 2`
(57 modules, 833 parsed / 112 unparsed, 332 edges, 1 cycle, 3 god modules, 5 upward
imports); `refactor/patterns.ts` (96 discriminator families, 1,648 collapsible arms; the
`agent` family has 234 arms and is marked bypassed); `review/signatures.ts` (40 candidate
clusters, each read: 9 real duplicates, the rest different operations or anchored outside
`cli/src`). `ts-unused-exports` over `cli/tsconfig.json` (524 modules with unused exports,
17 unused files, 8 of them production after removing fixtures and the `./teams` package
entry), then a token search across `cli/`, `scripts/` and `packages/` to classify each
export. `cli/scripts/generate-reference.sh --check` exited 0.

**Area audits.** Six read-only audits, one area each, against this commit, all run as
Claude subagents: prior findings 1-8; prior findings 9-16 and the library table; hardcoded
config; new duplication and dead code; abstractions and architecture (also the C4
inventory); API reference drift. Headline claims were re-checked by direct reads or
`git grep` before inclusion: the dead files' importers (static and dynamic), the dead
skill/SSH exports, the `ACTIVITY_LOG_HOOK_SCRIPT` size, the six correctness bugs, the
`AGENTS_REAL_HOME` count (16 exact copies, not the 18 one audit reported), the absence of
`.sessionDir` readers, the browser/computer client difference (143 differing lines after
renaming, so a shared skeleton rather than identical files), `hosts.md:4`, and the
generator's `src/index.ts` text.

**Limits.**

- `lib/session/discover.ts:3098` contains a raw NUL byte in a template literal, so `grep`
  and `rg` treat the file as binary and stop early. Counts in that file used `grep -a` where
  noted, but per-file arm counts for it may be low.
- Line estimates are net after replacement code and overlap between categories; the
  headline totals are rounded and should not be summed exactly.
- Not covered: internals of `lib/session/db.ts`; per-provider fetchers in
  `accounting/usage.ts`; per-harness registrars in `hooks/install.ts` beyond the dispatch
  switches. No test suite was run; nothing here changes behavior.
