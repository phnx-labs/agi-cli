---
kind: report
title: Component Health
updated: 2026-10-12
commit: 0c730d78b5653fae11dfc5c24543bc9788de5c61
---

# cli — Component Health

## Summary

`cli/` is the `agents` CLI. It does four jobs:
- installs agent harnesses into isolated version homes;
- syncs resources into each harness's native format;
- runs agents locally or over SSH;
- keeps a daemon that indexes sessions, schedules routines and watches for stalls.

This assessment follows PHNX-4227, which removed `agents browser`, `computer`, `secrets` and `sessions` (released in 1.23.18).

The shape problem in one sentence: **removing whole command groups has made the CLI 8% smaller, but the code that remains is not organized by owner.** The pieces of that:
- 219 loose files sit directly in `lib/`;
- library logic still lives in command files;
- five `lib → commands` imports tie almost every module into one import cycle;
- per-harness knowledge still bypasses the registries built for it.

`cli/src` holds **175,359 lines of production code** in 745 files and **172,171 lines of test code** in 984 files. No size budget has been agreed, so this is a baseline, not a pass/fail. Since the 2026-10-09 baseline (`ef9ff0d5b`, recounted with the same rules), production code fell **15,968 lines (−8.3%)** and the command surface fell from 61 groups / 483 commands to **45 groups / 338 commands**. Most of the drop is deleted scope, not cleanup: none of the nine 2026-10-09 findings is fully fixed.

<div class="artifact-grid artifact-grid-3">
<div class="artifact-stat"><div class="artifact-stat-value">175,359</div><div class="artifact-stat-label">production code lines (745 files), −15,968 since 10-09</div></div>
<div class="artifact-stat"><div class="artifact-stat-value">45 / 338</div><div class="artifact-stat-label">command groups / commands (was 61 / 483)</div></div>
<div class="artifact-stat"><div class="artifact-stat-value">219</div><div class="artifact-stat-label">loose files directly in lib/ (40,196 lines), imported from 1,299 sites</div></div>
<div class="artifact-stat"><div class="artifact-stat-value">~1,500</div><div class="artifact-stat-label">confirmed dead production lines, ~500 orphaned by PHNX-4227</div></div>
<div class="artifact-stat"><div class="artifact-stat-value">~812</div><div class="artifact-stat-label">lines that are a copy of what sessions-cli already exports</div></div>
<div class="artifact-stat"><div class="artifact-stat-value">~5,000</div><div class="artifact-stat-label">net lines the confirmed findings below remove (~2.9%)</div></div>
</div>

**What it would take to get small.** The confirmed findings remove roughly 5,000 lines. A large cut comes only from scope decisions, which are the owner's:
- which of the 45 command groups the product keeps;
- whether the session indexer moves into sessions-cli. That is about 8,500 lines, and it moves them rather than deleting them.

The module table below shows where the lines are, so those decisions can be made against real sizes.

<figure class="artifact-figure">
<svg class="artifact-diagram" viewBox="0 0 1000 640" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="C4 container view of the agents CLI at 0c730d78b with numbered finding markers">
<defs>
<marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker>
</defs>
<g fill="currentColor" font-family="ui-sans-serif, system-ui, sans-serif">
<rect x="10" y="60" width="170" height="62" rx="8" fill="none" stroke="#60a5fa" stroke-width="2"/>
<text x="22" y="82" font-size="12" font-weight="700">Operator [Person]</text>
<text x="22" y="99" font-size="11">human or agent; argv over</text>
<text x="22" y="113" font-size="11">a TTY or a pipe</text>
<rect x="10" y="145" width="170" height="78" rx="8" fill="none" stroke="#a1a1aa" stroke-width="2"/>
<text x="22" y="166" font-size="12" font-weight="700">AGI EXT · AGI Menu</text>
<text x="22" y="181" font-size="11">[External, own repos]</text>
<text x="22" y="197" font-size="11">read ps watch / feed NDJSON;</text>
<text x="22" y="211" font-size="11">run one-shot verbs</text>
<rect x="200" y="25" width="470" height="600" rx="10" fill="none" stroke="currentColor" stroke-dasharray="7 5" stroke-width="1.5"/>
<text x="212" y="45" font-size="12" font-weight="700">agents CLI [Software system: cli/src, 175,359 lines]</text>
<rect x="220" y="60" width="430" height="92" rx="8" fill="none" stroke="#a3e635" stroke-width="2"/>
<text x="233" y="82" font-size="12" font-weight="700">commands/ [Container: commander]</text>
<text x="233" y="99" font-size="11">107 files, 44,608 lines; 45 groups / 338 commands</text>
<text x="233" y="114" font-size="11">17 files over 800 lines hold 26k; run is one 2,480-line</text>
<text x="233" y="129" font-size="11">function (exec.ts:572); refusal stubs for removed groups</text>
<circle cx="632" cy="76" r="11" fill="#f59e0b"/><text x="632" y="80" font-size="11" font-weight="700" text-anchor="middle" fill="#111">6</text>
<rect x="220" y="175" width="430" height="92" rx="8" fill="none" stroke="#f87171" stroke-width="2"/>
<text x="233" y="197" font-size="12" font-weight="700">lib/*.ts, flat [Container: library]</text>
<text x="233" y="214" font-size="11">219 loose files, 40,196 lines; god module: 1,299 imports in,</text>
<text x="233" y="229" font-size="11">277 out; 13 concerns, 4 with no owner (exec/run, projects,</text>
<text x="233" y="244" font-size="11">secrets, config); 5 imports back up into commands/</text>
<circle cx="632" cy="191" r="11" fill="#f59e0b"/><text x="632" y="195" font-size="11" font-weight="700" text-anchor="middle" fill="#111">1</text>
<rect x="220" y="290" width="205" height="112" rx="8" fill="none" stroke="#a3e635" stroke-width="2"/>
<text x="233" y="312" font-size="12" font-weight="700">lib/session</text>
<text x="233" y="328" font-size="11">[Container: indexer + roster]</text>
<text x="233" y="344" font-size="11">54 files, 18,468 lines;</text>
<text x="233" y="359" font-size="11">discover 3,958 · db 3,871;</text>
<text x="233" y="374" font-size="11">owns sessions.db schema v52</text>
<circle cx="407" cy="306" r="11" fill="#f59e0b"/><text x="407" y="310" font-size="11" font-weight="700" text-anchor="middle" fill="#111">3</text>
<rect x="445" y="290" width="205" height="112" rx="8" fill="none" stroke="#a3e635" stroke-width="2"/>
<text x="458" y="312" font-size="12" font-weight="700">exec engine + harness</text>
<text x="458" y="328" font-size="11">[lib/exec, agent-spec,</text>
<text x="458" y="344" font-size="11">installations, permissions]</text>
<text x="458" y="359" font-size="11">236 per-harness branches</text>
<text x="458" y="374" font-size="11">outside the registries</text>
<circle cx="632" cy="306" r="11" fill="#f59e0b"/><text x="632" y="310" font-size="11" font-weight="700" text-anchor="middle" fill="#111">4</text>
<rect x="220" y="425" width="205" height="92" rx="8" fill="none" stroke="#a3e635" stroke-width="2"/>
<text x="233" y="447" font-size="12" font-weight="700">daemon [lib/daemon]</text>
<text x="233" y="463" font-size="11">25 files, 5,460 lines; routines,</text>
<text x="233" y="478" font-size="11">index, watchdog, feed hub;</text>
<text x="233" y="493" font-size="11">second job-command builder</text>
<circle cx="407" cy="441" r="11" fill="#f59e0b"/><text x="407" y="445" font-size="11" font-weight="700" text-anchor="middle" fill="#111">5</text>
<rect x="445" y="425" width="205" height="92" rx="8" fill="none" stroke="#a3e635" stroke-width="2"/>
<text x="458" y="447" font-size="12" font-weight="700">devices · hosts · fleet</text>
<text x="458" y="463" font-size="11">58 files, 8,676 lines; two</text>
<text x="458" y="478" font-size="11">device views, two SSH argv</text>
<text x="458" y="493" font-size="11">builders + 3 raw ssh spawns</text>
<circle cx="632" cy="441" r="11" fill="#f59e0b"/><text x="632" y="445" font-size="11" font-weight="700" text-anchor="middle" fill="#111">7</text>
<rect x="220" y="540" width="430" height="70" rx="8" fill="none" stroke="#f87171" stroke-dasharray="5 4" stroke-width="2"/>
<text x="233" y="562" font-size="12" font-weight="700">Retired paths still compiled in [dead code]</text>
<text x="233" y="578" font-size="11">~1,500 lines: topic/phenotype tables, mailbox watch, webhook substitution,</text>
<text x="233" y="593" font-size="11">onepassword.ts, artifact-actions.ts, storage/selection.ts, Claude OAuth chain</text>
<circle cx="632" cy="556" r="11" fill="#f59e0b"/><text x="632" y="560" font-size="11" font-weight="700" text-anchor="middle" fill="#111">2</text>
<rect x="700" y="60" width="290" height="96" rx="8" fill="none" stroke="#a1a1aa" stroke-width="2"/>
<text x="712" y="82" font-size="12" font-weight="700">sessions-cli [External, npm]</text>
<text x="712" y="98" font-size="11">./reader parses transcripts;</text>
<text x="712" y="113" font-size="11">./backup ships the R2 Worker the CLI</text>
<text x="712" y="128" font-size="11">also keeps a copy of; reads sessions.db</text>
<text x="712" y="143" font-size="11">with no shared schema</text>
<circle cx="972" cy="76" r="11" fill="#f59e0b"/><text x="972" y="80" font-size="11" font-weight="700" text-anchor="middle" fill="#111">3</text>
<rect x="700" y="175" width="290" height="70" rx="8" fill="none" stroke="#a1a1aa" stroke-width="2"/>
<text x="712" y="197" font-size="12" font-weight="700">browser · computer · secrets</text>
<text x="712" y="213" font-size="11">[External standalone CLIs] spawned via</text>
<text x="712" y="228" font-size="11">7 near-identical client skeletons</text>
<rect x="700" y="265" width="290" height="62" rx="8" fill="none" stroke="#a1a1aa" stroke-width="2"/>
<text x="712" y="287" font-size="12" font-weight="700">Harness CLIs [External]</text>
<text x="712" y="303" font-size="11">claude, codex, cursor, opencode, grok…</text>
<text x="712" y="318" font-size="11">in version homes under ~/.agents</text>
<rect x="700" y="425" width="290" height="62" rx="8" fill="none" stroke="#a1a1aa" stroke-width="2"/>
<text x="712" y="447" font-size="12" font-weight="700">Fleet devices [External]</text>
<text x="712" y="463" font-size="11">Tailscale / SSH peers running agents</text>
<rect x="700" y="510" width="290" height="62" rx="8" fill="none" stroke="#a1a1aa" stroke-width="2"/>
<text x="712" y="532" font-size="12" font-weight="700">GitHub · Linear · npm [External]</text>
<text x="712" y="548" font-size="11">REST + gh; 3 reads still use GraphQL</text>
<line x1="180" y1="91" x2="219" y2="91" stroke="currentColor" stroke-width="1.3" marker-end="url(#ah)"/>
<text x="183" y="86" font-size="9">argv</text>
<line x1="180" y1="184" x2="219" y2="184" stroke="currentColor" stroke-width="1.3" marker-end="url(#ah)"/>
<text x="183" y="179" font-size="9">spawn</text>
<line x1="435" y1="152" x2="435" y2="174" stroke="currentColor" stroke-width="1.3" marker-end="url(#ah)"/>
<line x1="470" y1="174" x2="470" y2="153" stroke="#f87171" stroke-width="1.3" marker-end="url(#ah)"/>
<text x="476" y="168" font-size="9" fill="#f87171">5 upward imports</text>
<line x1="322" y1="267" x2="322" y2="289" stroke="currentColor" stroke-width="1.3" marker-end="url(#ah)"/>
<line x1="547" y1="267" x2="547" y2="289" stroke="currentColor" stroke-width="1.3" marker-end="url(#ah)"/>
<path d="M395,290 L395,279 L684,279 L684,110 L699,110" fill="none" stroke="currentColor" stroke-width="1.3" marker-end="url(#ah)"/>
<text x="588" y="275" font-size="9">import ./reader, ./backup</text>
<line x1="650" y1="210" x2="699" y2="210" stroke="currentColor" stroke-width="1.3" marker-end="url(#ah)"/>
<text x="652" y="205" font-size="9">spawn</text>
<line x1="650" y1="340" x2="699" y2="300" stroke="currentColor" stroke-width="1.3" marker-end="url(#ah)"/>
<text x="676" y="345" font-size="9">exec, HOME swap</text>
<line x1="650" y1="460" x2="699" y2="460" stroke="currentColor" stroke-width="1.3" marker-end="url(#ah)"/>
<text x="652" y="455" font-size="9">SSH</text>
<line x1="650" y1="575" x2="699" y2="545" stroke="currentColor" stroke-width="1.3" marker-end="url(#ah)"/>
<text x="652" y="580" font-size="9">HTTPS / gh</text>
<rect x="700" y="590" width="290" height="40" rx="6" fill="none" stroke="currentColor" stroke-width="1"/>
<rect x="710" y="603" width="14" height="10" fill="none" stroke="#a3e635" stroke-width="2"/><text x="728" y="612" font-size="9">container</text>
<rect x="785" y="603" width="14" height="10" fill="none" stroke="#f87171" stroke-width="2"/><text x="803" y="612" font-size="9">problem / dead</text>
<rect x="880" y="603" width="14" height="10" fill="none" stroke="#a1a1aa" stroke-width="2"/><text x="898" y="612" font-size="9">external</text>
<circle cx="716" cy="622" r="5" fill="#f59e0b"/><text x="726" y="625" font-size="9">finding number</text>
</g>
</svg>
<figcaption>C4 container view (level 2) of cli/src at 0c730d78b, drawn from imports and spawns traced in the code. Line counts are cloc code lines. Omitted: smaller lib/ subdirectories (teams, feed, accounting, hooks, plugins and others, folded into the module table) and packages/.</figcaption>
</figure>

### Size by module

All counts are production code lines (cloc). Δ is the change since the 2026-10-09 baseline, recounted at `ef9ff0d5b` with the same rules.

| Module | Lines | Files | Δ since 10-09 | Main issue (finding) |
|---|---:|---:|---:|---|
| `commands/` | 44,608 | 107 | −9,299 | 17 fat files hold 26k lines; library logic inside commands (6) |
| `lib/*.ts` (flat) | 40,196 | 219 | −1,494 | No owners for most of 13 concerns; god module; upward imports (1) |
| `lib/session` | 18,468 | 54 | −398 | Copies of sessions-cli; dead tables; 7 re-export shims (2, 3) |
| `lib/installations` | 7,670 | 16 | +35 | Two shim script generators; ~300 dead lines in `shims.ts` (2, 4) |
| `lib/teams` | 6,318 | 17 | +11 | Teams agent set listed 4 times (4) |
| `lib/feed` | 6,131 | 13 | +256 | ~185 unused lines in `activity.ts` (2) |
| `lib/daemon` | 5,460 | 25 | +262 | Second job-command builder; busy-wait (5, 9) |
| `lib/devices` | 4,937 | 29 | +46 | God module; overlaps `hosts` (7) |
| `lib/accounting` | 4,366 | 8 | +41 | ~130 dead Claude OAuth lines (2) |
| `lib/hooks` | 3,275 | 4 | −59 | 12-arm harness chain (4) |
| `lib/hosts` | 2,992 | 24 | −41 | Adapter over `devices`; duplicate mapping (7) |
| `lib/plugins` | 2,656 | 3 | −163 | 20 harness branches (4) |
| `lib/agent-spec` | 2,554 | 6 | −782 | The harness catalog: should be the one owner (4) |
| `lib/cloud` | 2,261 | 12 | +9 | Missing `'error'` handler (9) |
| `lib/staleness` | 2,207 | 39 | +13 | 37 files for one table; misnamed (7) |
| `lib/github` | 1,920 | 9 | +227 | `parseNdjson` ×3; GraphQL reads (8, 9) |
| 37 smaller modules + root files | 19,102 | 158 | −4,632 | `lib/traces` (−3,081), `triggers`, `browser`, `computer`, `packages` removed or emptied |
| **Total** | **175,359** | **745** | **−15,968** | |

## Findings

Ranked by maintenance burden removed. Line counts are net estimates after the replacement code, and they overlap a little between findings.

### 1. The flat `lib/` and five upward imports keep one cycle (confirmed; structural, ~1,500 lines to move)

**The god module.** `lib/` has 219 loose files (40,196 lines). The module graph marks it as a god module, with 1,299 imports in and 277 out. One import cycle runs through almost every module.

**What closes the cycle.** Five imports reach back up from `lib/` into `commands/`:
- `lib/smart-launch.ts:153` → `commands/ssh.js` (`collectFleetHarnesses`)
- `lib/snapshot.ts:111-112` → `commands/view.js` (`collectAgentsJson`) and `commands/ps-roster.js` (`gatherActiveSessions`)
- `lib/accounts/migrate.ts:245` → `commands/view.js` (`planDuplicatePrune`)
- `lib/accounts/add.ts:622` → `commands/utils.js`. This is a re-export of `lib/format.ts:90`, so changing the import path is the whole fix.

The other four functions are pure data code living in command files. Moving them to `lib/devices/harness-inventory.ts`, `lib/installations` and `lib/session/active.ts` breaks the cycle.

**The loose files.** They cluster into 13 concerns (Evidence). Four have no owning module:

| Concern | Lines | Files |
|---|---:|---:|
| exec/run | 3,894 | 23 |
| projects/Linear | 2,971 | 17 |
| secrets | 1,573 | 7 |
| config/permissions/models | 6,648 | 16 |

Nine have an owner but sit beside it. For example, `self-update.ts` belongs in `lib/installations`, and the `routine*` files in `lib/scheduling`. Moving files does not remove lines. It does decide where a human looks first, and it is what makes the next findings cheap.

### 2. Dead code, ~500 lines orphaned by PHNX-4227 (confirmed, ~1,500 production + ~900 test)

**Orphaned by this week's removals: 443 lines.** Every item was checked with `grep -w` across `cli/`, `scripts/` and `packages/`.
- `lib/session/db.ts:2841-2955`: the topic/phenotype readers and writers, whose only consumer was the deleted `lib/traces/sync.ts` (117 lines). The `session_topics` and `session_phenotypes` DDL at `db.ts:348-375` goes with them.
- Mailbox list and watch, used only by the deleted `commands/mailboxes.ts` (`mailbox.ts:285-382`, 80 lines).
- Webhook prompt substitution, which no caller can reach (`scheduling/routines.ts:1189-1264`, 50 lines).
- Registry and package types (`types.ts:319-403`, 45 lines).
- Async secrets-store writers that only tests call (`secrets-client.ts:408-530`, 35 lines).
- `comms-render.ts` `aggregate`, the detach-record helpers, `storage/selection.ts` (an unimported file), `remote-list.ts` `parseRemoteList`/`isAutomaticSessionPeer`, `isSessionIdLiveOnProcessTable`, and nine `state.ts` path getters for removed directories.

**Browser and computer leftovers: ~107 lines.**
- `lib/ssh-tunnel.ts:8-66`; only `resolveRemoteDevice` is live.
- `permissions.ts:38-60` computer-gated verbs.
- `device-config.ts:1175,1308` browser-profile helpers.

**Older dead code: ~1,000 lines.**
- `lib/onepassword.ts` (218 lines, unimported since PHNX-3989) and `lib/artifact-actions.ts` (60, unimported).
- `installations/shims.ts` conflict helpers (~298).
- The Claude OAuth chain in `accounting/usage.ts` (~129).
- `lib/commands.ts` install/list/match helpers (~137).
- Legacy `applyXPermissions` (~150).
- Mailbox drain/peek (~88).
- `crabbox/runtimes.ts` pickers (~84).
- `sshStreamWithArgs` (~82).

**Tests.** About 900 test lines cover only these symbols and go with them. Separately, about 2,300 lines of transcript-parser tests test code that now lives in `@phnx-labs/sessions-cli/reader`. 13 of the 14 files import it.

### 3. `lib/session` duplicates sessions-cli (confirmed ~812; candidate ~1,050 more)

**Confirmed: ~812 lines.**
- `lib/session/sync/worker-template.ts` (808 lines) is identical to `@phnx-labs/sessions-cli`'s `dist/lib/session/sync/worker-template.js` (807 lines). `diff` shows only the header comment. The pinned 0.8.4 exports it from `./backup` as `renderSessionsWorkerScript`.
- `managed-config.ts` duplicates the same export.
- `sync/provision.ts:16` is the only production importer.
- Importing from the package removes about 812 lines. The generated Worker script's header changes, so the next re-provision redeploys it once.

**Candidates, needing new sessions-cli exports: ~1,050 lines.**
- `commands/sessions-picker.ts:36-715` and `lib/session/preview-digest.ts` repeat the package's `commands/sessions-preview.js`, function for function (`buildPreview`, `formatHeader`, `renderTodos` and 14 more). The package does not export it.
- `session/bookmarks.ts` and `presentation.ts:665` `machineLabeler` also exist upstream.

**Structural risk (confirmed).** `sessions.db` schema v52 is defined only in `db.ts:32`. sessions-cli reads the same database with column introspection (`query.js:198`), so the two repositories share a schema contract with no shared definition. Moving the indexer (`discover.ts` and the `db.ts` writer, about 8,500 lines) into sessions-cli would co-locate them. That decision belongs to the owner, and it moves code; it does not delete it.

### 4. Harness dispatch still bypasses the registries (confirmed, ~380-420; 10-09 finding 1)

The `agent` discriminator has 236 branches in 42 files (234 on 10-09). It has a contract (`teams/parsers.ts:3`) and a registry (`account-capabilities.ts:11`), so the scanner marks it bypassed. The adapters in `lib/harness/adapters` cover 9 of 16 members. The largest sites:
- `lib/exec.ts`: 25 branches. `buildExecCommand` at `:645-820`.
- `lib/models.ts`: 24.
- `plugins/plugins.ts`: 20.
- `session/discover.ts`: 19.
- `permissions.ts`: 11 arms in `applyPermissionsToVersionBody` (`:1277-1648`). This function grew since 10-09. `PermissionTarget` still has no write half (`permissions-registry.ts:302-309`).

**Fixed since 10-09:** only one hooks switch (`hookRegistrationTargets`), deleted in ee62daa24.

**Drifted lists.** Three different lists say which harnesses can resume:
- `session/recovery.ts:5`
- `scheduling/routines.ts:844`
- `watchdog/rotate.ts:271`

The teams agent set is written out 4 times.

### 5. Duplicate helpers with an existing owner (confirmed, ~1,400)

The 10-09 list is partly fixed. Cloudflare provisioning, `shortCwd`, the ps-roster helpers and half the `percentile` copies are now single-owner. About 1,150 lines remain:
- 88 `renameSync` atomic-write sites;
- 20 `IdentitiesOnly=yes` literals;
- two npm "latest" fetchers plus a third in the daemon;
- `normalizeContent` ×3, `stripJsonComments` ×2, `mapBounded` ×2.

One item got worse: `parseNdjson` went from 2 copies to 3 (`github/open-prs.ts:75` added by d7e948ee7).

New confirmed copies add about 280 lines:
- `isRecord` ×10 and `sleep` ×8;
- `levenshtein` ×3. `fuzzy.ts:2` is the exported owner.
- `compareVersions` ×2 (`bootstrap.ts:153`, `commands/view.ts:190`). `agent-spec/primitives.ts:15` is a superset of both.
- The 7-times-copied "run `agents … --json` over SSH" probe in `commands/ssh.ts` and `commands/doctor.ts`.

Two copies have already drifted:
- **`statusColor`.** `commands/teams-picker.ts:27` has no `pr_open` case, so a PR-open teammate renders white in the picker and magenta in `teams` (`teams.ts:150`).
- **Width helpers.** `format.ts:110` `visibleWidth` ignores wide characters. `text/width.ts:31` counts them.

### 6. Fat command files (confirmed; structural)

17 command files over 800 lines hold 26,063 of the 44,608 command lines, mostly as one giant registration function each:
- `exec.ts:572` `run`: about 2,480 lines.
- `routines.ts:864`: about 1,440.
- `teams.ts:1265`: about 1,405.
- `ssh.ts:1015`: about 1,040.
- `projects.ts:711`: about 900.

The data code inside them belongs in existing owners:
- the git helpers in `exec.ts:254-264` → `lib/git.ts:491`;
- `runWorkflowForEach` → `lib/workflows.ts`;
- the PR-watch state in `teams.ts:565-618` → `lib/teams`;
- the fleet probing in `ssh.ts:559-909` → `lib/devices`;
- the prune planner in `view.ts:1413-1674` → `lib/installations`.

Moving that code is the same work as finding 1's cycle fix.

### 7. Fragmented and overlapping modules (confirmed ~450; candidate more)

**`lib/staleness`.** It has 37 production files for one per-kind table:
- `checkers/skills.ts`, `subagents.ts` and `workflows.ts` differ only in a filename and a type string;
- each detector and writer repeats the same `build<Kind>` shell;
- `registry.ts` imports all 18 by hand.

A table removes about 230 lines and 20 files. The module is also misnamed: it is the sync-writer engine.

**`lib/hosts` vs `lib/devices`.** `hosts/registry.ts:65-86` repeats `hosts/providers/devices.ts:8-29`, and `fleet/apply.ts:437` reimplements `concurrency.ts:10`. Fixing those saves about 70 lines.

Two SSH argument builders exist:
- `ssh-exec.ts` (ControlMaster);
- `devices/connect.ts:169` (askpass, pinned host key).

Three call sites spawn `ssh` directly, bypassing both.

**`lib/session` shims.** Seven re-export shims (`width`, `watch`, `remote-list`, `short-id` and others) inflate the module's fan-in. Removing them saves about 150 lines.

### 8. Hand-rolled code and client skeletons (confirmed, ~525; 10-09 findings 4, 5 and 8)

- **Library replacements: ~235.** `copyDir`/`removePath` pairs could use `fs.cp`/`fs.rm`. `node:timers/promises` is unused (26 inline sleep promises). There are three hand PATH walks, and a hand-written TOML emitter even though `smol-toml` is available.
- **Standalone-CLI clients: ~90.** Seven resolvers, five `invocation()` copies and six `*Error` classes, with no `lib/standalone-cli.ts`.
- **Hardcoded config: ~200.** 16 `AGENTS_REAL_HOME` copies, `watchdog/log.ts:6` ignoring `AGENTS_LOGS_DIR`, and org-specific data in `factory/snapshot.ts:14-20` and `watchdog/runner.ts:760-778`.

### 9. Correctness issues found along the way (confirmed)

1. `lib/cloud/codex.ts:39-49` spawns with only a `'close'` listener. A spawn failure raises an unhandled `'error'`.
2. `lib/daemon/daemon.ts:1312` busy-waits (`while (Date.now() < waitUntil) {}`), although `sleepSync` is already imported at `:29`.
3. `lib/mailbox.ts:137` writes a fixed `${dest}.tmp`, so concurrent writers collide. The same file uses a pid-unique temp at `:94`.
4. `lib/auto-pull-worker.ts:37-51` takes its lock with `statSync` and then a plain write, not `'wx'`.
5. `commands/daemon.ts:494`: `daemon logs --since 1week` becomes "since now" and prints nothing (`parseDuration` has no week unit).
6. `bootstrap.ts:390` exits 0 when the post-upgrade re-exec is killed by a signal (`result.status ?? 0`).
7. `watchdog/log.ts:6` ignores `AGENTS_LOGS_DIR`.
8. Three reads still use GraphQL against the repo rule: `github/project-prs.ts:183`, `factory/snapshot.ts:213`, `feed/pr-status.ts:51`.

**Corrections to the 10-09 report.**
- `AGENTS[*].sessionDir` does have readers (`agent-spec/agents.ts:931,1786`). The real issue is drift from `daemon/runner.ts:413-425`.
- There are 2 SIGTERM→SIGKILL sites, not 4.
- The `leaked-daemons.ts` real-home check is deliberate.

## Evidence

**Scope.** `cli/` at `0c730d78b` (fresh `origin/main`), assessed in a clean linked worktree. `packages/` (about 1,050 lines in `session-tracker`, 16 in the two stubs) and the root `scripts/` (about 3,600 lines) were sized but not audited. No uncommitted changes were assessed.

**Counts.** `npx cloc@2.6.0`, TypeScript only, over `git ls-files`:

- **Production:** `.ts`/`.tsx` under `cli/src`, excluding `*.test.ts{,x}`, `*.bench.ts`, `__tests__/`, `testdata/`. Result: 745 files, 175,359 code / 3,928 comment / 20,522 blank.
- **Tests:** `*.test.ts{,x}` under `cli/` plus `__tests__/` directories. Result: 984 files, 172,171 code (`--timeout 0`).
- **Baseline:** the same rules at `ef9ff0d5b` give 191,327 production code lines. The 10-09 report printed 194,628 for that commit with a slightly different file list, so this report compares against the recount.
- **Module rollup:** `--by-file` grouped by `lib/<dir>`. The rows reconcile to the totals.
- **Diff:** `git diff --shortstat ef9ff0d5b HEAD -- cli/src` gives 537 files, +11,340 / −41,904 physical lines.
- **Surface:** `cli/docs/command-index.json` lists 45 groups and 338 commands.

**Scanners.** From the `code` skills, run from the worktree:
- `refactor/modules.ts --scope cli/src --depth 2`: 55 modules, 769 parsed / 104 unparsed, 307 edges, 1 cycle, 3 god modules, 5 upward imports, 4 extraction candidates.
- `refactor/patterns.ts --scope cli/src`: 86 families, 1,516 collapsible arms. The `agent` family has 236 arms in 42 files and is marked bypassed.
- Outputs are saved under `.agents/artifacts/2026-10-12/code-health/` in the assessment worktree and not committed.

**Area audits.** Four read-only audits ran against this commit as Claude subagents:
- the status of the nine 10-09 findings;
- PHNX-4227 leftovers and dead code, using an import graph plus a fixpoint pass over static and dynamic imports, `require` and barrels, because `ts-unused-exports` was not runnable without dependencies;
- `commands/` and flat `lib/` structure;
- `lib/session` and the other large modules against `@phnx-labs/sessions-cli` 0.8.3/0.8.4.

Headline claims were re-checked by direct reads before inclusion:
- the worker-template diff and the package's `./backup` export at 0.8.4;
- the five upward imports;
- the `statusColor` drift;
- the busy-wait, mailbox temp and codex `'error'` bugs;
- that nothing imports `storage/selection.ts` or `onepassword.ts`, and nothing outside `db.ts` calls the topic/phenotype functions.

**Limits.**
- Line estimates are rounded nets that overlap between findings, so do not sum them exactly. The ~5,000 headline is the sum of the confirmed estimates in findings 2, 3, 4, 5, 7 and 8, minus their overlap.
- Uninspected candidates are marked as such: the preview move in finding 3, and the remainder of the SSH unification in finding 7.
- Not covered:
  - `lib/session/db.ts` internals beyond the dead functions;
  - per-provider fetchers in `accounting/usage.ts`;
  - whether `teams/parsers.ts` duplicates the sessions-cli reader formats.
- No test suite was run. Nothing here changes behavior.
