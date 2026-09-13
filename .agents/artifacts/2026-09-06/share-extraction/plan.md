---
kind: plan
surface: cli
title: Share moves to artifacts-cli — one home, one Worker
summary: Relocate the mature managed-share stack from agents-cli into the standalone artifacts-cli, repoint the sharing skill, hard-drop share from agents-cli, and leave Rush on its billing proxy.
status: proposed
project: agents-cli
repository: phnx-labs/agents-cli
harness: claude
agent: Claude
host: yosemite-s1
human: owner
date: "2026-09-06"
tracking: PHNX-3992
links:
  - https://linear.app/getrush/issue/PHNX-3992
  - https://linear.app/getrush/issue/PHNX-3989
---

## Focus for review

Three decisions carry this plan. Everything else follows from them.

1. **Direction: relocate, don't rebuild, don't invert ownership.** The mature share code (4,971 LOC) already lives in agents-cli; artifacts-cli holds a 1,135-LOC BYO-only *ancestor* of it. We move the mature stack into artifacts-cli (the tool that already renders what you share) and delete the ancestor — we do **not** rewrite share inside artifacts-cli, and we do **not** create a third shared package.
2. **The shared thing is the Worker + its API, not code.** `share.getrush.ai` already exists once. artifacts-cli owns the TS + the Worker template; Rush keeps talking to the same backend through its own billing proxy; nothing is duplicated across languages.
3. **Hard-drop, gated on order.** agents-cli loses `agents artifacts share` entirely (few users, breaking it is acceptable). But artifacts-cli must *gain* the managed stack and the visibility flags **first** — the skill repoint is blocked until it does.

## Purpose

The owner's ask, verbatim in spirit: *"We can remove the share functionality from agents-cli — agents-cli is less important. Add that functionality into artifact CLI for sharing, but keep a lighter-weight sharing part reachable. artifacts-cli has a lot of other logic — rendering, templates — which stays there. Update the skills to just install artifacts-cli directly for sharing. Breaking the interface of agents-cli is not a big issue."*

Consolidate artifact/session sharing under the standalone `@phnx-labs/artifacts-cli`, repoint fleet guidance to it, and drop the embedded share engine from agents-cli — without rebuilding what already works or bypassing Rush's billing seam.

## Why now — three implementations, mature code in the wrong place

Sizing measured 2026-09-06 with `wc -l`:

| Client | Share LOC | Model | Auth | Maturity |
|---|---|---|---|---|
| **agents-cli** `cli/src/lib/share/` | **4,971** | client→Worker PUT, managed **+** BYO, OG covers, visibility, revisions, handle claims, 2,240-LOC Worker template | Phoenix ID / static WRITE_TOKEN | complete superset |
| **artifacts-cli** `@phnx-labs/artifacts-cli` | 1,135 | client→Worker PUT, **BYO only** | self-generated WRITE_TOKEN | strict **subset / ancestor** of agents-cli's BYO half |
| **Rush CLI** (Go) | 1,631 | proxy API `/api/v1/artifacts` | Rush account | outlier — different transport + **billing** seam |

artifacts-cli is the tool that *renders* the HTML you share, is already published standalone, and today calls **back into** agents-cli for managed publish — `src/lib/render.ts:1124` execs `agents ['artifacts','share', …]`. Sharing belongs next to rendering, and the back-call inverts to an internal call once it lands there.

<div class="artifact-callout">
<strong>Exposure is neutral.</strong> The share + Worker code is <em>already public</em> — it lives in agents-cli, a public repo. Moving public→public changes nothing visible, and no secrets live in source (Worker auth resolves from Cloudflare bindings + <code>agents secrets</code>, never baked in). No new package, no private/public decision to make.
</div>

## Current architecture

Today three CLIs reach the same managed Worker three different ways, and agents-cli owns both the TS stack and the release-time Worker deploy.

<figure class="artifact-figure">
<svg viewBox="0 0 920 430" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Current architecture: agents-cli owns the mature share stack and the Worker deploy; artifacts-cli calls back into it; Rush uses its own proxy.">
  <defs>
    <marker id="a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="var(--muted,#5c655c)"/></marker>
    <marker id="ab" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="var(--danger,#dc2626)"/></marker>
  </defs>
  <rect x="20" y="30" width="250" height="150" rx="8" fill="var(--surface,#ffffff)" stroke="var(--line,#e2e6df)" stroke-width="1.5"/>
  <text x="34" y="54" font-family="Inter,system-ui,sans-serif" font-size="13" font-weight="700" fill="var(--text,#1a1c1a)">agents-cli</text>
  <text x="34" y="74" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">cli/src/lib/share/ · 4,971 LOC</text>
  <text x="34" y="92" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">managed + BYO · OG · visibility</text>
  <text x="34" y="108" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">worker-template.ts (2,240)</text>
  <text x="34" y="132" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">release.sh deploy_share_worker()</text>
  <text x="34" y="150" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">run/teams inject SHARE_WRITE_TOKEN</text>
  <text x="34" y="168" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">sessions share → publishFile()</text>
  <rect x="20" y="240" width="250" height="120" rx="8" fill="var(--surface,#ffffff)" stroke="var(--line,#e2e6df)" stroke-width="1.5"/>
  <text x="34" y="264" font-family="Inter,system-ui,sans-serif" font-size="13" font-weight="700" fill="var(--text,#1a1c1a)">artifacts-cli</text>
  <text x="34" y="284" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">render · pdf · templates</text>
  <text x="34" y="302" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">share (BYO only, 1,135 LOC)</text>
  <text x="34" y="326" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">render --publish execs</text>
  <text x="34" y="342" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">↳ agents artifacts share</text>
  <rect x="20" y="384" width="250" height="30" rx="8" fill="var(--surface,#ffffff)" stroke="var(--line,#e2e6df)" stroke-width="1.5"/>
  <text x="34" y="404" font-family="Inter,system-ui,sans-serif" font-size="13" font-weight="700" fill="var(--text,#1a1c1a)">Rush CLI (Go) · proxy /api/v1/artifacts</text>
  <rect x="600" y="150" width="290" height="90" rx="10" fill="var(--surface,#fff)" stroke="var(--accent,#4d7c0f)" stroke-width="2"/>
  <text x="620" y="182" font-family="Inter,system-ui,sans-serif" font-size="13" font-weight="700" fill="var(--text,#1a1c1a)">Managed Worker</text>
  <text x="620" y="202" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">share.getrush.ai · R2</text>
  <text x="620" y="222" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">OG covers · handles · revisions</text>
  <rect x="600" y="300" width="290" height="60" rx="8" fill="var(--surface,#ffffff)" stroke="var(--line,#e2e6df)" stroke-width="1.5"/>
  <text x="620" y="326" font-family="Inter,system-ui,sans-serif" font-size="13" font-weight="700" fill="var(--text,#1a1c1a)">Rush proxy API</text>
  <text x="620" y="346" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">auth + billing seam</text>
  <path d="M270,95 C430,95 470,180 598,185" fill="none" stroke="var(--muted,#5c655c)" stroke-width="1.5" marker-end="url(#a)"/>
  <text x="360" y="120" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">managed PUT (Phoenix)</text>
  <path d="M270,320 C400,320 300,300 150,240" fill="none" stroke="var(--danger,#dc2626)" stroke-width="2" marker-end="url(#ab)"/>
  <text x="285" y="372" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--danger,#dc2626)">back-call into agents-cli</text>
  <path d="M270,399 C420,399 470,340 598,335" fill="none" stroke="var(--muted,#5c655c)" stroke-width="1.5" marker-end="url(#a)"/>
  <text x="360" y="392" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">proxy POST (Rush acct)</text>
</svg>
<figcaption>Today: the mature stack and the Worker deploy sit in agents-cli; artifacts-cli calls back into it for managed publish; Rush uses a separate billing proxy.</figcaption>
</figure>

### Proposed architecture

artifacts-cli owns the TS stack and the Worker deploy. agents-cli sheds share. The skill installs artifacts-cli. Rush is unchanged.

<figure class="artifact-figure">
<svg viewBox="0 0 920 400" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Proposed architecture: artifacts-cli owns share and the Worker deploy; the skill uses artifacts share; agents-cli has no share; Rush unchanged.">
  <defs>
    <marker id="a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="var(--accent,#4d7c0f)"/></marker>
  </defs>
  <rect x="20" y="40" width="270" height="170" rx="8" fill="var(--surface,#ffffff)" stroke="var(--line,#e2e6df)" stroke-width="1.5"/>
  <text x="34" y="64" font-family="Inter,system-ui,sans-serif" font-size="13" font-weight="700" fill="var(--text,#1a1c1a)">artifacts-cli  (single home)</text>
  <text x="34" y="86" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">render · pdf · templates</text>
  <text x="34" y="106" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">share: managed + BYO</text>
  <text x="34" y="124" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">OG · visibility · handles · revisions</text>
  <text x="34" y="142" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">worker-template + share update</text>
  <text x="34" y="160" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">release.sh deploys the Worker</text>
  <text x="34" y="184" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">render --publish → internal call</text>
  <rect x="20" y="250" width="270" height="70" rx="8" fill="none" stroke="var(--danger,#dc2626)" stroke-width="1.5" stroke-dasharray="5 4"/>
  <text x="34" y="274" font-family="Inter,system-ui,sans-serif" font-size="13" font-weight="700" fill="var(--danger,#dc2626)">agents-cli</text>
  <text x="34" y="294" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--danger,#dc2626)">lib/share/ + commands REMOVED</text>
  <text x="34" y="312" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">keeps: readCloudflareCreds util (traces)</text>
  <rect x="20" y="344" width="270" height="30" rx="8" fill="var(--surface,#ffffff)" stroke="var(--line,#e2e6df)" stroke-width="1.5"/>
  <text x="34" y="364" font-family="Inter,system-ui,sans-serif" font-size="13" font-weight="700" fill="var(--text,#1a1c1a)">Rush CLI — UNCHANGED (proxy)</text>
  <rect x="340" y="60" width="210" height="70" rx="8" fill="var(--surface,#ffffff)" stroke="var(--line,#e2e6df)" stroke-width="1.5"/>
  <text x="354" y="84" font-family="Inter,system-ui,sans-serif" font-size="13" font-weight="700" fill="var(--text,#1a1c1a)">/share skill</text>
  <text x="354" y="104" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">installs artifacts-cli</text>
  <text x="354" y="120" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">runs: artifacts share …</text>
  <rect x="620" y="70" width="270" height="90" rx="10" fill="var(--surface,#fff)" stroke="var(--accent,#4d7c0f)" stroke-width="2"/>
  <text x="640" y="102" font-family="Inter,system-ui,sans-serif" font-size="13" font-weight="700" fill="var(--text,#1a1c1a)">Managed Worker</text>
  <text x="640" y="122" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">share.getrush.ai · R2</text>
  <text x="640" y="142" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">one backend, unchanged</text>
  <rect x="620" y="330" width="270" height="50" rx="8" fill="var(--surface,#ffffff)" stroke="var(--line,#e2e6df)" stroke-width="1.5"/>
  <text x="640" y="352" font-family="Inter,system-ui,sans-serif" font-size="13" font-weight="700" fill="var(--text,#1a1c1a)">Rush proxy API</text>
  <text x="640" y="370" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">auth + billing (kept)</text>
  <path d="M290,120 L338,110" fill="none" stroke="var(--accent,#4d7c0f)" stroke-width="1.8" marker-end="url(#a2)"/>
  <path d="M550,100 C590,100 600,110 618,112" fill="none" stroke="var(--accent,#4d7c0f)" stroke-width="1.8" marker-end="url(#a2)"/>
  <path d="M290,130 C450,150 470,150 618,130" fill="none" stroke="var(--accent,#4d7c0f)" stroke-width="1.8" marker-end="url(#a2)"/>
  <text x="330" y="205" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">managed PUT (Phoenix)</text>
  <path d="M290,359 C430,359 480,360 618,357" fill="none" stroke="var(--accent,#4d7c0f)" stroke-width="1.8" marker-end="url(#a2)"/>
  <text x="360" y="352" font-family="'JetBrains Mono',monospace" font-size="10.5" fill="var(--muted,#5c655c)">proxy POST</text>
</svg>
<figcaption>After: one TS home (artifacts-cli) owns share + the Worker deploy; the skill installs and calls it; agents-cli is emptied of share; Rush is untouched.</figcaption>
</figure>

## The CLI change, before and after

<figure class="artifact-figure artifact-behavior">
<section data-state="current" data-evidence="capture">
<strong>Today — sharing goes through agents-cli</strong>

```console
$ agents artifacts share plan.html
  → public link + auto OG cover
$ agents artifacts share report.html --unlisted --no-cover --expire 7d
  → private (unlisted) link
$ agents auth login          # managed Phoenix endpoint
# artifacts-cli render --publish  →  execs `agents artifacts share`
```
</section>
<section data-state="proposed" data-evidence="mockup">
<strong>After — sharing is artifacts-cli's own surface</strong>

```console
$ artifacts share plan.html
  → public link + auto OG cover
$ artifacts share report.html --unlisted --no-cover --expire 7d
  → private (unlisted) link
$ artifacts auth login       # managed Phoenix endpoint (moved here)
# artifacts render --publish  →  internal call, no shell-out
# agents artifacts share      →  removed (few users; skill repointed)
```
</section>
</figure>

## Proposed Changes

Load-bearing moves, per repo.

```diff
# artifacts-cli (phnx-labs/artifacts-cli) — GAINS the managed stack
+ src/lib/share/{publish,capture,og,delete,config,backend,html,analytics}.ts  # from agents-cli
+ src/lib/share/worker-template.ts        # the 2,240-LOC managed Worker template
+ src/commands/share.ts                   # visibility/list/revisions/edit/open/update/unshare
+ auth: managed Phoenix login (PhoenixSession) reachable as `artifacts auth login`
- src/lib/share-worker.ts                 # BYO-only ancestor, deleted
```

```diff
# artifacts-cli release script — OWNS the Worker deploy
+ after publish: `artifacts share update --check/--force`  # deploy managed Worker on template change
```

```diff
# agents-cli (this repo) — HARD-DROP
- cli/src/lib/share/**                     # entire dir
- cli/src/commands/share.ts                # the share/unshare command surface
- cli/src/commands/sessions-share.ts       # OR: reduce to a thin `artifacts share` shell-out
- release.sh: deploy_share_worker(), --deploy-worker, DEPLOY_WORKER  (lines 262–299)
~ cli/src/commands/exec.ts, teams.ts       # SHARE_WRITE_TOKEN injection: relocate or move to Phoenix-login
+ cli/src/lib/cloudflare/creds.ts          # extract readCloudflareCreds (borrowed by traces.ts)
```

```diff
# phnx-labs/.agents-system — repoint the skill (checkout: ~/.agents/.system)
~ plugins/share/skills/share/SKILL.md      # 16 invocation lines: `agents artifacts share` → `artifacts share`
~ plugins/share/{commands/share.md,.claude-plugin/plugin.json,README.md}  # copy-only
```

## Public Interface

| Surface | Before | After |
|---|---|---|
| Publish public | `agents artifacts share <f>` | `artifacts share <f>` |
| Publish private | `agents artifacts share <f> --unlisted --no-cover --expire 7d` | same flags on `artifacts share` |
| Managed login | `agents auth login` | `artifacts auth login` |
| Setup (BYO) | `agents artifacts setup` | `artifacts share setup` |
| Session share | `agents sessions share` | thin shell-out to `artifacts share`, or removed |
| `render --publish` | execs `agents artifacts share` | internal call |
| Rush share | `rush artifacts share …` (proxy) | **unchanged** |

<div class="artifact-callout">
<strong>Blocker to sequence around:</strong> artifacts-cli's current <code>share</code> exposes only <code>--slug/--expire/--github-user/--json</code> (<code>cli.ts:350-357</code>) — no <code>--unlisted</code>, <code>--no-cover</code>, or <code>--visibility</code>. The skill cannot be repointed until those flags land. artifacts-cli gains the stack <em>first</em>; agents-cli drops <em>last</em>.
</div>

## Plan

Four PRs, forced order. Tracked as PHNX-3992 sub-tasks.

1. **artifacts-cli: gain the managed stack.** Relocate `publish/capture/og/delete/config/backend/html/analytics` + `worker-template.ts`; add managed Phoenix login, visibility flags, `list/revisions/edit/open/update/unshare`, delete-with-cover, pre-publish secret scan + email redaction. Delete BYO-only `share-worker.ts`. Verify a managed publish against live `share.getrush.ai`.
2. **artifacts-cli: own the Worker deploy.** Move the release-time `share update --check/--force` into artifacts-cli's release so the deployed Worker tracks the shipped template.
3. **.agents-system: repoint the skill.** Rewrite the 16 invocation lines to `artifacts share …`, install artifacts-cli in the skill, keep public/private semantics; copy-only edits to the plugin's three doc files. Prove an end-to-end publish from `/share`.
4. **agents-cli: hard-drop.** Remove `lib/share/` + commands; extract `readCloudflareCreds`; relocate the `SHARE_WRITE_TOKEN` injection or move it to Phoenix-login; decide `sessions share`; delete `deploy_share_worker()` from `release.sh`. Build + tests green; CHANGELOG entry.

## Validation

Each PR carries real end-to-end proof, not an exit code.

```bash
# PR1 — managed publish works from artifacts-cli
artifacts share /tmp/plan.html --json            # → https://share.getrush.ai/<handle>/<slug>
curl -sI "$URL" | grep -i '200\|og:image'        # cover present, page live
artifacts share /tmp/plan.html --unlisted --no-cover --expire 7d

# PR2 — Worker deploy tracks template
artifacts share update --bundle cloudflare --check --update-json   # no drift after release

# PR3 — the skill publishes end to end
# drive /share on a real HTML file, confirm the returned link opens

# PR4 — agents-cli is clean
grep -rn "lib/share" cli/src | grep -v cloudflare   # empty
cd cli && bun run test                              # green
rush artifacts share <session> <file>              # Rush still works, untouched
```

## Risks

- **`shareRuntimeEnv` token injection is load-bearing** (`cli/src/commands/exec.ts:3234`, `teams.ts:540,2249`): fleet children publish with an injected `SHARE_WRITE_TOKEN`. Dropping it silently would break BYO publishing from spawned agents. Mitigation: relocate the helper, or migrate the fleet publish path to synced Phoenix login before removal.
- **`sessions share` calls `publishFile()` internally** (`cli/src/commands/sessions-share.ts:26,180`). A blind delete breaks session sharing. Decide in PR4: thin shell-out to `artifacts share` (keeps the feature) vs remove (owner said breaking is acceptable).
- **`traces` borrows `readCloudflareCreds`** (`cli/src/commands/traces.ts:7,193,223`) — unrelated feature. Must extract to a shared CF util, not delete with share.
- **Worker-deploy gap between PR2 and PR4.** If agents-cli's `deploy_share_worker()` is removed before artifacts-cli's release deploys, the managed Worker could drift. Order PR2 before PR4 and confirm one artifacts-cli release has deployed the Worker.
- **Cross-org auth for the managed login move.** Managed publish uses Phoenix (`PhoenixSession`); moving `agents auth login` semantics to `artifacts auth login` must not break already-synced fleet Phoenix credentials.

## Tracking

- PHNX-3992 — Extract artifact-sharing into artifacts-cli; hard-drop the embedded share engine from agents-cli
- PHNX-3989 — Extract and publish Secrets CLI (parallel pattern, same shape)
- Plan PR: docs/plan-share-extract (this artifact)
- Implementation PRs 1–4: to be linked as opened
