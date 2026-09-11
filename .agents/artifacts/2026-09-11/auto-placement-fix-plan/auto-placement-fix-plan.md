---
kind: visual
title: Auto Placement Fix Plan
summary: Placement fails because workers judge Claude accounts by a copied usage number that goes stale; the fix makes the launching device bring its own live number, so no copy and no timer can empty the pool again.
header: Phoenix Labs / Engineering
project: agents-cli
repository: phnx-labs/agents-cli
status: proposal
harness: claude
agent: claude-fable-5-1
host: zion
session: 4aad4973
date: "2026-09-11"
tracking: PHNX-4051
links:
  - url: https://linear.app/getrush/issue/PHNX-4051
    label: PHNX-4051
  - https://github.com/phnx-labs/agents-cli/pull/3589
  - https://github.com/phnx-labs/agents-cli/pull/3590
  - https://github.com/phnx-labs/agents-cli/pull/3595
---

## Story

**The one idea.** A worker cannot read Claude usage itself, so today it judges its accounts by a copy of zion's number that arrives through a 15-minute git exchange and is distrusted after 40 minutes. When that exchange stalls, every worker's copy expires together and `--device auto` refuses all of them. The launching device already holds the live number under its own OAuth login. Placement should use that, and the copies and their timers stop mattering.

**Where we are on 2026-09-11.** The two transport breaks on the worker side are fixed and installed in agents-cli 1.22.100: yosemite-s1 merged zion's rows at 08:21 UTC for the first time since 2026-09-06, and yosemite-m5 at 08:51 UTC. The publisher side is not fixed: zion's own exchange still times out on nearly every tick, its last landed snapshot is 08:08 UTC, and the real launch at 08:52 UTC still said `no healthy device can run claude`.

<section class="artifact-grid artifact-grid-2">
  <article class="artifact-panel">
    <h3>Today: the launch you saw</h3>
    <pre><code>$ agents run claude --interactive \
    --device auto --cwd ~/src/…/agi-menu
Error: agents: no healthy device can run claude
  [pool: workers: yosemite-s0, m5, m2,
                  m3, m1, m0, s1]
  excluded: yosemite-s0
              (no ready harness account),
            yosemite-m5
              (no ready harness account), …
  earliest window resets unknown</code></pre>
    <p>Observed 2026-09-10 18:00 PDT (your screenshot) and reproduced 2026-09-11 08:52 UTC after the 1.22.100 rollout.</p>
  </article>
  <article class="artifact-panel">
    <h3>After the plan: the same launch</h3>
    <pre><code>$ agents run claude --interactive \
    --device auto --cwd ~/src/…/agi-menu
[agents] device auto → yosemite-m5
         (load 3%, usage from zion: 12% weekly)
[agents] account balanced → &lt;account&gt;
         (verified 0m ago)
… claude opens on yosemite-m5</code></pre>
    <p>Mockup. The wording follows the existing placement banner fields in <code>applyDeviceAutoToOptions</code> (host label, device hint, account note).</p>
  </article>
</section>

**How it gets resolved, in four steps.** Each step has an owner, a gate, and a proof. Nothing is called done until the real launch above succeeds from zion.

1. **Placement carries the requester's usage** (agents-cli, [`hosts/ready.ts`](https://github.com/phnx-labs/agents-cli/blob/v1.22.100/cli/src/lib/hosts/ready.ts#L282) and [`teams/placement-probe.ts`](https://github.com/phnx-labs/agents-cli/blob/v1.22.100/cli/src/lib/teams/placement-probe.ts)). The worker's `agents view --json` still reports which accounts are installed and launchable; freshness and headroom come from the requester's own usage cache keyed by account identity. The 40-minute rule remains, but only as a ranking weight, never an exclusion. Gate: independent review. Proof: [`ready.test.ts`](https://github.com/phnx-labs/agents-cli/blob/v1.22.100/cli/src/lib/hosts/ready.test.ts) asserts a launchable account with a stale worker-side copy and a fresh requester-side reading is eligible, and the local and remote verdicts agree for the same row.
2. **`personal` becomes a device sentinel** (agents-cli, [`hosts/routing-flag.ts`](https://github.com/phnx-labs/agents-cli/blob/v1.22.100/cli/src/lib/hosts/routing-flag.ts), [`device-config.ts`](https://github.com/phnx-labs/agents-cli/blob/v1.22.100/cli/src/lib/device-config.ts)). `--device personal` resolves from the actor identity ([`AGENTS_ACTOR`](https://github.com/phnx-labs/agents-cli/blob/v1.22.100/cli/src/lib/actor.ts)) to that identity's device with role `personal`; today that is one device fleet-wide, zion. This is the first Phoenix ID hook: identity to device. Gate: review. Proof: `agents view claude --device personal --json` from a worker returns zion's table.
3. **Ping pong for headless launches** (agents-cli, [`accounting/rotate.ts`](https://github.com/phnx-labs/agents-cli/blob/v1.22.100/cli/src/lib/accounting/rotate.ts), `resolveRunVersion`). A launch that does not start on a headed device, such as a teammate on a worker or a monitor-triggered run, makes one bounded call to `agents view <harness> --device personal --json` when its own reading is stale or absent, and falls back to blind weighting if the personal device is unreachable. One hop per launch, never a tick, so it does not reopen the PHNX-3609 fan-out. Gate: review. Proof: a run dispatched from yosemite-m5 places and starts without `NO_VERIFIED_USAGE`.
4. **Release 1.22.101 and prove it end to end.** `scripts/release.sh 1.22.101 --apply`, `agents fleet update`, then the real command from zion and from a worker, quoted on PHNX-4051. Only then does the ticket close.

<div class="artifact-callout">
What this plan does not do: it does not repair zion's stalling git exchange or its daemon restarts. After step 1 those become a background nuisance rather than an outage, and they get their own ticket with per-step timing in the exchange's failure message as the first task.
</div>

## Data

Every number here comes from a command run in session 4aad4973 on the date shown, with the record it was read from. Ages are relative to the time of the command.

| Fact | Value | Record | When (UTC) |
| --- | --- | --- | --- |
| Placement refused every worker | 7 of 7 excluded, `no ready harness account` | screenshot of the extension terminal; installed `smart-launch.js:177`, source [`smart-launch.ts#L238`](https://github.com/phnx-labs/agents-cli/blob/v1.22.100/cli/src/lib/smart-launch.ts#L238) | 2026-09-11 01:04 |
| Freshness cutoff | 40 min (`USAGE_STALE_REFUSAL_MAX_AGE_MS`) | installed `rotate.js:164`, source [`rotate.ts#L296`](https://github.com/phnx-labs/agents-cli/blob/v1.22.100/cli/src/lib/accounting/rotate.ts#L296) | installed 1.22.98 |
| Gate that refuses | `fresh = usageFresh && authFresh`; `ready = launchable && fresh …` | installed `ready.js:238-253`, source [`ready.ts#L282`](https://github.com/phnx-labs/agents-cli/blob/v1.22.100/cli/src/lib/hosts/ready.ts#L282); added in [`c48c17a43`](https://github.com/phnx-labs/agents-cli/commit/c48c17a43) (PHNX-3940, 2026-09-04) | installed 1.22.98 |
| zion's own readings while workers were refused | 0 to 4 min old for the same accounts | `agents view --json` on zion, `ages.mjs` | 2026-09-11 01:15 |
| yosemite-s1 reading | 1049 min old, `signedIn: true, launchable: true` | `agents view --json` on s1, `ages.mjs` | 2026-09-11 01:04 |
| s1 exchange failures | 186× `git output exceeded 1 MiB` since 09-07 15:44; 375× `git rebase timed out` since 09-06 14:37 | s1 `~/.agents/.cache/helpers/daemon/logs.jsonl` | 2026-09-11 01:20 |
| s1 untracked listing | 1,125,024 bytes, 10,921 files, mostly `artifact-history/` | `git ls-files --others --exclude-standard -z \| wc -c` on s1 | 2026-09-11 01:20 |
| zion transport failures, 24 h | 95× lock held, 36× rebase timeout, 12× GitHub ssh, 4× fetch timeout | zion daemon log | 2026-09-11 01:10 |
| Fixes merged | [#3589](https://github.com/phnx-labs/agents-cli/pull/3589) (0fa3dff98), [#3590](https://github.com/phnx-labs/agents-cli/pull/3590) (796c7fc4b) | phnx-labs/agents-cli | 2026-09-11 02:19, 02:41 |
| Released and rolled out | 1.22.100; 8 of 11 online boxes ok, s1 on retry | `scripts/release.sh`, `agents fleet update` | 2026-09-11 07:45, 08:13 |
| Worker pull restored | s1 `merged 6 row(s) from zion`; m5 `merged 8 row(s) from zion` | worker daemon logs | 2026-09-11 08:21, 08:51 |
| Publisher still failing | 4× `git rebase timed out` after rollout; rebase never starts (no rebase entry in `.git/logs/HEAD` after 08:08; index mtime equals the commit time 08:44:38) | zion daemon log, `.git/logs/HEAD`, `stat .git/index` | 2026-09-11 08:52 |
| Same operations outside the daemon | rebase 0.77 s (throwaway worktree), status 0.36 s, fetch 1.6 s, ssh github 1.2 s | `/usr/bin/time` on zion | 2026-09-11 08:48 |
| zion daemon restarts | 2 to 12 per hour, every hour of 2026-09-11 | zion daemon log, `Daemon started` count per hour | 2026-09-11 08:50 |
| Real launch after rollout | still `no healthy device` | `agents run claude --device auto --mode plan` from zion | 2026-09-11 08:52 |

## Figure

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg class="artifact-diagram" viewBox="0 0 1180 640" role="img" aria-label="Two UML sequence diagrams: today's placement reads a stale copied usage number on the worker and refuses; the proposed placement uses the launching device's own live number and places">
  <defs>
    <marker id="sync" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#c8c8c8"/></marker>
    <marker id="syncRed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#D55E00"/></marker>
    <marker id="reply" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 M0,10 L10,5" stroke="#c8c8c8" stroke-width="1.5" fill="none"/></marker>
    <marker id="asyncBlue" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 M0,10 L10,5" stroke="#56B4E9" stroke-width="1.5" fill="none"/></marker>
  </defs>

  <text x="20" y="26" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">TODAY  ·  the worker judges its account by a copied number</text>
  <text x="610" y="26" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">PROPOSED  ·  the launching device brings its own live number</text>
  <line x1="590" y1="10" x2="590" y2="560" stroke="#8a8a8a" stroke-width="1" stroke-dasharray="2 4"/>

  <rect x="30" y="40" width="120" height="30" rx="4" fill="#16120a" stroke="#E69F00" stroke-width="1.5"/>
  <text x="90" y="60" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">zion (personal)</text>
  <rect x="210" y="40" width="120" height="30" rx="4" fill="#0e1418" stroke="#56B4E9" stroke-width="1.5"/>
  <text x="270" y="60" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">origin (git repo)</text>
  <rect x="390" y="40" width="120" height="30" rx="4" fill="#0f160a" stroke="#009E73" stroke-width="1.5"/>
  <text x="450" y="60" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">worker (yosemite)</text>
  <line x1="90" y1="70" x2="90" y2="540" stroke="#8a8a8a" stroke-width="1" stroke-dasharray="4 4"/>
  <line x1="270" y1="70" x2="270" y2="540" stroke="#8a8a8a" stroke-width="1" stroke-dasharray="4 4"/>
  <line x1="450" y1="70" x2="450" y2="540" stroke="#8a8a8a" stroke-width="1" stroke-dasharray="4 4"/>

  <rect x="40" y="86" width="500" height="150" rx="3" fill="none" stroke="#8a8a8a" stroke-width="1"/>
  <rect x="40" y="86" width="190" height="18" fill="#0e1418" stroke="#8a8a8a" stroke-width="1"/>
  <text x="48" y="99" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">loop  every 15 min (daemon tick)</text>
  <rect x="85" y="110" width="10" height="110" fill="#E69F00" opacity="0.9"/>
  <text x="100" y="124" font-family="JetBrains Mono, monospace" font-size="10" fill="#E69F00">read own OAuth usage (fresh, 0 min)</text>
  <line x1="95" y1="150" x2="262" y2="150" stroke="#D55E00" stroke-width="1.5" marker-end="url(#syncRed)"/>
  <text x="104" y="143" text-anchor="start" font-family="JetBrains Mono, monospace" font-size="10" fill="#D55E00">commit, rebase, push</text>
  <text x="104" y="165" text-anchor="start" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#D55E00">times out most ticks (45 s budget)</text>
  <line x1="278" y1="200" x2="442" y2="200" stroke="#56B4E9" stroke-width="1.5" marker-end="url(#asyncBlue)"/>
  <text x="360" y="193" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#56B4E9">pull, merge rows (copy)</text>
  <text x="360" y="215" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">copy ages while pushes fail</text>

  <text x="20" y="266" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">user launches with --device auto</text>
  <rect x="85" y="272" width="10" height="200" fill="#E69F00" opacity="0.9"/>
  <line x1="95" y1="290" x2="442" y2="290" stroke="#c8c8c8" stroke-width="1.5" marker-end="url(#sync)"/>
  <text x="268" y="283" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">ssh: agents view --json</text>
  <rect x="445" y="290" width="10" height="60" fill="#009E73" opacity="0.9"/>
  <line x1="442" y1="340" x2="95" y2="340" stroke="#c8c8c8" stroke-width="1.5" stroke-dasharray="5 3" marker-end="url(#reply)"/>
  <text x="268" y="333" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">accounts + copied usage (1049 min old)</text>
  <rect x="40" y="360" width="500" height="70" rx="3" fill="#16120a" stroke="#D55E00" stroke-width="1.5"/>
  <text x="52" y="378" font-family="JetBrains Mono, monospace" font-size="10" fill="#D55E00">viewAgentAccountEligibility: usageFresh = age ≤ 40 min → false</text>
  <text x="52" y="396" font-family="JetBrains Mono, monospace" font-size="10" fill="#D55E00">ready = launchable &amp;&amp; fresh → false   (ready.js:238-253)</text>
  <text x="52" y="414" font-family="JetBrains Mono, monospace" font-size="10" fill="#D55E00">eligiblePool = []  →  throw "no healthy device can run claude"</text>
  <text x="52" y="456" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">zion's own table at the same moment: the same account, 0 min old.</text>
  <text x="52" y="472" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">The requester had the number and used the worker's stale copy instead.</text>

  <rect x="620" y="40" width="140" height="30" rx="4" fill="#16120a" stroke="#E69F00" stroke-width="1.5"/>
  <text x="690" y="60" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">requester (headed)</text>
  <rect x="830" y="40" width="140" height="30" rx="4" fill="#0f160a" stroke="#009E73" stroke-width="1.5"/>
  <text x="900" y="60" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">worker (yosemite)</text>
  <rect x="1030" y="40" width="130" height="30" rx="4" fill="#16120a" stroke="#E69F00" stroke-width="1.5"/>
  <text x="1095" y="60" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">--device personal</text>
  <line x1="690" y1="70" x2="690" y2="540" stroke="#8a8a8a" stroke-width="1" stroke-dasharray="4 4"/>
  <line x1="900" y1="70" x2="900" y2="540" stroke="#8a8a8a" stroke-width="1" stroke-dasharray="4 4"/>
  <line x1="1095" y1="70" x2="1095" y2="540" stroke="#8a8a8a" stroke-width="1" stroke-dasharray="4 4"/>

  <text x="610" y="100" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">Step 1 · common case: launch from a personal or desktop device</text>
  <rect x="685" y="108" width="10" height="200" fill="#E69F00" opacity="0.9"/>
  <text x="700" y="122" font-family="JetBrains Mono, monospace" font-size="10" fill="#E69F00">own OAuth usage, every account</text>
  <line x1="695" y1="150" x2="892" y2="150" stroke="#c8c8c8" stroke-width="1.5" marker-end="url(#sync)"/>
  <text x="793" y="143" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">ssh: agents view --json</text>
  <rect x="895" y="150" width="10" height="50" fill="#009E73" opacity="0.9"/>
  <line x1="892" y1="190" x2="695" y2="190" stroke="#c8c8c8" stroke-width="1.5" stroke-dasharray="5 3" marker-end="url(#reply)"/>
  <text x="793" y="183" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">launchable accounts only</text>
  <rect x="620" y="210" width="360" height="70" rx="3" fill="#0f160a" stroke="#009E73" stroke-width="1.5"/>
  <text x="632" y="228" font-family="JetBrains Mono, monospace" font-size="10" fill="#009E73">eligible = launchable  (no freshness exclusion)</text>
  <text x="632" y="246" font-family="JetBrains Mono, monospace" font-size="10" fill="#009E73">rank by requester's usage[identity]; stale → weight low</text>
  <text x="632" y="264" font-family="JetBrains Mono, monospace" font-size="10" fill="#009E73">place on yosemite-m5 with the best-headroom account</text>

  <text x="610" y="330" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">Step 3 · headless case: a run that starts on a worker (teammate, monitor)</text>
  <rect x="895" y="338" width="10" height="150" fill="#009E73" opacity="0.9"/>
  <text x="910" y="349" font-family="JetBrains Mono, monospace" font-size="10" fill="#009E73">own reading stale or absent</text>
  <line x1="905" y1="388" x2="1087" y2="388" stroke="#c8c8c8" stroke-width="1.5" marker-end="url(#sync)"/>
  <text x="996" y="369" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">agents view claude</text>
  <text x="996" y="381" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">--device personal --json</text>
  <rect x="1090" y="380" width="10" height="40" fill="#E69F00" opacity="0.9"/>
  <line x1="1087" y1="412" x2="905" y2="412" stroke="#c8c8c8" stroke-width="1.5" stroke-dasharray="5 3" marker-end="url(#reply)"/>
  <text x="996" y="405" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">live usage table (one hop)</text>
  <text x="910" y="446" font-family="JetBrains Mono, monospace" font-size="10" fill="#009E73">balanced pick, live number</text>
  <text x="610" y="500" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">If the personal device is unreachable: blind weighting, never a refusal.</text>
  <text x="610" y="516" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">Step 2 resolves "personal" from the actor identity (AGENTS_ACTOR) to that identity's role=personal device.</text>
  <text x="610" y="532" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">The 15-minute git copy keeps running for humans reading agents view on a worker; it no longer gates any launch.</text>

  <rect x="20" y="570" width="1140" height="56" rx="4" fill="#0e1418" stroke="#8a8a8a" stroke-width="1"/>
  <text x="32" y="588" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">Legend (UML sequence):</text>
  <line x1="150" y1="584" x2="200" y2="584" stroke="#c8c8c8" stroke-width="1.5" marker-end="url(#sync)"/><text x="206" y="588" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">synchronous call</text>
  <line x1="320" y1="584" x2="370" y2="584" stroke="#c8c8c8" stroke-width="1.5" stroke-dasharray="5 3" marker-end="url(#reply)"/><text x="376" y="588" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">reply</text>
  <line x1="430" y1="584" x2="480" y2="584" stroke="#56B4E9" stroke-width="1.5" marker-end="url(#asyncBlue)"/><text x="486" y="588" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">asynchronous delivery (git)</text>
  <line x1="650" y1="584" x2="700" y2="584" stroke="#D55E00" stroke-width="1.5" marker-end="url(#syncRed)"/><text x="706" y="588" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">the call that fails today</text>
  <rect x="860" y="578" width="10" height="12" fill="#E69F00"/><text x="876" y="588" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">headed device (real OAuth login)</text>
  <rect x="1040" y="578" width="10" height="12" fill="#009E73"/><text x="1056" y="588" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">worker (setup token)</text>
  <text x="32" y="612" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">Colours are Okabe-Ito. Ages and timestamps are from the records in the Data table, 2026-09-11.</text>
</svg>
<figcaption>Left: what happened on 2026-09-11 01:04 UTC, message by message. Right: the proposed flow for the two launch origins. Placement never reads a copied number again; the git copy survives only for humans.</figcaption>
</figure>

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg class="artifact-diagram" viewBox="0 0 1180 330" role="img" aria-label="Swimlane of the four resolution steps with review and proof gates, by owner">
  <defs>
    <marker id="flow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#c8c8c8"/></marker>
  </defs>
  <text x="20" y="24" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">HOW IT GETS RESOLVED  ·  four steps, each behind a review gate and a real-flow proof</text>
  <rect x="20" y="40" width="130" height="80" fill="#0e1418" stroke="#8a8a8a" stroke-width="1"/><text x="85" y="84" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">you decide</text>
  <rect x="20" y="120" width="130" height="90" fill="#0e1418" stroke="#8a8a8a" stroke-width="1"/><text x="85" y="160" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">agent builds</text><text x="85" y="176" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">worktree + PR</text>
  <rect x="20" y="210" width="130" height="90" fill="#0e1418" stroke="#8a8a8a" stroke-width="1"/><text x="85" y="259" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">fleet proves</text>
  <line x1="150" y1="40" x2="1160" y2="40" stroke="#8a8a8a" stroke-width="1"/><line x1="150" y1="120" x2="1160" y2="120" stroke="#8a8a8a" stroke-width="1"/><line x1="150" y1="210" x2="1160" y2="210" stroke="#8a8a8a" stroke-width="1"/><line x1="150" y1="300" x2="1160" y2="300" stroke="#8a8a8a" stroke-width="1"/>

  <polygon points="200,80 240,55 280,80 240,105" fill="#16120a" stroke="#E69F00" stroke-width="1.5"/>
  <text x="240" y="84" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">approve?</text>
  <text x="300" y="66" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">this plan: placement uses the requester's usage;</text>
  <text x="300" y="80" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">"personal" sentinel; ping pong for headless launches.</text>
  <text x="300" y="94" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">reverses the PHNX-3940 exclusion (2026-09-04), keeps it as a weight</text>
  <line x1="240" y1="105" x2="240" y2="135" stroke="#c8c8c8" stroke-width="1.5" marker-end="url(#flow)"/>
  <text x="248" y="124" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">yes</text>

  <rect x="180" y="140" width="200" height="50" rx="3" fill="#0f160a" stroke="#009E73" stroke-width="1.5"/>
  <text x="280" y="160" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">1 · placement uses requester usage</text>
  <text x="280" y="176" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#009E73">ready.ts · placement-probe.ts · tests</text>
  <line x1="380" y1="165" x2="410" y2="165" stroke="#c8c8c8" stroke-width="1.5" marker-end="url(#flow)"/>
  <rect x="412" y="140" width="200" height="50" rx="3" fill="#0f160a" stroke="#009E73" stroke-width="1.5"/>
  <text x="512" y="160" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">2 · "personal" device sentinel</text>
  <text x="512" y="176" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#009E73">routing-flag.ts · actor identity</text>
  <line x1="612" y1="165" x2="642" y2="165" stroke="#c8c8c8" stroke-width="1.5" marker-end="url(#flow)"/>
  <rect x="644" y="140" width="200" height="50" rx="3" fill="#0f160a" stroke="#009E73" stroke-width="1.5"/>
  <text x="744" y="160" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">3 · ping pong for headless runs</text>
  <text x="744" y="176" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#009E73">rotate.ts resolveRunVersion</text>
  <line x1="844" y1="165" x2="874" y2="165" stroke="#c8c8c8" stroke-width="1.5" marker-end="url(#flow)"/>
  <polygon points="876,165 916,140 956,165 916,190" fill="#0e1418" stroke="#56B4E9" stroke-width="1.5"/>
  <text x="916" y="169" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">review</text>
  <text x="966" y="160" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">non-author verdict per PR;</text>
  <text x="966" y="174" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">CHANGES REQUESTED loops back</text>
  <line x1="916" y1="190" x2="916" y2="228" stroke="#c8c8c8" stroke-width="1.5" marker-end="url(#flow)"/>

  <rect x="180" y="230" width="220" height="50" rx="3" fill="#16120a" stroke="#E69F00" stroke-width="1.5"/>
  <text x="290" y="250" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">4 · release 1.22.101, fleet update</text>
  <text x="290" y="266" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#E69F00">release.sh --apply · agents fleet update</text>
  <line x1="400" y1="255" x2="430" y2="255" stroke="#c8c8c8" stroke-width="1.5" marker-end="url(#flow)"/>
  <rect x="432" y="230" width="330" height="50" rx="3" fill="#16120a" stroke="#E69F00" stroke-width="1.5"/>
  <text x="597" y="250" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">proof: the real command succeeds</text>
  <text x="597" y="266" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#E69F00">agents run claude --device auto  (from zion and from a worker)</text>
  <line x1="762" y1="255" x2="792" y2="255" stroke="#c8c8c8" stroke-width="1.5" marker-end="url(#flow)"/>
  <polygon points="794,255 834,230 874,255 834,280" fill="#0e1418" stroke="#56B4E9" stroke-width="1.5"/>
  <text x="834" y="259" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">placed?</text>
  <line x1="874" y1="255" x2="904" y2="255" stroke="#c8c8c8" stroke-width="1.5" marker-end="url(#flow)"/>
  <text x="880" y="248" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">yes</text>
  <rect x="906" y="230" width="150" height="50" rx="3" fill="#0f160a" stroke="#009E73" stroke-width="1.5"/>
  <text x="981" y="250" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">PHNX-4051 closed</text>
  <text x="981" y="266" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#009E73">with quoted output</text>
  <text x="834" y="296" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#D55E00">no → back to step 1, not "done"</text>
  <text x="20" y="322" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">Diamonds are decisions (ISO 5807). zion's daemon stall gets its own ticket after step 1 and does not block this path.</text>
</svg>
<figcaption>Owner lanes: your one decision, the three code steps behind independent review, and the fleet-side release and proof. The ticket closes only on the quoted successful launch.</figcaption>
</figure>
