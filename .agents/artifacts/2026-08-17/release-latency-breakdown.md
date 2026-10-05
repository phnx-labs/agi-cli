---
kind: visual
title: "Why the 1.22.40 release took 18 minutes — and the path to 60 seconds"
summary: >-
  The v1.22.40 release ran 18m24s against a 180s budget (and a new 60s bar).
  93% of the wall clock was one thing: the required CI check re-executing the
  full test suite on a cold 2-core GitHub runner — a suite that runs in 169s
  on zion. The fix is wiring already-merged machinery together, not inventing
  new machinery.
status: draft
context: agents-cli release latency (RUSH-2666, RUSH-2766)
facts:
  - "Release end-to-end: 18m24s (producer start 09:12:35Z, npm live 09:30:59Z)"
  - "Required CI test job: 15m09s, of which 14m52s was test execution and 17s was harness overhead"
  - "Identical suite wall time on zion: 169s — the CI runner is 5.3x slower"
  - "Proof-reuse fast lane exists and works: a dependabot PR settled in 28s"
  - "Budget: 180s committed (AGENTS.md); owner directive 2026-08-17: 60s for CI and release alike"
---

## Story

The user-visible question: **why did shipping v1.22.40 take 18 minutes when the
committed budget is 3 minutes — and the new bar is 1 minute?**

The answer decomposes cleanly, because every phase was measured today:

1. **The required CI check is 93% of the problem.** The release PR's `test` job
   ran 15m09s. Harness overhead (checkout, bun, impact planning, cache probes)
   was **17 seconds**. The remaining **14m52s was one step** — executing the
   selected tests on `ubuntu-latest`. Two multipliers stack there:
   the impact planner selected essentially the **whole suite** (a release PR
   touches `package.json` + CHANGELOG, which maps wide), and the cold 2-core
   GitHub runner executes that suite **5.3x slower** than zion (892s vs 169s).
2. **The attestation producer ran inside the release path (~5 min).** By design
   it should run on every main push and be already-done at release time; the
   producer lane doesn't exist yet (RUSH-2766 defect 2), so the release paid
   for it inline.
3. **The merge was attempted mid-CI and failed, costing a retry cycle.**
   `release.sh` calls a plain squash-merge; GitHub refused ("base branch policy
   prohibits the merge") because the required check was still running. The
   merge only landed 62s after checks settled — but the failed attempt burned a
   lease cycle and an agent re-invoke.
4. **The helper-manifest gate failed structurally (RUSH-2766 defect 1).**
   `hash_tree` digests embed absolute paths, and release worktrees embed a PID,
   so the reuse check can never match across machines or even across runs. The
   promote failed once and was finished by recomputing the manifest by hand on
   mac-mini (~3 min including the failed attempt).

The strategic point: **the fast machinery is already merged, just not
connected.** The proof-reuse lane demonstrably works (28s on a dependabot PR).
The Firecracker executor is merged and benched at 42ms admission overhead — but
`tests.yml` still runs on `ubuntu-latest`. The producer exists as a manual
script but no lane invokes it on main pushes. Wiring these three, plus a
release-shaped impact mapping and `--auto` merge, takes the release from
18m24s to the order of a minute.

## Data

| Phase (2026-08-17, UTC) | Start → End | Duration | Budget share |
| --- | --- | --- | --- |
| Release branch push, required CI starts | 09:10:53 | — | — |
| CI harness overhead (checkout, bun, plan, cache probe) | 09:10:56 → 09:11:11 | 17s | 1.4% |
| CI "Selected proof" — test execution on ubuntu-latest | 09:11:11 → 09:26:03 | **14m52s** | **74%** |
| Attestation producer on zion (parallel lane) | 09:12:35 → ~09:17 | ~5m | overlapped |
| release.sh run-3: phases 1–3, merge attempt → REFUSED | 09:18 → 09:19 | 1m | 5% |
| Idle: waiting for CI to settle | 09:19 → 09:26:05 | 7m05s | (inside CI wait) |
| release.sh run-4: merge PR #2738 | 09:26:55 → 09:27:57 | 62s | 5% |
| Tag v1.22.40 + proof upload | ~09:28 | ~30s | 2.5% |
| Promote on mac-mini: helper gate FAIL → manual manifest fix → npm publish | ~09:29 → 09:30:59 | ~3m | 15% |
| **Total (producer start → npm live)** | 09:12:35 → 09:30:59 | **18m24s** | 6.1× the 180s budget |

| Evidence for the two CI multipliers | Value |
| --- | --- |
| Suite wall time, GitHub `ubuntu-latest` (2 cores, cold) | 892s |
| Same suite wall time, zion (M-series, warm) | 169s |
| Runner gap | **5.3×** |
| Dependabot PR (tiny mapped selection + proof reuse) | **28s** |
| Release PR (package.json/CHANGELOG → wide selection) | 15m09s |
| Selection gap | **32×** |

## Figure

<figure>
<svg viewBox="0 0 920 400" xmlns="http://www.w3.org/2000/svg" font-family="'JetBrains Mono',ui-monospace,monospace" font-size="11">
  <title>Waterfall of the v1.22.40 release, 09:10:53 to 09:30:59 UTC</title>
  <!-- time scale: x = 70 + (seconds_since_09:10:53) * 0.68 ; total span 1206s -->
  <!-- grid + axis -->
  <g stroke="#8884" stroke-width="1">
    <line x1="70" y1="30" x2="70" y2="330"/>
    <line x1="70" y1="330" x2="890" y2="330"/>
    <line x1="274" y1="30" x2="274" y2="330" stroke-dasharray="3 4"/>
    <line x1="478" y1="30" x2="478" y2="330" stroke-dasharray="3 4"/>
    <line x1="682" y1="30" x2="682" y2="330" stroke-dasharray="3 4"/>
    <line x1="886" y1="30" x2="886" y2="330" stroke-dasharray="3 4"/>
  </g>
  <g fill="#888" text-anchor="middle">
    <text x="70" y="348">09:10:53</text>
    <text x="274" y="348">09:15</text>
    <text x="478" y="348">09:20</text>
    <text x="682" y="348">09:25</text>
    <text x="886" y="348">09:31</text>
  </g>

  <!-- Row 1: required CI -->
  <text x="62" y="72" text-anchor="end" fill="#888">required CI</text>
  <rect x="72" y="58" width="10" height="20" fill="#a3e635" rx="2">
    <title>overhead: checkout + bun + impact plan + cache probes — 17s</title>
  </rect>
  <rect x="82" y="58" width="595" height="20" fill="#ef4444" rx="2" opacity="0.85">
    <title>"Selected proof": full selected suite on ubuntu-latest — 14m52s</title>
  </rect>
  <text x="380" y="72" text-anchor="middle" fill="#fff" font-weight="bold">test execution on ubuntu-latest — 14m52s (93% of the critical path)</text>
  <text x="686" y="52" fill="#888">settles 09:26:05</text>

  <!-- Row 2: producer -->
  <text x="62" y="122" text-anchor="end" fill="#888">producer (zion)</text>
  <rect x="139" y="108" width="185" height="20" fill="#60a5fa" rx="2" opacity="0.85">
    <title>attestation producer: install + build + 169s suite + pack + attest — ~5m, parallel</title>
  </rect>
  <text x="232" y="122" text-anchor="middle" fill="#fff">suite 169s + pack ≈ 5m</text>

  <!-- Row 3: merge attempts -->
  <text x="62" y="172" text-anchor="end" fill="#888">release.sh</text>
  <rect x="360" y="158" width="41" height="20" fill="#f59e0b" rx="2">
    <title>run-3: phases 1–3, squash-merge attempted mid-CI — REFUSED by branch policy</title>
  </rect>
  <text x="380" y="152" text-anchor="middle" fill="#f59e0b">merge REFUSED (CI running)</text>
  <rect x="716" y="158" width="42" height="20" fill="#a3e635" rx="2">
    <title>run-4: squash-merge succeeds 09:27:57, 62s after checks settled</title>
  </rect>
  <text x="737" y="152" text-anchor="middle" fill="#888">merged</text>

  <!-- Row 4: tag + promote -->
  <text x="62" y="222" text-anchor="end" fill="#888">tag + promote</text>
  <rect x="758" y="208" width="20" height="20" fill="#a3e635" rx="2">
    <title>tag v1.22.40 + proof upload ≈ 30s</title>
  </rect>
  <rect x="778" y="208" width="46" height="20" fill="#ef4444" rx="2" opacity="0.85">
    <title>mac-mini promote: helper digest gate fails (RUSH-2766) — absolute-path hashes can never match</title>
  </rect>
  <rect x="824" y="208" width="62" height="20" fill="#60a5fa" rx="2" opacity="0.85">
    <title>manual manifest recompute in a fixed-path worktree + npm publish</title>
  </rect>
  <text x="800" y="202" text-anchor="middle" fill="#ef4444">gate FAIL</text>
  <text x="856" y="202" text-anchor="middle" fill="#888">fix+publish</text>

  <!-- Row 5: npm live marker -->
  <line x1="886" y1="240" x2="886" y2="300" stroke="#a3e635" stroke-width="2"/>
  <text x="880" y="296" text-anchor="end" fill="#a3e635" font-weight="bold">npm live 09:30:59</text>

  <!-- budget markers -->
  <line x1="192" y1="260" x2="192" y2="300" stroke="#a3e635" stroke-width="1.5" stroke-dasharray="5 3"/>
  <text x="196" y="296" fill="#888">180s budget would end here</text>
  <line x1="111" y1="260" x2="111" y2="300" stroke="#a3e635" stroke-width="1.5" stroke-dasharray="2 3"/>
  <text x="108" y="272" text-anchor="end" fill="#888">60s bar</text>

  <!-- legend -->
  <g transform="translate(70,375)">
    <rect x="0" y="-10" width="12" height="12" fill="#ef4444" opacity="0.85"/><text x="18" y="0" fill="#888">wasted / avoidable</text>
    <rect x="170" y="-10" width="12" height="12" fill="#60a5fa" opacity="0.85"/><text x="188" y="0" fill="#888">work that should be amortized or faster</text>
    <rect x="470" y="-10" width="12" height="12" fill="#a3e635"/><text x="488" y="0" fill="#888">irreducible release mechanics</text>
    <rect x="700" y="-10" width="12" height="12" fill="#f59e0b"/><text x="718" y="0" fill="#888">flow bug</text>
  </g>
</svg>
<figcaption><strong>Fig 1 — Where 18m24s went.</strong> One red bar dominates: executing the (over-)selected suite on a cold GitHub runner. Everything the release actually needed to do — merge, tag, promote, publish — fits inside the last two minutes. Hover any bar for detail.</figcaption>
</figure>

<figure>
<svg viewBox="0 0 920 330" xmlns="http://www.w3.org/2000/svg" font-family="'JetBrains Mono',ui-monospace,monospace" font-size="11">
  <title>The two stacked multipliers behind the 15-minute check</title>
  <text x="20" y="28" font-size="13" font-weight="bold" fill="#888">Multiplier 1 — the runner (same suite, same commit)</text>
  <!-- zion bar: 169s -->
  <text x="150" y="58" text-anchor="end" fill="#888">zion (warm, M-series)</text>
  <rect x="160" y="44" width="97" height="18" fill="#a3e635" rx="2"><title>169 seconds</title></rect>
  <text x="264" y="58" fill="#a3e635" font-weight="bold">169s</text>
  <!-- CI bar: 892s -->
  <text x="150" y="86" text-anchor="end" fill="#888">ubuntu-latest (cold, 2-core)</text>
  <rect x="160" y="72" width="513" height="18" fill="#ef4444" opacity="0.85" rx="2"><title>892 seconds</title></rect>
  <text x="680" y="86" fill="#ef4444" font-weight="bold">892s = 5.3×</text>

  <text x="20" y="140" font-size="13" font-weight="bold" fill="#888">Multiplier 2 — the selection (same workflow, different diff)</text>
  <!-- dependabot: 28s -->
  <text x="150" y="170" text-anchor="end" fill="#888">workflow-only diff</text>
  <rect x="160" y="156" width="16" height="18" fill="#a3e635" rx="2"><title>dependabot actions/cache bump: 28 seconds — tiny mapped selection + proof reuse</title></rect>
  <text x="184" y="170" fill="#a3e635" font-weight="bold">28s (the fast lane works)</text>
  <!-- release PR: 909s -->
  <text x="150" y="198" text-anchor="end" fill="#888">release diff (pkg.json+CHANGELOG)</text>
  <rect x="160" y="184" width="523" height="18" fill="#ef4444" opacity="0.85" rx="2"><title>release PR #2738: 15m09s — the version bump maps to the whole suite</title></rect>
  <text x="690" y="198" fill="#ef4444" font-weight="bold">15m09s = 32×</text>

  <g transform="translate(20,250)">
    <text x="0" y="0" font-size="13" font-weight="bold" fill="#888">Stacked: wide selection × slow runner = the 93% bar in Fig 1</text>
    <text x="0" y="22" fill="#888">A release PR changes no product code — its tree was already attested by the producer minutes earlier.</text>
    <text x="0" y="40" fill="#888">The exact-tree proof cache SHOULD have short-circuited the run; the producer's attestation never reaches</text>
    <text x="0" y="58" fill="#888">the GitHub Actions cache, so the check re-derived from scratch what zion had already proven.</text>
  </g>
</svg>
<figcaption><strong>Fig 2 — Two independent multipliers stack.</strong> Fixing either one helps; fixing both (run the right amount of work, in the right place) is what reaches the 60-second bar.</figcaption>
</figure>

<figure>
<svg viewBox="0 0 920 560" xmlns="http://www.w3.org/2000/svg" font-family="'JetBrains Mono',ui-monospace,monospace" font-size="11">
  <title>Flame breakdown of the 14m52s Selected proof step</title>
  <text x="20" y="24" font-size="13" font-weight="bold" fill="#888">Inside the 14m52s — flame view (hover any segment)</text>

  <!-- L0: whole step, 892s -> 880px wide, x=20 -->
  <rect x="20" y="36" width="880" height="26" fill="#8886" rx="3"><title>"Selected proof" step: 09:11:11 → 09:26:03 = 892s total</title></rect>
  <text x="460" y="53" text-anchor="middle" fill="#fff" font-weight="bold">"Selected proof" step — 892s wall</text>

  <!-- L1: install 18s | vitest 855s | post 19s ; scale 880/892 = 0.9865 -->
  <rect x="20" y="66" width="18" height="26" fill="#a3e635" rx="2"><title>bun install: 223 packages, 18.01s</title></rect>
  <rect x="38" y="66" width="843" height="26" fill="#ef4444" opacity="0.8" rx="2"><title>vitest: Start 09:11:30, Duration 855.23s wall</title></rect>
  <rect x="881" y="66" width="19" height="26" fill="#a3e635" rx="2"><title>post-run tsc + proof write ≈ 19s</title></rect>
  <text x="459" y="83" text-anchor="middle" fill="#fff" font-weight="bold">vitest — 855s wall (870 test files, 12,331 tests, 2 cores)</text>
  <text x="29" y="105" fill="#888" font-size="10">install 18s</text>
  <text x="891" y="105" text-anchor="end" fill="#888" font-size="10">post 19s</text>

  <!-- L2: CPU-time decomposition of vitest across workers: import 354 + tests 2030 + transform 28 + setup 16 = 2428 CPU-s ; band x=38..881 (843px) -->
  <text x="20" y="130" fill="#888" font-size="10">CPU-seconds summed across the ~2.4 parallel forks (2,428s total squeezed into 855s wall):</text>
  <rect x="38" y="138" width="123" height="26" fill="#f59e0b" opacity="0.85" rx="2"><title>module IMPORT time: 353.66 CPU-s — the dependency graph re-imported per fork</title></rect>
  <rect x="161" y="138" width="705" height="26" fill="#ef4444" opacity="0.8" rx="2"><title>test execution: 2030.06 CPU-s</title></rect>
  <rect x="866" y="138" width="15" height="26" fill="#8888" rx="2"><title>transform 27.7s + setup 15.8s</title></rect>
  <text x="99" y="155" text-anchor="middle" fill="#fff" font-size="10">import 354s</text>
  <text x="513" y="155" text-anchor="middle" fill="#fff" font-weight="bold">tests — 2,030 CPU-s</text>

  <!-- L3: tests band by area; scale on the 705px tests band: measured per-file sum 1723s -> px = s * 0.409 ; x from 161 -->
  <text x="20" y="188" fill="#888" font-size="10">…the 2,030 CPU-s of tests, by area (801 files with measured durations, 1,724s attributed):</text>
  <rect x="161" y="196" width="380" height="26" fill="#ef4444" opacity="0.85" rx="2"><title>src/commands/** — 930s: 54% of ALL test time lives in command-surface tests</title></rect>
  <rect x="541" y="196" width="39"  height="26" fill="#f97316" opacity="0.85" rx="2"><title>lib/installations — 96s</title></rect>
  <rect x="580" y="196" width="32"  height="26" fill="#eab308" opacity="0.85" rx="2"><title>lib/secrets — 78s</title></rect>
  <rect x="612" y="196" width="30"  height="26" fill="#84cc16" opacity="0.85" rx="2"><title>lib/self-heal — 73s</title></rect>
  <rect x="642" y="196" width="25"  height="26" fill="#22c55e" opacity="0.85" rx="2"><title>lib/staleness — 62s</title></rect>
  <rect x="667" y="196" width="140" height="26" fill="#60a5fa" opacity="0.75" rx="2"><title>other lib/* — ~343s (session, daemon, git, plugins, tmux, …)</title></rect>
  <rect x="807" y="196" width="59"  height="26" fill="#8888" rx="2"><title>remaining areas + per-file overhead not attributed — ~145s</title></rect>
  <text x="351" y="213" text-anchor="middle" fill="#fff" font-weight="bold">src/commands/** — 930s (54%)</text>
  <text x="737" y="213" text-anchor="middle" fill="#fff" font-size="10">other lib/*</text>

  <!-- L4: top files inside commands band (380px = 930s -> 0.4086 px/s), x from 161 -->
  <text x="20" y="246" fill="#888" font-size="10">…and inside src/commands/**, four files are half of it:</text>
  <rect x="161" y="254" width="87" height="26" fill="#dc2626" rx="2"><title>routines.test.ts — 213.6s. THE LONG POLE: wall clock can never beat this file's own duration</title></rect>
  <rect x="248" y="254" width="70" height="26" fill="#ef4444" opacity="0.9" rx="2"><title>sessions.test.ts — 170.4s</title></rect>
  <rect x="318" y="254" width="44" height="26" fill="#f87171" opacity="0.9" rx="2"><title>daemon.test.ts — 108.3s</title></rect>
  <rect x="362" y="254" width="34" height="26" fill="#fca5a5" opacity="0.9" rx="2"><title>ssh.device-config.test.ts — 83.2s</title></rect>
  <rect x="396" y="254" width="24" height="26" fill="#fecaca" opacity="0.9" rx="2"><title>__tests__/inspect.test.ts — 57.5s</title></rect>
  <rect x="420" y="254" width="121" height="26" fill="#8886" rx="2"><title>the other ~180 command test files — ~297s combined</title></rect>
  <text x="204" y="271" text-anchor="middle" fill="#fff" font-size="10" font-weight="bold">routines 214s</text>
  <text x="283" y="271" text-anchor="middle" fill="#fff" font-size="10">sessions 170s</text>
  <text x="340" y="271" text-anchor="middle" fill="#fff" font-size="10">108s</text>

  <!-- long pole panel -->
  <g>
    <rect x="20" y="310" width="880" height="110" rx="6" fill="none" stroke="#dc2626"/>
    <text x="34" y="334" font-size="13" font-weight="bold" fill="#dc2626">The long-pole law: cores stop helping at 214 seconds</text>
    <text x="34" y="358" fill="#888">wall clock = max(longest single test file, total ÷ workers). With 16 cores: max(213.6s, 2030÷16 = 127s) = 213.6s.</text>
    <text x="34" y="376" fill="#888">routines.test.ts (213.6s), sessions.test.ts (170.4s), daemon.test.ts (108.3s) bound the floor on ANY hardware.</text>
    <text x="34" y="400" fill="#a3e635">→ the ≤60s bar requires BOTH the 16-core pool AND splitting/speeding the monster files (plan step 1.5) — no single file &gt; 45s.</text>
  </g>

  <!-- top-10 table -->
  <g fill="#888" font-size="10">
    <text x="20" y="448" font-weight="bold">Top 10 slowest files (of 870): 906s = 53% of all test time</text>
    <text x="20"  y="468">routines 213.6s · sessions 170.4s · daemon 108.3s · installations/versions 88.4s · ssh.device-config 83.2s</text>
    <text x="20"  y="486">self-heal/isolated-soak 70.9s · inspect 57.5s · sessions-bookmark 48.3s · secrets/vault 47.7s · lib/daemon 37.0s</text>
    <text x="20"  y="516">Also visible: 354 CPU-s of module IMPORT — every fork re-imports the heavy dependency graph; a warm box with a</text>
    <text x="20"  y="532">persistent bun cache and fewer, fatter workers cuts this before any test gets faster.</text>
  </g>
</svg>
<figcaption><strong>Fig 3 — Inside the 14m52s, level by level.</strong> Install and harness are seconds; vitest is everything. Of the 2,030 CPU-seconds of tests, 54% is <code>src/commands/**</code>, and four files are half of that. The red panel is the punchline: past 16 cores, the slowest single file — not hardware — sets the floor.</figcaption>
</figure>

<figure>
<svg viewBox="0 0 920 470" xmlns="http://www.w3.org/2000/svg" font-family="'JetBrains Mono',ui-monospace,monospace" font-size="11">
  <title>Current CI anatomy versus the target wiring</title>
  <!-- LEFT: today -->
  <text x="20" y="26" font-size="13" font-weight="bold" fill="#888">TODAY — tests.yml required job (measured 2026-08-17)</text>
  <g>
    <rect x="20" y="40" width="410" height="64" rx="6" fill="none" stroke="#8886"/>
    <text x="32" y="60" fill="#888">PR event → ubuntu-latest (cold VM)</text>
    <text x="32" y="78" fill="#888">checkout(fetch-depth:0) → setup-bun → policy pin</text>
    <text x="32" y="94" fill="#a3e635">17s total overhead — already excellent</text>
  </g>
  <line x1="225" y1="104" x2="225" y2="124" stroke="#888" marker-end="url(#arr)"/>
  <g>
    <rect x="20" y="124" width="410" height="78" rx="6" fill="none" stroke="#8886"/>
    <text x="32" y="144" fill="#888">ci-scope.ts: impact plan (1s) → proof-cache probe (0s)</text>
    <text x="32" y="162" fill="#ef4444">cache MISS: producer attestation for the SAME tree</text>
    <text x="32" y="178" fill="#ef4444">exists on zion but never reaches the Actions cache</text>
    <text x="32" y="196" fill="#888">→ falls through to full execution</text>
  </g>
  <line x1="225" y1="202" x2="225" y2="222" stroke="#888" marker-end="url(#arr)"/>
  <g>
    <rect x="20" y="222" width="410" height="64" rx="6" fill="none" stroke="#ef4444"/>
    <text x="32" y="244" fill="#ef4444" font-weight="bold">"Selected proof": run selected tests inline</text>
    <text x="32" y="262" fill="#ef4444">on the SAME 2-core VM — 14m52s</text>
    <text x="32" y="278" fill="#888">(deadline 1200s, nearly exhausted)</text>
  </g>

  <!-- RIGHT: target -->
  <text x="490" y="26" font-size="13" font-weight="bold" fill="#888">TARGET — same required check, three wires added</text>
  <g>
    <rect x="490" y="40" width="410" height="58" rx="6" fill="none" stroke="#8886"/>
    <text x="502" y="60" fill="#888">PR event → thin required job (identity unchanged)</text>
    <text x="502" y="78" fill="#a3e635">impact plan + proof probe: ~20s, as today</text>
  </g>
  <line x1="695" y1="98" x2="695" y2="118" stroke="#888" marker-end="url(#arr)"/>
  <g>
    <rect x="490" y="118" width="410" height="84" rx="6" fill="none" stroke="#a3e635"/>
    <text x="502" y="138" fill="#a3e635" font-weight="bold">WIRE 1 — proof bridge (attestation → Actions cache)</text>
    <text x="502" y="156" fill="#888">main-push producer lane writes ATTEST + manifest +</text>
    <text x="502" y="172" fill="#888">impact-proof for the tree; release PRs and rebases hit</text>
    <text x="502" y="188" fill="#a3e635">proof reuse → settle in ~30s (the dependabot path)</text>
  </g>
  <line x1="695" y1="202" x2="695" y2="222" stroke="#888" marker-end="url(#arr)"/>
  <g>
    <rect x="490" y="222" width="410" height="84" rx="6" fill="none" stroke="#60a5fa"/>
    <text x="502" y="242" fill="#60a5fa" font-weight="bold">WIRE 2 — same-repo PRs run on the LIVE runner pool</text>
    <text x="502" y="260" fill="#888">ci-runner-fsn1: 16 cores, 6 active runner units, load 0.00</text>
    <text x="502" y="276" fill="#888">(probed today) — fork PRs stay on ubuntu-latest</text>
    <text x="502" y="292" fill="#60a5fa">2030 CPU-s suite: 855s at 2.4x → ~150s at 16 cores</text>
  </g>

  <!-- bottom strip: release chain -->
  <g>
    <rect x="20" y="330" width="880" height="120" rx="6" fill="none" stroke="#8886"/>
    <text x="32" y="352" font-size="13" font-weight="bold" fill="#888">WIRE 3 — the release chain stops re-deriving what is already proven</text>
    <text x="32" y="376" fill="#888">release.sh: open PR → proof reuse clears the required check in ~30s → </text>
    <tspan/>
    <text x="32" y="394" fill="#888">gh pr merge --auto fires the instant checks settle (no mid-CI refusal, no retry cycle) → tag →</text>
    <text x="32" y="412" fill="#888">promote the attested tarball (helper digests RELATIVE-path hashed, RUSH-2766) → npm publish</text>
    <text x="32" y="436" fill="#a3e635" font-weight="bold">projected ordinary release: 60–120s wall — vs 18m24s today</text>
  </g>

  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#888"/>
    </marker>
  </defs>
</svg>
<figcaption><strong>Fig 4 — Current anatomy vs the target wiring.</strong> Nothing new is invented: the impact planner and proof cache are merged, the self-hosted runner pool is registered, active, and idle (probed 2026-08-17), and the tarball-promote path shipped v1.22.40. The three wires connect what already exists; the Firecracker microVM lane is the later hardening step for fork PRs, not the near-term speedup.</figcaption>
</figure>

## The fix plan — phased, evidence-grounded

Everything below was re-verified against live infrastructure and source on
2026-08-17, not assumed. Three findings reshape the naive plan:

1. **The self-hosted runner pool already exists and is idle.** `ci-runner-fsn1`
   (Hetzner fsn1, 16 cores, 465G free, load 0.00) answers to
   `ssh -i ~/.ssh/ci-runner-ops root@$CI_BOX_IP` (the documented ops path in
   `agents/infra/ci-runner/RUNBOOK.md:28`) and runs **six active runner units**:
   `runner@1..4` (the agents monorepo's whole CI runs on them at $0) and
   `runner-phnx@1..2` (the phnx-labs org pool, labels
   `[self-hosted, linux, x64, crabbox-ci, tailnet]`, group `crabbox-ci`).
   The earlier "locked out" finding was a false blocker — wrong host path and
   key. Nothing needs provisioning to start using this pool.
2. **The Firecracker executor is a contract, not deployable infra.** The merged
   `scripts/ci-runner` (#2745) has well-tested admission, fairness,
   fork-rejection, and attestation logic (24/24 tests) — but every "Firecracker"
   test runs against a Python stand-in (`testdata/firecracker:1-6`); there is no
   kernel image, no snapshot bake, no `/srv/ci` provisioning, no GitHub
   check-run reporting, and no caller anywhere in `.github/workflows/`. It is
   the *long-term* fork-isolation lane, not the near-term speedup.
3. **The org already learned not to build CI on crabbox leases.**
   `agents/infra/ci-runner/RUNBOOK.md:48-54`: the previous crabbox-managed
   runner box (`swift-krill`) died 2026-07-13 when the broker lost the lease —
   "A CI runner must not live on an ephemeral test-box lease." CI compute goes
   on the owned box; crabboxes stay dev/test sandboxes.

### Phase 0 — hygiene (agent-executable now, no approval gates)

| Step | Action | Evidence |
| --- | --- | --- |
| 0.1 | ~~Restore ci-runner-fsn1 access~~ **done during planning** — reachable via the ops key; correct RUSH-2773/2768 | probe quoted above |
| 0.2 | **Crabbox cleanup**: release the stale `release-v1.22.40-22960` lease on brisk-barnacle; destroy pearl-shrimp + tidal-hermit (both `keep=true`, both ssh-dead, both billing); re-warm one box for `test:remote` | `crabbox list` + ssh probes 2026-08-17 |
| 0.3 | **Adopt the agents-repo sharing pattern** in `apps/cli/scripts/sandbox.sh`: one profile-labeled warm box reused by many callers, each isolated in its own `~/workspaces/<name>` subdir (the pattern in `agents/scripts/lib/crabbox-sandbox.sh:63-67` + `agents/rush/cli/scripts/sandbox.sh:108-109`) — so the repo and its worktrees share one warm box in parallel instead of leasing per repo path. Note: `--reclaim` is ownership metadata, not a mutex; isolation is the disjoint subdirs | agents monorepo, five production callers of this pattern |

### Phase 1 — required PR check ≤60s for same-repo PRs

The measured cost is 855s of vitest on a cold 2-core GitHub VM (2030 CPU-s at
2.4× parallelism). The same suite at ci-runner-fsn1's 16 idle cores lands
~130–170s for a full-suite run — and full-suite is the *worst case*, only
triggered by `toolchain`-class diffs.

| Step | Change | File(s) |
| --- | --- | --- |
| 1.1 | **Two-lane required check**: same-repo PRs run the selected suite on `[self-hosted, linux, x64, crabbox-ci]`; fork PRs keep `ubuntu-latest`. One thin aggregator job keeps the single required context `test` (branch protection requires `test` + `gitleaks` only — probed). Gate the self-hosted lane on `github.event.pull_request.head.repo.full_name == github.repository` so fork code never touches the box — the standing rule in `tests-windows-host-e2e.yml:18-20` | `.github/workflows/tests.yml` |
| 1.2 | **Pin the bun cache per runner instance** (`BUN_INSTALL_CACHE_DIR: ${{ github.workspace }}/../.bun-cache`) — the documented corruption pitfall when instances share one `runner` user | `tests.yml`; lesson at `agents/infra/ci-runner/RUNBOOK.md:153` |
| 1.3 | **Release-shaped selection**: today `apps/cli/package.json` matches the `toolchain` group (`apps/cli/ci/test-ownership.yaml:85-94`) → `suite: cli-full` → the whole suite, even for a version-only bump. Add a version-bump-only classification (diff of `package.json` limited to the `version` field + `CHANGELOG` + `.changelog/**` + regenerated docs) that selects packaging validation (typecheck, pack/prepack smoke, docs check) instead of `cli-full` — exactly what the design doc prescribes (`plan-ci-release-near-instant.md:357`) | `scripts/ci-scope.ts` (`classifyPath`/`selectImpact`), `apps/cli/ci/test-ownership.yaml` |
| 1.4 | **Measure**: `scripts/ci-bench` (merged, #2750) gates the claim — P99 across ≥20 real same-repo PRs, plus zero-missed-failure recall vs the post-merge full sweep | `scripts/ci-bench/` |
| 1.5 | **Kill the long poles at the source — switch the CLI-spawn helper to bun** (revised by the swarm's suite track, which measured the real cause: not slow tests but ~2.5s of `node --import tsx` boot per spawn — `routines.test.ts:86` does it 84×). One shared `tests/spawn-cli.ts` using `bun src/index.ts` (10× faster boot, pattern already proven in CI by `ssh.device-config.test.ts:36`), converted file-by-file with the post-merge sweep kept on node for one cycle. Then `isolate:false` for subprocess-only test files (kills most of the 354 CPU-s import tax; env-mutators stay isolated). Demote the 70.9s deliberate soak to post-merge. Acceptance: **no single test file &gt;45s** — reached without splitting any file | `apps/cli/tests/spawn-cli.ts` (new), `routines.test.ts:86`, `daemon.test.ts:35`, `sessions.test.ts:833`, `versions.test.ts:46`, `vault.test.ts:245`, `vitest.config.ts` |

Projected: mapped small diffs ~20–40s (plan+checkout+selected subset on warm
box); toolchain/full-suite diffs bounded by the longest file — ~3.5 min until
1.5 lands, then ~2 min at `total÷16`, under 60s once the monsters are split and
import overhead drops; release diffs seconds. The 28s dependabot run already
proves the floor.

### Phase 2 — ordinary release ≤2 min, then toward 60s

| Step | Change | File(s) / ticket |
| --- | --- | --- |
| 2.1 | **Producer lane post-merge — attest only, coalesced, package at release**: a `push`-to-main job on the self-hosted pool runs the suite and uploads the signed exact-tree **proof + manifest only** (~1KB) — no tarball. `npm pack` (~15s) moves to release time, so nothing is packaged for merges that never ship. The concurrency group's `cancel-in-progress` coalesces burst-merges to one run for the latest tree (~6–10 runs/day at ~2 min each after phase 1.5, on owned hardware — $0 marginal). Attesting ≠ releasing: releases stay deliberate via `release.sh`; the same proof double-serves as the PR proof bridge (rank-3 swarm idea), so this run is *shared* cost, not release overhead | new job in `tests.yml`; RUSH-2766 defect 2 |
| 2.2 | **Relative-path helper digests**: `hash_tree` (`apps/cli/scripts/release-manifest.sh:128-139`) embeds absolute paths while release worktrees embed a PID (`release-worktree.sh:21`) — digests can never match across machines/runs. Hash paths relative to `--repo-root`. **Must land before the v1.22.41 tag** — the tagged script runs at publish time | RUSH-2766 defect 1 |
| 2.3 | **`gh pr merge --auto` in release.sh** — today it attempts a squash-merge mid-CI, gets refused by branch policy, drops the lease, and burns a retry cycle (measured: refusal at 09:19, merge at 09:27:57). Arm auto-merge and let GitHub fire it the instant checks settle | `apps/cli/scripts/release.sh` |
| 2.4 | With 1.3 + 2.1: the release PR's required check settles in seconds (release-shaped selection; tree evidence already produced), auto-merge fires, tag + promote-attested-tarball on mac-mini ≈60–90s including npm's ~10–20s registry round-trip | — |

### Phase 3 — Firecracker lane (long-term; off the 60s critical path)

Deploy `scripts/ci-runner` for real on a **separate** untrusted-executor box
(the README's own separation: trusted runners vs "a separate standing Crabbox:
no tailnet, no durable credentials" — `scripts/ci-runner/README.md:68-71`):
kernel/rootfs + snapshot bake, `/srv/ci` provisioning, a GitHub check-run
reporter, then fork PRs can leave `ubuntu-latest` too. Follow the design doc's
shadow-mode gate (200 PRs / 14 days, zero missed failures —
`plan-ci-release-near-instant.md:244`) before any required check depends on it.

### Who does what

- **Agent-executable now**: 0.2, 0.3, 1.1–1.4, 2.1–2.3 (worktree + PR each,
  normal review flow). Nothing in phases 0–2 needs new credentials — the
  runner pool is registered and active, and the ops key works from zion.
- **You (only if it arises)**: org runner-group visibility if the `crabbox-ci`
  group turns out not to include `agi-cli` (checkable only with `admin:org`);
  and any new runner registrations (REG_TOKEN) if we add a second box for
  capacity.

### Verification (acceptance, not vibes)

1. `scripts/ci-bench` report over ≥20 consecutive same-repo PRs after 1.1–1.3:
   required-check P99 ≤60s, zero missed failures vs the post-merge sweep.
2. One real release (v1.22.41, which must carry 2.2) measured end-to-end:
   `release.sh --apply` start → npm `dist-tags.latest` flip ≤180s, with the
   producer lane (2.1) having pre-written the attestation.
3. The post-merge full sweep stays green — selection changes never merge on
   selection's own evidence alone.

## Swarm-sourced ideas — five independent tracks, ranked

Five read-only agents (codex, grok, claude ×2, antigravity — kimi and opencode
failed auth and were replaced) each mined one layer, blind to each other. Where
they converged independently, confidence is high. Full reports: the selection
and release tables in this section, grok's report at
`.agents/scratch/infra-ci-runner-ideas.md`.

### The one finding that changes everything (suite track — measured, not guessed)

**The long-pole files are not slow tests — they are process-boot tax.** Every
test in the monster files spawns the full CLI via `node --import tsx` at
~1.55s/boot warm, ~2.5s on the cold CI VM (`routines.test.ts:86`,
`daemon.test.ts:35`, `sessions.test.ts:833`). `routines.test.ts` = 84 spawns ×
~2.5s = its entire 213.6s. Measured on zion: `bun src/index.ts --version` =
**0.15s vs 1.55s — 10×**. And `ssh.device-config.test.ts:36` already spawns
via bun, in CI, today — the pattern is proven in-repo. Wall-clock sleeps are
~3s of a 108s file; fake timers would buy nothing. This **replaces** plan step
1.5's "split the monster files": switching the spawn helper drops the long
pole to ~35s without splitting anything.

### Converged (multiple tracks, independently)

| Rank | Idea | Tracks | Saves | Effort/Risk |
| --- | --- | --- | --- | --- |
| 1 | **Bun spawn helper** — one shared `tests/spawn-cli.ts`, replace `node --import tsx` at every CLI-spawn site | suite | **~280–340s wall**; long pole 213.6s → ~35s | M / runtime-semantics flake; convert file-by-file, keep node on the post-merge sweep one cycle |
| 2 | **Two-lane required check on the live pool** — same-repo → `[self-hosted,linux,x64,crabbox-ci]` via expression `runs-on` (keeps ONE `test` context); forks → ubuntu-latest | infra, release | **~640s** on full-suite; checkout 11s→3s | S / needs the `crabbox-ci`-never-on-`pull_request` rule amended to same-repo-only + `tests-gate.test.ts` re-pinned; never `pull_request_target` |
| 3 | **Signed multi-writer attestation bridge** — producer lane, fleet boxes, release producer, and merge-queue runs all upload signed exact-tree proofs; the check verifies signature + the existing 5-way digest bind before honoring | selection, release, wildcard | 15m → ~28s for any pre-proven tree | M / poisoning is the risk: signature + no fork-reachable write credential + post-merge sweep |
| 4 | **Release-shaped handling of version-bump diffs** — two composable variants: (a) selection: JSON-diff `package.json`, require only `/version` changed → packaging checks; (b) wildcard's **normalized tree digest**: hash the tree minus {version field, CHANGELOG, .changelog/**} → the release PR's normalized digest equals main's attested one → proof reuse fires with zero new selection logic | selection, release, wildcard | **~820–855s** on every release PR | S / exemption-hole risk: keep the exempt set tiny, field-level, and pinned by `policy_digest` |
| 5 | **Producer lane + `hash_tree` relative paths + `gh pr merge --auto`** (the release chain; antigravity independently re-derived plan 2.1–2.3 and measured the floor: ssh hop + npm publish + verify ≈ 30–40s irreducible) | release, selection | ~5m + 1–2m + 3m off the release | S–M / low |

### Novel (single track, worth adopting)

- **`isolate: false` / warm-worker vitest pool** for the majority of files that
  only spawn subprocesses (suite): kills most of the 354 CPU-s import tax,
  ~120–150s wall on 2 cores, ~20s at 16. Risk: cross-file state leaks
  (`vault.test.ts:160` mutates `process.execPath`) — run env-mutators in an
  isolated shard.
- **GitHub merge queue (`merge_group`)** (wildcard): batches same-repo PRs into
  one attestation run (cost ÷ batch), structurally eliminates the
  merge-refused-mid-CI cycle release.sh hit, and the queue run doubles as the
  producer. `tests.yml` has no `merge_group` trigger today.
- **Speculative attestation at authoring time** (wildcard): the agent's own
  fleet box runs the 169s suite while the PR opens, uploads the signed proof;
  the required check finds it already proven. Runs on idle yosemite boxes
  instead of GH VMs. Needs the bridge (rank 3) first; proofs self-invalidate
  cross-platform via the existing `platform`/`bun` binds.
- **Closure-keyed proof reuse** (wildcard): second-tier key =
  digest(selected tests + transitive import closure + lockfile + policy) so
  reuse survives rebases that don't touch the closure. The import graph
  already exists (`ci-scope.ts:318-336`).
- **Demote `isolated-soak.integration.test.ts`** (70.9s deliberate soak) to
  the post-merge sweep (suite) — the exact class the latency policy already
  exempts from the PR gate.
- **Don't add `actions/cache` on the self-hosted pool** (grok, measured): the
  cache download step cost 60s on phnx-2 — disk-local caches only.
- **Baseline verdict on "test only what changed since the last release"**
  (codex): the correct PR baseline is the **merge-base against the candidate
  merge tree** — a last-release baseline under-tests PRs landing after other
  merges. "Since last release" is right for the *producer's* accumulation
  window. Codex also found the proof currently binds the **head** tree, not
  GitHub's prospective **merge** tree (`ci-scope.ts:778`) — a correctness gap
  worth closing while touching the keying.

### Decision points (tracks diverged — owner input useful, defaults chosen)

- **Shared 16 cores**: the agents monorepo's 4 ephemeral runners share
  ci-runner-fsn1 with the 2 phnx runners. Grok: under contention the 214s
  floor isn't real; a second dedicated box (cpx62, ~€130/mo) fixes it.
  **Default: wire the lane now, measure contention with ci-bench, buy the box
  only if P99 breaches.**
- **The `crabbox-ci` label rule**: moving `pull_request` (same-repo only) onto
  the pool amends a standing security rule. The fork lane never moves. The
  gate test gets re-pinned to enforce *same-repo-only* instead of *never*.

### The composed 60-second path

CI (worst case, full suite): bun spawns (~1250 CPU-s remaining) + warm pool
(16 cores) + isolate:false → `max(~35s pole, ~1250/16=78s)` + ~25s overhead ≈
**~100s → ~60s** once the import tax falls; typical mapped diffs **20–40s**;
any pre-proven tree **~28s**. Release: producer lane + normalized digest +
auto-merge + fixed helper gate → check ~28s, merge instant, promote ~40–60s ≈
**~90–120s**, approaching 60s with the merge queue batching the check away.

## Tracking

- **RUSH-2666** — umbrella; owner directive (≤60s CI and release) + today's measured breakdown recorded. Delegate: Codex, due 2026-08-18. Phases 1–2 are its concrete execution.
- **RUSH-2766** — helper digest fix + producer lane (2.1, 2.2); precedes the v1.22.41 tag.
- **RUSH-2773** — crabbox fleet health; correct with today's probe (ci-runner-fsn1 reachable via ops key; the dead boxes + stale lease remain, step 0.2).
- **RUSH-2768** — fleet-rollout stranding; the ci-runner "unreachable" entry is superseded by the ops-key path.
- Design baseline: `.agents/artifacts/2026-08-15/plan-ci-release-near-instant.md` (targets, shadow-mode gate, release-PR validation row at line 357).
