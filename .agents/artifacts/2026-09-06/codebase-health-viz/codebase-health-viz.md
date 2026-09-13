---
kind: visual
template: visual.v1
title: Sixteen views of codebase health — scenes, not scores
summary: code:refactor already measures this tree. Humans judge nine scenes, not comment ratios. Ship eight one-question views plus a query twin for every picture.
header: Phoenix Labs / Engineering
footer: Design exploration · not a product spec
project: agi-cli
context: How to visualize codebase quality and health for humans and agents
repository: phnx-labs/agi-cli
branch: cursor/codebase-health-viz-248c
status: draft
harness: cursor
agent: grok-4.6
human: author
host: fleet-worker
date: "2026-09-06"
facts:
  - "873 source files · 322,363 LOC in cli/src excluding tests, counted 2026-09-06"
  - "16 views across 6 genres · 8 in the v1 kit"
  - "code:refactor measures; this page is the missing vis layer"
links:
  - url: https://github.com/Nxtsoft/CGraph
    label: Nxtsoft/CGraph
  - url: https://github.com/sourcegraph/scip
    label: SCIP
---

## Story

`code:refactor` in `phnx-labs/.agents` is already architecture-first. It walks the import graph, ranks `harm × exposure`, and draws a before/after figure whose every box and arrow is sourced from `modules.json`. `code:review` Mode C then dumps a findings list. Neither surface shows the *scene* a human actually pattern-matches: the god file, the cycle you can tear, the clone family that must land N times, the type nobody calls, the two agents about to collide.

A comment percentage is a map of where design essays are mislocated (`comments.ts` says so explicitly). Averaging cyclomatic complexity into a repo score is trivia. A force-directed import graph of this CLI is a hairball. The right instrument is **one question per view**, overview then zoom then file:line, with a query twin so an agent asks the same question without eating a PNG.

This page is that instrument, drawn against this checkout. Numbers in the mockups that look like file sizes are real 2026-09-06 `git ls-files` + `wc -l` on `cli/src`. Cycle and family counts from the 2026-08-12 / 2026-08-17 refactor runs are labeled as of those dates and are not re-measured here (`bun` is not on this box).

<div class="artifact-callout">
<strong>Humans judge scenes. Agents get the same scene as a query.</strong> If a view cannot make a god module, a tearable cycle, a coupled clone, a dead export, or an agent collision pop in under five seconds, do not ship it. Do not ship a health pie, a 3D city, or repo-wide UML.
</div>

## Data

| Grain | Count | As of | Source |
| --- | ---: | --- | --- |
| Source `.ts` files under `cli/src` (no tests) | 873 | 2026-09-06 | `git ls-files 'cli/src/**/*.ts'` excluding `*.test.ts` |
| Source LOC | 322,363 | 2026-09-06 | `wc -l` on that list |
| Test files / test LOC | 1,003 / 230,179 | 2026-09-06 | `cli/src/**/*.test.ts` |
| Largest file | `cli/src/commands/sessions.ts` 6,392 | 2026-09-06 | same `wc -l` |
| Next three | `lib/session/discover.ts` 5,885 · `lib/session/db.ts` 5,188 · `lib/accounting/usage.ts` 4,142 | 2026-09-06 | same |
| Diriest directory by file count | `cli/src/lib/session` 79 files | 2026-09-06 | path prefix of that list |
| Refactor run, agents-cli | 2,214 source files · 586,097 LOC · 47 files &gt; 1,500 · 125 families · 2,347 collapsible arms | 2026-08-17 | `.agents/artifacts/2026-08-17/refactor-100723/metrics-summary.json` |
| Reference figure | 44 modules · 196 edges · 1 cycle of 38 · `lib` 193 files / 88,644 LOC / fan-in 1,095 | 2026-08-12 | `plugins/code/skills/refactor/reference-figure.md` |

The 2026-08-12 graph is **not** today's graph. Re-run `modules.ts` before any figure claims a cycle count. CGraph (Nxtsoft, tree-sitter `graph.json`) was not installed on this worker; the pipeline section names the MCP queries the views consume, not a live extract.

## Figure

The spine. Six genres are six questions. Lime stroke is the v1 kit. Grey cards ship later. Click-through in a real build is file:line; this page is the map of maps.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg viewBox="0 0 960 580" role="img" aria-label="Six-genre wall of sixteen codebase-health views. Eight v1-kit cards have a lime stroke.">
    <text x="16" y="22" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="14" font-weight="600">Six questions. Sixteen views. Eight to ship first.</text>
    <text x="16" y="40" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="11">Lime stroke = v1 kit. Grey = later. Each card is one question. The healthy 90% stays quiet.</text>
    <rect x="790" y="10" width="14" height="14" rx="2" fill="none" stroke="#a3e635" stroke-width="2"/>
    <text x="810" y="21" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">v1</text>
    <rect x="848" y="10" width="14" height="14" rx="2" fill="none" stroke="#555555" stroke-width="1.5"/>
    <text x="868" y="21" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">later</text>

    <rect x="12" y="56" width="150" height="22" rx="4" fill="#0e1418" stroke="#56B4E9" stroke-width="1.5"/>
    <text x="87" y="71" text-anchor="middle" fill="#56B4E9" font-family="JetBrains Mono, monospace" font-size="10">STRUCTURE</text>
    <rect x="170" y="56" width="150" height="22" rx="4" fill="#16120a" stroke="#E69F00" stroke-width="1.5"/>
    <text x="245" y="71" text-anchor="middle" fill="#E69F00" font-family="JetBrains Mono, monospace" font-size="10">SIMILARITY</text>
    <rect x="328" y="56" width="150" height="22" rx="4" fill="#0f160a" stroke="#009E73" stroke-width="1.5"/>
    <text x="403" y="71" text-anchor="middle" fill="#009E73" font-family="JetBrains Mono, monospace" font-size="10">USAGE</text>
    <rect x="486" y="56" width="150" height="22" rx="4" fill="#0e1418" stroke="#0072B2" stroke-width="1.5"/>
    <text x="561" y="71" text-anchor="middle" fill="#56B4E9" font-family="JetBrains Mono, monospace" font-size="10">EVOLUTION</text>
    <rect x="644" y="56" width="150" height="22" rx="4" fill="#1a0e0a" stroke="#D55E00" stroke-width="1.5"/>
    <text x="719" y="71" text-anchor="middle" fill="#D55E00" font-family="JetBrains Mono, monospace" font-size="10">RISK</text>
    <rect x="802" y="56" width="146" height="22" rx="4" fill="#160a14" stroke="#CC79A7" stroke-width="1.5"/>
    <text x="875" y="71" text-anchor="middle" fill="#CC79A7" font-family="JetBrains Mono, monospace" font-size="10">CONTRACTS</text>

    <rect x="12" y="88" width="150" height="52" rx="6" fill="#111312" stroke="#555555" stroke-width="1.5"/>
    <text x="20" y="108" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">V01</text>
    <text x="20" y="126" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">Mass treemap</text>
    <rect x="12" y="148" width="150" height="52" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
    <text x="20" y="168" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">V02 v1</text>
    <text x="20" y="186" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">Layered DSM</text>
    <rect x="12" y="208" width="150" height="52" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
    <text x="20" y="228" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">V03 v1</text>
    <text x="20" y="246" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">Cycle extractor</text>
    <rect x="12" y="268" width="150" height="52" rx="6" fill="#111312" stroke="#555555" stroke-width="1.5"/>
    <text x="20" y="288" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">V05</text>
    <text x="20" y="306" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">Type blueprint</text>

    <rect x="170" y="88" width="150" height="88" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
    <text x="178" y="108" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">V04 v1</text>
    <text x="178" y="126" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">Dual trees</text>
    <text x="178" y="144" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="11">+ clone scatter</text>
    <text x="178" y="162" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">TreeJuxtaposer</text>
    <rect x="170" y="184" width="150" height="64" rx="6" fill="#111312" stroke="#555555" stroke-width="1.5"/>
    <text x="178" y="204" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">V16</text>
    <text x="178" y="222" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">Forked families</text>
    <text x="178" y="238" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">patterns.ts</text>

    <rect x="328" y="88" width="150" height="52" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
    <text x="336" y="108" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">V06 v1</text>
    <text x="336" y="126" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">Type-usage matrix</text>
    <rect x="328" y="148" width="150" height="52" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
    <text x="336" y="168" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">V07 v1</text>
    <text x="336" y="186" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">Butterfly / cgraph</text>
    <rect x="328" y="208" width="150" height="52" rx="6" fill="#111312" stroke="#555555" stroke-width="1.5"/>
    <text x="336" y="228" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">V08</text>
    <text x="336" y="246" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">Coverage icicle</text>
    <rect x="328" y="268" width="150" height="52" rx="6" fill="#111312" stroke="#555555" stroke-width="1.5"/>
    <text x="336" y="288" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">V14</text>
    <text x="336" y="306" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">Public surface</text>

    <rect x="486" y="88" width="150" height="64" rx="6" fill="#111312" stroke="#555555" stroke-width="1.5"/>
    <text x="494" y="108" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">V09</text>
    <text x="494" y="126" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">SeeSoft strip</text>
    <text x="494" y="144" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">Eick 1992</text>
    <rect x="486" y="160" width="150" height="52" rx="6" fill="#111312" stroke="#555555" stroke-width="1.5"/>
    <text x="494" y="180" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">V12</text>
    <text x="494" y="198" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">Change coupling</text>
    <rect x="486" y="220" width="150" height="52" rx="6" fill="#111312" stroke="#555555" stroke-width="1.5"/>
    <text x="494" y="240" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">V11</text>
    <text x="494" y="258" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">Knowledge map</text>

    <rect x="644" y="88" width="150" height="64" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
    <text x="652" y="108" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">V10 v1</text>
    <text x="652" y="126" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">Hotspot map</text>
    <text x="652" y="144" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">churn × size</text>
    <rect x="644" y="160" width="150" height="52" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
    <text x="652" y="180" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">V13 v1</text>
    <text x="652" y="198" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">Contract overlay</text>
    <rect x="644" y="220" width="150" height="52" rx="6" fill="#111312" stroke="#555555" stroke-width="1.5"/>
    <text x="652" y="240" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">V05b</text>
    <text x="652" y="258" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">Main sequence</text>

    <rect x="802" y="88" width="146" height="88" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
    <text x="810" y="108" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">V15 v1</text>
    <text x="810" y="126" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">Agent traffic</text>
    <text x="810" y="144" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="11">collision board</text>
    <text x="810" y="162" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">sessions.db</text>
    <rect x="802" y="184" width="146" height="64" rx="6" fill="#111312" stroke="#555555" stroke-width="1.5"/>
    <text x="810" y="204" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">keep</text>
    <text x="810" y="222" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">refactor figure</text>
    <text x="810" y="240" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">modules.json</text>

    <text x="16" y="350" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="12">The nine scenes these views must pop</text>
    <rect x="12" y="362" width="936" height="200" rx="8" fill="#111312" stroke="#26302a"/>
    <text x="28" y="386" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="11">1  god module        sessions.ts 6392 LOC sits in the mass treemap and the hotspot</text>
    <text x="28" y="406" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="11">2  tearable cycle     DSM black cell + SCC small-multiple, not a 38-node hairball</text>
    <text x="28" y="426" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="11">3  coupled clone      dual trees with a % and a canonical diff, not a CSV of pairs</text>
    <text x="28" y="446" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="11">4  dead type          empty row on the usage matrix · 0 prod refs, hatch, not a knip dump</text>
    <text x="28" y="466" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="11">5  illegal import     contract overlay paints the one cell; CI already owns the fail</text>
    <text x="28" y="486" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="11">6  agent collision    two sessions hold neighbors on the butterfly — fleet-specific</text>
    <text x="28" y="506" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="11">7  theatrical tests   coverage icicle colors hit-count, not 95% of a generated serializer</text>
    <text x="28" y="526" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="11">8  zone of pain       stable and concrete package everyone imports (Martin main sequence)</text>
    <text x="28" y="546" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="11">9  bus factor         hotspot intersect single-owner on the knowledge map</text>
  </svg>
  <figcaption><b>Figure 1.</b> Genre wall. v1 is DSM, cycles, dual trees, type-usage, butterfly, hotspot, contract overlay, and agent traffic, plus the existing sourced <code>code:refactor</code> before/after. Later views reuse the same layouts so spatial memory transfers.</figcaption>
</figure>

## Today versus the wall

Left is what an operator gets now: a scorecard, a comment map, a findings queue, one honest architecture figure. Right is the same measurement feeding scenes. The refactor figure stays; it is the only view whose every number is already pinned to JSON.

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="mockup">
    <figure class="artifact-figure artifact-figure-diagram">
      <svg viewBox="0 0 440 340" role="img" aria-label="Current code:refactor and code:review output: scorecards, comment percent, one box diagram, a findings list">
        <rect x="8" y="8" width="424" height="324" rx="8" fill="#0a0a0a" stroke="#333333"/>
        <text x="20" y="28" fill="#888888" font-family="JetBrains Mono, monospace" font-size="10">code:review · Mode C</text>
        <rect x="20" y="40" width="92" height="44" rx="4" fill="#141414" stroke="#333333"/>
        <text x="28" y="58" fill="#f87171" font-family="JetBrains Mono, monospace" font-size="14">12</text>
        <text x="28" y="74" fill="#888888" font-family="Inter, system-ui, sans-serif" font-size="10">blocker</text>
        <rect x="120" y="40" width="92" height="44" rx="4" fill="#141414" stroke="#333333"/>
        <text x="128" y="58" fill="#facc15" font-family="JetBrains Mono, monospace" font-size="14">47</text>
        <text x="128" y="74" fill="#888888" font-family="Inter, system-ui, sans-serif" font-size="10">should</text>
        <rect x="220" y="40" width="92" height="44" rx="4" fill="#141414" stroke="#333333"/>
        <text x="228" y="58" fill="#888888" font-family="JetBrains Mono, monospace" font-size="14">33</text>
        <text x="228" y="74" fill="#888888" font-family="Inter, system-ui, sans-serif" font-size="10">nice</text>
        <rect x="320" y="40" width="96" height="44" rx="4" fill="#141414" stroke="#333333"/>
        <text x="328" y="58" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="14">18%</text>
        <text x="328" y="74" fill="#888888" font-family="Inter, system-ui, sans-serif" font-size="10">comment_pct</text>
        <rect x="20" y="96" width="400" height="70" rx="4" fill="#0f0f0f" stroke="#333333"/>
        <text x="28" y="114" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="11">lib/terminal — 17 files · 1,636 LOC</text>
        <text x="28" y="132" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">commands → x10    lib ← x4 dashed</text>
        <text x="28" y="150" fill="#f59e0b" font-family="Inter, system-ui, sans-serif" font-size="10">inside the 38-module cycle (2026-08-12)</text>
        <text x="28" y="186" fill="#888888" font-family="JetBrains Mono, monospace" font-size="10">FINDINGS</text>
        <text x="28" y="206" fill="#f87171" font-family="JetBrains Mono, monospace" font-size="10">BLOCKER  sessions.ts: god file 6392 LOC</text>
        <text x="28" y="224" fill="#facc15" font-family="JetBrains Mono, monospace" font-size="10">SHOULD   essay_block hooks/install.ts:12</text>
        <text x="28" y="242" fill="#888888" font-family="JetBrains Mono, monospace" font-size="10">NICE     identifier cluster runWithFallback</text>
        <text x="28" y="268" fill="#666666" font-family="Inter, system-ui, sans-serif" font-size="11">The list is true and un-navigable. The figure is true</text>
        <text x="28" y="286" fill="#666666" font-family="Inter, system-ui, sans-serif" font-size="11">and covers one move. Comment % is not quality.</text>
        <text x="28" y="312" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="10">gap: no clone scene · no type-use · no collision</text>
      </svg>
      <figcaption>Today. Findings HTML plus one sourced architecture figure. Hygiene is the byproduct tier in the skill itself.</figcaption>
    </figure>
  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">
    <figure class="artifact-figure artifact-figure-diagram">
      <svg viewBox="0 0 440 340" role="img" aria-label="Proposed health wall: DSM, dual trees, type matrix, hotspot, agent collision chips">
        <rect x="8" y="8" width="424" height="324" rx="8" fill="#0a0a0a" stroke="#333333"/>
        <text x="20" y="28" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">health wall · v1 kit</text>
        <rect x="20" y="40" width="130" height="110" rx="4" fill="#0f0f0f" stroke="#a3e635" stroke-width="1.5"/>
        <text x="28" y="56" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="9">DSM</text>
        <rect x="36" y="66" width="10" height="10" fill="#1a1a1a" stroke="#333"/>
        <rect x="48" y="66" width="10" height="10" fill="#56B4E9"/>
        <rect x="60" y="66" width="10" height="10" fill="#1a1a1a" stroke="#333"/>
        <rect x="72" y="66" width="10" height="10" fill="#1a1a1a" stroke="#333"/>
        <rect x="36" y="78" width="10" height="10" fill="#1a1a1a" stroke="#333"/>
        <rect x="48" y="78" width="10" height="10" fill="#1a1a1a" stroke="#333"/>
        <rect x="60" y="78" width="10" height="10" fill="#111"/>
        <rect x="72" y="78" width="10" height="10" fill="#56B4E9"/>
        <rect x="36" y="90" width="10" height="10" fill="#1a1a1a" stroke="#333"/>
        <rect x="48" y="90" width="10" height="10" fill="#111"/>
        <rect x="60" y="90" width="10" height="10" fill="#1a1a1a" stroke="#333"/>
        <rect x="72" y="90" width="10" height="10" fill="#1a1a1a" stroke="#333"/>
        <rect x="36" y="102" width="10" height="10" fill="#D55E00"/>
        <rect x="48" y="102" width="10" height="10" fill="#1a1a1a" stroke="#333"/>
        <rect x="60" y="102" width="10" height="10" fill="#56B4E9"/>
        <rect x="72" y="102" width="10" height="10" fill="#111"/>
        <text x="90" y="88" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">black=cycle</text>
        <text x="90" y="102" fill="#D55E00" font-family="JetBrains Mono, monospace" font-size="8">orange=illegal</text>
        <rect x="158" y="40" width="130" height="110" rx="4" fill="#0f0f0f" stroke="#a3e635" stroke-width="1.5"/>
        <text x="166" y="56" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="9">DUAL TREES</text>
        <text x="166" y="74" fill="#888888" font-family="JetBrains Mono, monospace" font-size="8">lib/hosts</text>
        <text x="166" y="88" fill="#888888" font-family="JetBrains Mono, monospace" font-size="8">  dispatch.ts</text>
        <text x="166" y="102" fill="#888888" font-family="JetBrains Mono, monospace" font-size="8">lib/devices</text>
        <text x="166" y="116" fill="#888888" font-family="JetBrains Mono, monospace" font-size="8">  remote-cmd.ts</text>
        <text x="248" y="94" fill="#E69F00" font-family="JetBrains Mono, monospace" font-size="9">87%</text>
        <rect x="296" y="40" width="124" height="110" rx="4" fill="#0f0f0f" stroke="#a3e635" stroke-width="1.5"/>
        <text x="304" y="56" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="9">TYPES</text>
        <rect x="304" y="66" width="108" height="8" fill="#009E73"/>
        <rect x="304" y="78" width="72" height="8" fill="#009E73" opacity="0.6"/>
        <rect x="304" y="90" width="108" height="8" fill="none" stroke="#D55E00" stroke-dasharray="2 2"/>
        <text x="304" y="114" fill="#D55E00" font-family="JetBrains Mono, monospace" font-size="8">empty = dead</text>
        <rect x="20" y="160" width="200" height="100" rx="4" fill="#0f0f0f" stroke="#a3e635" stroke-width="1.5"/>
        <text x="28" y="176" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="9">HOTSPOT  90d</text>
        <rect x="28" y="188" width="70" height="56" fill="#D55E00"/>
        <text x="32" y="218" fill="#0a0a0a" font-family="JetBrains Mono, monospace" font-size="8">sessions</text>
        <rect x="102" y="188" width="50" height="40" fill="#E69F00"/>
        <text x="106" y="210" fill="#0a0a0a" font-family="JetBrains Mono, monospace" font-size="8">discover</text>
        <rect x="156" y="188" width="52" height="28" fill="#F0E442"/>
        <text x="160" y="206" fill="#0a0a0a" font-family="JetBrains Mono, monospace" font-size="8">db.ts</text>
        <rect x="228" y="160" width="192" height="100" rx="4" fill="#0f0f0f" stroke="#a3e635" stroke-width="1.5"/>
        <text x="236" y="176" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="9">AGENTS</text>
        <circle cx="250" cy="210" r="6" fill="#a3e635"/>
        <circle cx="278" cy="210" r="6" fill="#56B4E9"/>
        <text x="294" y="206" fill="#f87171" font-family="JetBrains Mono, monospace" font-size="9">COLLIDE</text>
        <text x="294" y="220" fill="#f87171" font-family="JetBrains Mono, monospace" font-size="8">session/db.ts</text>
        <text x="236" y="244" fill="#888888" font-family="JetBrains Mono, monospace" font-size="8">2 sessions · 1 hop on butterfly</text>
        <text x="28" y="284" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="11">Same JSON. Different question per pane. Click lands</text>
        <text x="28" y="302" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="11">in the editor. Agent twin is a query, not a city.</text>
        <text x="28" y="322" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">payoff: a refactor you can point at</text>
      </svg>
      <figcaption>Proposed. One wall, eight v1 panes, ranked worklist beside each picture. Cost of not doing it: agents keep enlarging <code>sessions.ts</code> because the finding is a number, not a place.</figcaption>
    </figure>
  </div>
</div>

## The sixteen views

Each view is one question, the data it needs, the way it dies, and a mockup against this tree. Grain is a control: architecture = package, clone = function, hotspot = file, SeeSoft = line.

### Structure

<section class="artifact-grid artifact-grid-2">
  <article class="artifact-panel">
    <p><span class="artifact-tag">V01</span> Mass treemap</p>
    <p><strong>Where is the mass?</strong> Path-sorted slice-and-dice (Johnson/Shneiderman 1991), not squarified. Area = ncloc. Labels only where they fit. Color is unused here so size stays honest.</p>
    <p>Data: file tree + LOC. Failure: squarified layout jitters every run and kills spatial memory. Tiny files vanish on purpose.</p>
    <p>On this tree the scene is `cli/src/lib` eating the product while newcomers wander `packages/`.</p>
  </article>
  <figure class="artifact-figure artifact-figure-diagram">
    <svg viewBox="0 0 440 220" role="img" aria-label="Path-sorted treemap of cli/src. lib/session is the largest rectangle, then commands/sessions.ts as a tall cell.">
      <rect x="8" y="8" width="424" height="204" rx="6" fill="#0a0a0a" stroke="#333"/>
      <text x="16" y="24" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">cli/src · 873 files · 322,363 LOC · 2026-09-06</text>
      <rect x="16" y="36" width="250" height="160" fill="#141414" stroke="#56B4E9"/>
      <text x="24" y="54" fill="#56B4E9" font-family="JetBrains Mono, monospace" font-size="10">lib/</text>
      <rect x="24" y="62" width="150" height="120" fill="#1a2420" stroke="#333"/>
      <text x="32" y="80" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="10">session/ 79 files</text>
      <text x="32" y="96" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">discover 5885</text>
      <text x="32" y="110" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">db 5188</text>
      <rect x="180" y="62" width="78" height="70" fill="#1a2420" stroke="#333"/>
      <text x="186" y="80" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="9">browser</text>
      <rect x="180" y="136" width="78" height="46" fill="#1a2420" stroke="#333"/>
      <text x="186" y="154" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="9">hooks</text>
      <rect x="274" y="36" width="142" height="100" fill="#141414" stroke="#56B4E9"/>
      <text x="282" y="54" fill="#56B4E9" font-family="JetBrains Mono, monospace" font-size="10">commands/</text>
      <rect x="282" y="62" width="126" height="64" fill="#D55E00"/>
      <text x="290" y="88" fill="#0a0a0a" font-family="JetBrains Mono, monospace" font-size="10">sessions.ts</text>
      <text x="290" y="104" fill="#0a0a0a" font-family="JetBrains Mono, monospace" font-size="10">6392</text>
      <rect x="274" y="144" width="142" height="52" fill="#141414" stroke="#333"/>
      <text x="282" y="164" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">other commands</text>
      <text x="282" y="180" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">exec 3677 · browser 3516</text>
    </svg>
    <figcaption>V01. Stable path order. The orange cell is not a score; it is the file you will not add a 15th method to.</figcaption>
  </figure>
</section>

<section class="artifact-grid artifact-grid-2">
  <article class="artifact-panel">
    <p><span class="artifact-tag artifact-tag-accent">V02 v1</span> Layered DSM</p>
    <p><strong>What are the layers, where are the cycles, which cell is illegal?</strong> Square matrix, same order on both axes, intended layers as heavy grid lines. Sequential fill = import weight. Black = mutual. Orange = violates a declared rule.</p>
    <p>Data: `modules.ts` graph + optional `layers.yml`. Order by declared layer, then Tarjan SCC, then topo. Never let a force layout pick the order.</p>
    <p>Grain cap ~150. A 873-file DSM is unreadable; collapse to the 44-module grain the 2026-08-12 figure already used.</p>
  </article>
  <figure class="artifact-figure artifact-figure-diagram">
    <svg viewBox="0 0 440 260" role="img" aria-label="Eight-by-eight DSM of CLI modules. A black mutual cell between lib and session, an orange illegal cell from commands into native.">
      <text x="16" y="18" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">rows = from · cols = to · NDepend coloring</text>
      <text x="100" y="40" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">cmd</text>
      <text x="140" y="40" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">lib</text>
      <text x="176" y="40" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">sess</text>
      <text x="216" y="40" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">term</text>
      <text x="256" y="40" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">host</text>
      <text x="296" y="40" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">nat</text>
      <text x="336" y="40" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">pkg</text>
      <text x="376" y="40" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">tst</text>
      <text x="16" y="72" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">commands</text>
      <rect x="96" y="56" width="28" height="28" fill="#222" stroke="#333"/>
      <rect x="132" y="56" width="28" height="28" fill="#56B4E9"/>
      <rect x="168" y="56" width="28" height="28" fill="#0072B2"/>
      <rect x="204" y="56" width="28" height="28" fill="#56B4E9"/>
      <rect x="240" y="56" width="28" height="28" fill="#222" stroke="#333"/>
      <rect x="276" y="56" width="28" height="28" fill="#D55E00"/>
      <rect x="312" y="56" width="28" height="28" fill="#222" stroke="#333"/>
      <rect x="348" y="56" width="28" height="28" fill="#222" stroke="#333"/>
      <text x="16" y="108" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">lib</text>
      <rect x="96" y="92" width="28" height="28" fill="#222" stroke="#333"/>
      <rect x="132" y="92" width="28" height="28" fill="#111"/>
      <rect x="168" y="92" width="28" height="28" fill="#111"/>
      <rect x="204" y="92" width="28" height="28" fill="#56B4E9"/>
      <rect x="240" y="92" width="28" height="28" fill="#222" stroke="#333"/>
      <rect x="276" y="92" width="28" height="28" fill="#222" stroke="#333"/>
      <rect x="312" y="92" width="28" height="28" fill="#222" stroke="#333"/>
      <rect x="348" y="92" width="28" height="28" fill="#222" stroke="#333"/>
      <text x="16" y="144" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">session</text>
      <rect x="96" y="128" width="28" height="28" fill="#222" stroke="#333"/>
      <rect x="132" y="128" width="28" height="28" fill="#111"/>
      <rect x="168" y="128" width="28" height="28" fill="#222" stroke="#333"/>
      <rect x="204" y="128" width="28" height="28" fill="#222" stroke="#333"/>
      <rect x="240" y="128" width="28" height="28" fill="#222" stroke="#333"/>
      <rect x="276" y="128" width="28" height="28" fill="#222" stroke="#333"/>
      <rect x="312" y="128" width="28" height="28" fill="#222" stroke="#333"/>
      <rect x="348" y="128" width="28" height="28" fill="#222" stroke="#333"/>
      <text x="16" y="180" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">terminal</text>
      <rect x="96" y="164" width="28" height="28" fill="#222" stroke="#333"/>
      <rect x="132" y="164" width="28" height="28" fill="#56B4E9"/>
      <rect x="168" y="164" width="28" height="28" fill="#56B4E9"/>
      <rect x="204" y="164" width="28" height="28" fill="#222" stroke="#333"/>
      <rect x="240" y="164" width="28" height="28" fill="#222" stroke="#333"/>
      <rect x="276" y="164" width="28" height="28" fill="#222" stroke="#333"/>
      <rect x="312" y="164" width="28" height="28" fill="#222" stroke="#333"/>
      <rect x="348" y="164" width="28" height="28" fill="#222" stroke="#333"/>
      <rect x="16" y="208" width="12" height="12" fill="#56B4E9"/>
      <text x="32" y="218" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">uses</text>
      <rect x="80" y="208" width="12" height="12" fill="#111"/>
      <text x="96" y="218" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">mutual / cycle</text>
      <rect x="200" y="208" width="12" height="12" fill="#D55E00"/>
      <text x="216" y="218" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">illegal (commands → native)</text>
      <text x="16" y="246" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">Click a cell → concrete import lines. Agent: `illegal_edges()`.</text>
    </svg>
    <figcaption>V02. Steward 1981 via Lattix/NDepend. The 2026-08-12 cycle of 38 is the black block, not a Graphviz `fdp` drawing of 38 nodes.</figcaption>
  </figure>
</section>

<section class="artifact-grid artifact-grid-2">
  <article class="artifact-panel">
    <p><span class="artifact-tag artifact-tag-accent">V03 v1</span> Cycle extractor</p>
    <p><strong>Which cycles exist, ranked by cost to break?</strong> Do not draw the whole graph. Show SCCs of size ≥ 2 as small multiples (now N is 2–15, node-link is legal). Highlight the tear edge: lowest-weight removal that acyclicizes.</p>
    <p>Data: Tarjan on the module graph; optional co-change as a second weight. A giant 38-node SCC falls back to a DSM of *just that SCC*.</p>
    <p>This is madge `--circular` plus Lattix tearing. The meeting question is which import to invert, not “there is a cycle.”</p>
  </article>
  <figure class="artifact-figure artifact-figure-diagram">
    <svg viewBox="0 0 440 200" role="img" aria-label="Three strongly-connected-component small multiples. The first shows lib, session, and terminal with a highlighted tear edge.">
      <rect x="8" y="8" width="136" height="184" rx="6" fill="#111312" stroke="#a3e635" stroke-width="1.5"/>
      <text x="16" y="26" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="9">SCC 1 · 38 → zoom</text>
      <rect x="28" y="40" width="96" height="28" rx="4" fill="#16120a" stroke="#f59e0b"/>
      <text x="76" y="58" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="9">lib</text>
      <rect x="28" y="88" width="96" height="28" rx="4" fill="#16120a" stroke="#f59e0b"/>
      <text x="76" y="106" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="9">session</text>
      <rect x="28" y="136" width="96" height="28" rx="4" fill="#0f160a" stroke="#a3e635"/>
      <text x="76" y="154" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="9">terminal</text>
      <line x1="76" y1="68" x2="76" y2="88" stroke="#f59e0b"/>
      <line x1="76" y1="116" x2="76" y2="136" stroke="#a3e635" stroke-width="2"/>
      <text x="84" y="130" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="8">TEAR x4</text>
      <rect x="152" y="8" width="136" height="184" rx="6" fill="#111312" stroke="#333"/>
      <text x="160" y="26" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">SCC 2 · size 3</text>
      <circle cx="220" cy="70" r="14" fill="none" stroke="#56B4E9"/>
      <circle cx="188" cy="130" r="14" fill="none" stroke="#56B4E9"/>
      <circle cx="252" cy="130" r="14" fill="none" stroke="#56B4E9"/>
      <line x1="210" y1="80" x2="196" y2="118" stroke="#56B4E9"/>
      <line x1="230" y1="80" x2="244" y2="118" stroke="#56B4E9"/>
      <line x1="202" y1="130" x2="238" y2="130" stroke="#D55E00"/>
      <text x="220" y="170" text-anchor="middle" fill="#D55E00" font-family="JetBrains Mono, monospace" font-size="8">tear</text>
      <rect x="296" y="8" width="136" height="184" rx="6" fill="#111312" stroke="#333"/>
      <text x="304" y="26" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">SCC 3 · size 2</text>
      <rect x="312" y="70" width="104" height="24" rx="4" fill="none" stroke="#8a8a8a"/>
      <rect x="312" y="120" width="104" height="24" rx="4" fill="none" stroke="#8a8a8a"/>
      <line x1="364" y1="94" x2="364" y2="120" stroke="#a3e635"/>
      <text x="364" y="160" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">invert 1 import</text>
    </svg>
    <figcaption>V03. The 2026-08-12 finding that <code>lib/terminal</code> is not extractable until 8 outbound edges invert is this view, not a paragraph.</figcaption>
  </figure>
</section>

<section class="artifact-grid artifact-grid-2">
  <article class="artifact-panel">
    <p><span class="artifact-tag">V05</span> Type blueprint</p>
    <p><strong>What is the shape of this type?</strong> Not repo-wide UML (that wallpaper fails). Lanza class blueprint for one type: layers left to right are init, interface, implementation, accessors. Edges are calls. A schizophrenic type shows as two forests.</p>
    <p>System scale is polymetric: width = exports, height = methods, color = LOC. Gods, data bags, and tiny leaves pop. Inheritance is a hollow triangle, UML 2.5.</p>
    <p>On TS, the node is a file or an exported type, not a class. Accessors elide.</p>
  </article>
  <figure class="artifact-figure artifact-figure-diagram">
    <svg viewBox="0 0 440 200" role="img" aria-label="UML-ish class blueprint of SessionStore with inheritance triangle to Store, and a polymetric god rectangle for sessions.ts">
      <text x="16" y="18" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">one type · not the repo</text>
      <polygon points="120,28 132,48 108,48" fill="none" stroke="#c8c8c8" stroke-width="1.5"/>
      <text x="140" y="44" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="10">Store</text>
      <line x1="120" y1="48" x2="120" y2="64" stroke="#c8c8c8"/>
      <rect x="40" y="64" width="160" height="120" rx="4" fill="#141414" stroke="#56B4E9"/>
      <text x="48" y="80" fill="#56B4E9" font-family="JetBrains Mono, monospace" font-size="10">SessionStore</text>
      <rect x="48" y="88" width="28" height="84" fill="#0e1418" stroke="#38bdf8"/>
      <text x="52" y="132" fill="#38bdf8" font-family="JetBrains Mono, monospace" font-size="8" transform="rotate(-90 56 132)">init</text>
      <rect x="80" y="88" width="36" height="84" fill="#0e1418" stroke="#a3e635"/>
      <text x="84" y="128" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="8" transform="rotate(-90 92 128)">iface</text>
      <rect x="120" y="88" width="70" height="84" fill="#16120a" stroke="#f59e0b"/>
      <text x="128" y="132" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="9">impl forest</text>
      <rect x="230" y="64" width="70" height="120" rx="4" fill="#D55E00"/>
      <text x="238" y="100" fill="#0a0a0a" font-family="JetBrains Mono, monospace" font-size="9">sessions</text>
      <text x="238" y="116" fill="#0a0a0a" font-family="JetBrains Mono, monospace" font-size="9">.ts</text>
      <text x="238" y="140" fill="#0a0a0a" font-family="JetBrains Mono, monospace" font-size="9">w=exports</text>
      <text x="238" y="156" fill="#0a0a0a" font-family="JetBrains Mono, monospace" font-size="9">h=fns</text>
      <rect x="310" y="100" width="110" height="40" rx="4" fill="#141414" stroke="#333"/>
      <text x="318" y="124" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">data bag (wide, short)</text>
      <text x="310" y="184" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">Agent write-fence: do not enlarge the orange box.</text>
    </svg>
    <figcaption>V05. Lanza/Ducasse 2001–03. Repo-wide UML is on the do-not-build list. This is the class diagram that survives.</figcaption>
  </figure>
</section>

### Similarity

<section class="artifact-grid artifact-grid-2">
  <article class="artifact-panel">
    <p><span class="artifact-tag artifact-tag-accent">V04 v1</span> Dual trees + clone scatter</p>
    <p><strong>Where are the clone families, and is this pair extractable?</strong> Top: Duploc/Gemini file×file scatter. Off-diagonal squares are cross-file families. Bottom: two file trees, similarity % on the pair, VS Code-style diff against a canonical occurrence (TreeJuxtaposer + Deslop).</p>
    <p>Data: jscpd (Type-1), token clone (Type-2), tree-sitter subtree hash (Type-3). Generated code filtered. Min-token too low is brace noise; too high misses 8-line helpers.</p>
    <p>This is the view the prompt named: left tree, right tree, percent similar. Coincidental rhyme is not a family — `code:refactor` bias 1, concepts not lines.</p>
  </article>
  <figure class="artifact-figure artifact-figure-diagram">
    <svg viewBox="0 0 440 240" role="img" aria-label="Clone scatterplot above two file trees with an 87 percent similarity link between dispatch.ts and remote-cmd.ts">
      <rect x="8" y="8" width="200" height="100" rx="4" fill="#0f0f0f" stroke="#333"/>
      <text x="16" y="24" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">file × file</text>
      <line x1="24" y1="92" x2="192" y2="36" stroke="#333"/>
      <rect x="70" y="48" width="14" height="14" fill="#E69F00"/>
      <rect x="130" y="40" width="18" height="18" fill="#D55E00"/>
      <rect x="88" y="70" width="10" height="10" fill="#E69F00" opacity="0.5"/>
      <text x="148" y="36" fill="#D55E00" font-family="JetBrains Mono, monospace" font-size="8">family</text>
      <text x="220" y="24" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">canonical diff</text>
      <rect x="220" y="32" width="212" height="76" rx="4" fill="#0f0f0f" stroke="#333"/>
      <text x="228" y="52" fill="#f87171" font-family="JetBrains Mono, monospace" font-size="9">- ssh(host, cmd)</text>
      <text x="228" y="68" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="9">+ ssh(host, cmd, env)</text>
      <text x="228" y="88" fill="#888888" font-family="JetBrains Mono, monospace" font-size="8">SetEnv dropped at hop — RUSH-2028 class</text>
      <text x="20" y="128" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">lib/hosts</text>
      <text x="28" y="146" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="10">dispatch.ts</text>
      <text x="28" y="162" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="10">remote-cmd.ts</text>
      <text x="28" y="178" fill="#666666" font-family="JetBrains Mono, monospace" font-size="10">ssh.ts</text>
      <line x1="150" y1="142" x2="280" y2="142" stroke="#E69F00" stroke-width="2"/>
      <text x="186" y="136" fill="#E69F00" font-family="JetBrains Mono, monospace" font-size="10">87%</text>
      <text x="290" y="128" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">lib/devices</text>
      <text x="298" y="146" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="10">dispatch.ts</text>
      <text x="298" y="162" fill="#666666" font-family="JetBrains Mono, monospace" font-size="10">pick.ts</text>
      <text x="20" y="210" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">Agent: find_similar(span) → {canonical, bucket, safe_to_extract}.</text>
      <text x="20" y="226" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">Do not extract on rhyme. Same decision, two homes → extract.</text>
    </svg>
    <figcaption>V04. Scatter finds the family; dual trees plus canonical diff decide the action. Humans will not extract from a CSV.</figcaption>
  </figure>
</section>

<section class="artifact-grid artifact-grid-2">
  <article class="artifact-panel">
    <p><span class="artifact-tag">V16</span> Forked-implementation ribbon</p>
    <p><strong>Which concept was reimplemented N times instead of growing a contract?</strong> `patterns.ts` already clusters if/else-by-name families. Draw each family as parallel ribbons (one arm per variant) feeding one missing interface.</p>
    <p>2026-08-17: 125 families, 16 bypassed contracts, 42 missing, 2,347 collapsible arms. That is this view’s worklist, not a linter queue.</p>
    <p>Failure: collapsing twenty boring call sites into `doThing(opts)` with eight booleans. Consistency beats DRY; the ribbon must show the *decision*, not the lines.</p>
  </article>
  <figure class="artifact-figure artifact-figure-diagram">
    <svg viewBox="0 0 440 160" role="img" aria-label="Four parallel implementation arms for harness login converging on a missing Provider interface">
      <rect x="16" y="16" width="120" height="24" rx="4" fill="#16120a" stroke="#E69F00"/>
      <text x="76" y="32" text-anchor="middle" fill="#E69F00" font-family="JetBrains Mono, monospace" font-size="9">claude</text>
      <rect x="16" y="48" width="120" height="24" rx="4" fill="#16120a" stroke="#E69F00"/>
      <text x="76" y="64" text-anchor="middle" fill="#E69F00" font-family="JetBrains Mono, monospace" font-size="9">codex</text>
      <rect x="16" y="80" width="120" height="24" rx="4" fill="#16120a" stroke="#E69F00"/>
      <text x="76" y="96" text-anchor="middle" fill="#E69F00" font-family="JetBrains Mono, monospace" font-size="9">gemini</text>
      <rect x="16" y="112" width="120" height="24" rx="4" fill="#16120a" stroke="#E69F00"/>
      <text x="76" y="128" text-anchor="middle" fill="#E69F00" font-family="JetBrains Mono, monospace" font-size="9">grok</text>
      <path d="M136 28 C200 28, 200 80, 268 80" fill="none" stroke="#E69F00" stroke-width="2"/>
      <path d="M136 60 C200 60, 200 80, 268 80" fill="none" stroke="#E69F00" stroke-width="2"/>
      <path d="M136 92 C200 92, 200 80, 268 80" fill="none" stroke="#E69F00" stroke-width="2"/>
      <path d="M136 124 C200 124, 200 80, 268 80" fill="none" stroke="#E69F00" stroke-width="2"/>
      <rect x="268" y="56" width="152" height="48" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
      <text x="344" y="76" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">Provider</text>
      <text x="344" y="92" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">missing contract</text>
    </svg>
    <figcaption>V16. The provider-pattern family the refactor skill already measures. Ribbon, not a force graph of 2,347 arms.</figcaption>
  </figure>
</section>

### Usage

<section class="artifact-grid artifact-grid-2">
  <article class="artifact-panel">
    <p><span class="artifact-tag artifact-tag-accent">V06 v1</span> Type-usage matrix</p>
    <p><strong>Who uses whom? What is dead? What is accidentally public?</strong> Rows = exported symbols, grouped by package. Columns = using packages. Cell = reference count. Empty prod row = hatch. Dense column = god importer. Toggle hides `export *` barrels.</p>
    <p>Data: SCIP or tsserver, not grep. Test vs prod refs split. Reflection and string DI undercount; say so.</p>
    <p>Agent must query this before introducing a new export. `knip` is the CLI ancestor; the matrix is why a human trusts the empty row.</p>
  </article>
  <figure class="artifact-figure artifact-figure-diagram">
    <svg viewBox="0 0 440 200" role="img" aria-label="Type usage matrix with a hatched empty row for an unused export and a dense column for commands">
      <text x="110" y="20" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">cmd</text>
      <text x="160" y="20" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">sess</text>
      <text x="210" y="20" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">hook</text>
      <text x="260" y="20" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">test</text>
      <text x="16" y="48" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="9">SessionRow</text>
      <rect x="100" y="32" width="40" height="22" fill="#009E73"/>
      <rect x="150" y="32" width="40" height="22" fill="#009E73" opacity="0.7"/>
      <rect x="200" y="32" width="40" height="22" fill="#222" stroke="#333"/>
      <rect x="250" y="32" width="40" height="22" fill="#009E73" opacity="0.4"/>
      <text x="16" y="80" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="9">buildExecEnv</text>
      <rect x="100" y="64" width="40" height="22" fill="#009E73"/>
      <rect x="150" y="64" width="40" height="22" fill="#009E73"/>
      <rect x="200" y="64" width="40" height="22" fill="#009E73" opacity="0.5"/>
      <rect x="250" y="64" width="40" height="22" fill="#222" stroke="#333"/>
      <text x="16" y="112" fill="#D55E00" font-family="JetBrains Mono, monospace" font-size="9">LegacyHost</text>
      <rect x="100" y="96" width="40" height="22" fill="none" stroke="#D55E00" stroke-dasharray="3 2"/>
      <rect x="150" y="96" width="40" height="22" fill="none" stroke="#D55E00" stroke-dasharray="3 2"/>
      <rect x="200" y="96" width="40" height="22" fill="none" stroke="#D55E00" stroke-dasharray="3 2"/>
      <rect x="250" y="96" width="40" height="22" fill="#009E73" opacity="0.3"/>
      <text x="300" y="112" fill="#D55E00" font-family="JetBrains Mono, monospace" font-size="9">0 prod · hatch</text>
      <text x="16" y="144" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="9">ResourceKind</text>
      <rect x="100" y="128" width="40" height="22" fill="#009E73"/>
      <rect x="150" y="128" width="40" height="22" fill="#222" stroke="#333"/>
      <rect x="200" y="128" width="40" height="22" fill="#009E73" opacity="0.6"/>
      <rect x="250" y="128" width="40" height="22" fill="#009E73" opacity="0.4"/>
      <text x="16" y="176" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">Empty hatch = delete candidate. Dense cmd column = the app entry, expected.</text>
      <text x="16" y="192" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">Agent: `refs(symbol, prodOnly=true)` before `export`.</text>
    </svg>
    <figcaption>V06. The type inventory the prompt asked for, with use — not a list of names. Dead is emptiness, not a score.</figcaption>
  </figure>
</section>

<section class="artifact-grid artifact-grid-2">
  <article class="artifact-panel">
    <p><span class="artifact-tag artifact-tag-accent">V07 v1</span> Butterfly from CGraph</p>
    <p><strong>If I change this function, what is the blast radius?</strong> Selected node center, callers left, callees right. Depth 1/2/3. Size = LOC. Color = hotspot. Depth 3 on a utility is the whole program — cap by non-std, non-generated.</p>
    <p>Data: Nxtsoft CGraph `graph.json` (tree-sitter: files, classes, functions, types; edges `contains` / `calls` / `imports` / `inherits` / `implements` / `references`). Precise hops prefer SCIP/`tsserver`. CGraph confidence: Extracted | Inferred | Ambiguous — paint inferred dashed, never silently.</p>
    <p>MCP twins: `graph_impact`, `graph_path`, `graph_context`. npm `cgraph` and FalkorDB `cgraph-mcp` are different products; this fleet runs `cgraph-mcp --root &lt;project&gt; --daemon`.</p>
  </article>
  <figure class="artifact-figure artifact-figure-diagram">
    <svg viewBox="0 0 440 200" role="img" aria-label="Butterfly ego graph centered on buildExecEnv with callers on the left and callees on the right">
      <rect x="16" y="40" width="100" height="28" rx="4" fill="#141414" stroke="#56B4E9"/>
      <text x="66" y="58" text-anchor="middle" fill="#56B4E9" font-family="JetBrains Mono, monospace" font-size="9">run.ts</text>
      <rect x="16" y="84" width="100" height="28" rx="4" fill="#141414" stroke="#56B4E9"/>
      <text x="66" y="102" text-anchor="middle" fill="#56B4E9" font-family="JetBrains Mono, monospace" font-size="9">teams.ts</text>
      <rect x="16" y="128" width="100" height="28" rx="4" fill="#141414" stroke="#333"/>
      <text x="66" y="146" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">routines</text>
      <rect x="160" y="76" width="120" height="44" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
      <text x="220" y="94" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">buildExecEnv</text>
      <text x="220" y="110" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">exec.ts · hops=2</text>
      <rect x="324" y="40" width="100" height="28" rx="4" fill="#141414" stroke="#E69F00"/>
      <text x="374" y="58" text-anchor="middle" fill="#E69F00" font-family="JetBrains Mono, monospace" font-size="9">execAgent</text>
      <rect x="324" y="84" width="100" height="28" rx="4" fill="#141414" stroke="#E69F00"/>
      <text x="374" y="102" text-anchor="middle" fill="#E69F00" font-family="JetBrains Mono, monospace" font-size="9">versionHome</text>
      <rect x="324" y="128" width="100" height="28" rx="4" fill="#141414" stroke="#333"/>
      <text x="374" y="146" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">env.ts</text>
      <line x1="116" y1="54" x2="160" y2="90" stroke="#38bdf8" stroke-dasharray="3 3"/>
      <line x1="116" y1="98" x2="160" y2="98" stroke="#38bdf8"/>
      <line x1="116" y1="142" x2="160" y2="106" stroke="#38bdf8" stroke-dasharray="3 3"/>
      <line x1="280" y1="90" x2="324" y2="54" stroke="#38bdf8"/>
      <line x1="280" y1="98" x2="324" y2="98" stroke="#38bdf8"/>
      <line x1="280" y1="106" x2="324" y2="142" stroke="#38bdf8" stroke-dasharray="3 3"/>
      <text x="16" y="24" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">callers</text>
      <text x="360" y="24" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">callees</text>
      <text x="16" y="188" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">Dashed = Inferred. Solid = Extracted. Ambiguous does not draw as fact.</text>
    </svg>
    <figcaption>V07. Understand’s best graph, fed by CGraph + SCIP. Node-link is legal because this is an ego neighborhood, not the system.</figcaption>
  </figure>
</section>

<section class="artifact-grid artifact-grid-2">
  <article class="artifact-panel">
    <p><span class="artifact-tag">V08</span> Coverage icicle</p>
    <p><strong>Is the code we actually edit tested?</strong> Icicle of package → file → function, color = hit count, not covered-or-not. Pair with churn so a 95% covered generated serializer does not look healthier than a 40% authn state machine.</p>
    <p>Data: lcov/c8 plus the 90-day git window. Failure: Sonar coverage treemap (area = ncloc, color = coverage %) celebrates covering the biggest files.</p>
  </article>
  <figure class="artifact-figure artifact-figure-diagram">
    <svg viewBox="0 0 440 140" role="img" aria-label="Icicle of cli/src/lib with session colored cold for low hit count despite large size, and a small auth-like sliver hot">
      <rect x="8" y="24" width="424" height="28" fill="#141414" stroke="#333"/>
      <text x="16" y="42" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="10">cli/src/lib</text>
      <rect x="8" y="52" width="220" height="36" fill="#0072B2"/>
      <text x="16" y="74" fill="#e8e8e8" font-family="JetBrains Mono, monospace" font-size="10">session/ · large · cold hits</text>
      <rect x="228" y="52" width="120" height="36" fill="#009E73"/>
      <text x="236" y="74" fill="#0a0a0a" font-family="JetBrains Mono, monospace" font-size="9">browser</text>
      <rect x="348" y="52" width="84" height="36" fill="#D55E00"/>
      <text x="356" y="74" fill="#0a0a0a" font-family="JetBrains Mono, monospace" font-size="9">hot+bare</text>
      <text x="8" y="110" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">Color is hit count. Orange on a small slice beats green on a giant cold one.</text>
      <text x="8" y="128" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">Do not put wall-clock on x; that is a trace waterfall, not this.</text>
    </svg>
    <figcaption>V08. Gregg’s icicle grammar, coverage as the quantity. Binary covered/uncovered is the Sonar sin.</figcaption>
  </figure>
</section>

### Evolution and risk

<section class="artifact-grid artifact-grid-2">
  <article class="artifact-panel">
    <p><span class="artifact-tag">V09</span> SeeSoft strip</p>
    <p><strong>Where did last week’s work land? What is old-in-place and still patched?</strong> One column per file, 1-px rows, indent preserved (Eick, Steffen, Sumner, TSE 1992). Color: blue = untouched 12 months, yellow = this quarter, vermillion = this week. Click opens the editor at that line.</p>
    <p>Filter generated files and format-only commits. Line-level blame is cached. A second mode colors by author, cap 8 hues + other.</p>
  </article>
  <figure class="artifact-figure artifact-figure-diagram">
    <svg viewBox="0 0 440 160" role="img" aria-label="SeeSoft-style columns of colored line strips for sessions.ts, discover.ts, and a quiet file">
      <text x="24" y="18" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">sessions.ts</text>
      <rect x="24" y="24" width="8" height="2" fill="#0072B2"/>
      <rect x="24" y="27" width="14" height="2" fill="#0072B2"/>
      <rect x="24" y="30" width="10" height="2" fill="#D55E00"/>
      <rect x="24" y="33" width="18" height="2" fill="#D55E00"/>
      <rect x="24" y="36" width="6" height="2" fill="#F0E442"/>
      <rect x="24" y="39" width="16" height="2" fill="#0072B2"/>
      <rect x="24" y="42" width="12" height="2" fill="#D55E00"/>
      <rect x="24" y="45" width="20" height="2" fill="#0072B2"/>
      <rect x="24" y="48" width="8" height="2" fill="#0072B2"/>
      <rect x="24" y="51" width="14" height="2" fill="#F0E442"/>
      <rect x="24" y="54" width="10" height="2" fill="#0072B2"/>
      <rect x="24" y="57" width="18" height="2" fill="#0072B2"/>
      <rect x="24" y="60" width="7" height="2" fill="#D55E00"/>
      <rect x="24" y="63" width="15" height="2" fill="#0072B2"/>
      <rect x="24" y="66" width="11" height="2" fill="#0072B2"/>
      <rect x="24" y="69" width="19" height="2" fill="#F0E442"/>
      <rect x="24" y="72" width="9" height="2" fill="#0072B2"/>
      <rect x="24" y="75" width="13" height="2" fill="#0072B2"/>
      <rect x="24" y="78" width="17" height="2" fill="#0072B2"/>
      <rect x="24" y="81" width="8" height="2" fill="#D55E00"/>
      <rect x="24" y="84" width="14" height="2" fill="#0072B2"/>
      <rect x="24" y="87" width="10" height="2" fill="#0072B2"/>
      <rect x="24" y="90" width="16" height="2" fill="#0072B2"/>
      <rect x="24" y="93" width="6" height="2" fill="#0072B2"/>
      <rect x="24" y="96" width="12" height="2" fill="#F0E442"/>
      <rect x="24" y="99" width="18" height="2" fill="#0072B2"/>
      <rect x="24" y="102" width="9" height="2" fill="#0072B2"/>
      <rect x="24" y="105" width="15" height="2" fill="#0072B2"/>
      <rect x="24" y="108" width="11" height="2" fill="#0072B2"/>
      <rect x="24" y="111" width="7" height="2" fill="#D55E00"/>
      <rect x="24" y="114" width="13" height="2" fill="#0072B2"/>
      <rect x="24" y="117" width="19" height="2" fill="#0072B2"/>
      <rect x="24" y="120" width="8" height="2" fill="#0072B2"/>
      <text x="70" y="18" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">discover.ts</text>
      <rect x="70" y="24" width="10" height="2" fill="#0072B2"/>
      <rect x="70" y="27" width="16" height="2" fill="#0072B2"/>
      <rect x="70" y="30" width="8" height="2" fill="#0072B2"/>
      <rect x="70" y="33" width="14" height="2" fill="#F0E442"/>
      <rect x="70" y="36" width="20" height="2" fill="#0072B2"/>
      <rect x="70" y="39" width="7" height="2" fill="#0072B2"/>
      <rect x="70" y="42" width="12" height="2" fill="#0072B2"/>
      <rect x="70" y="45" width="18" height="2" fill="#0072B2"/>
      <rect x="70" y="48" width="9" height="2" fill="#D55E00"/>
      <rect x="70" y="51" width="15" height="2" fill="#0072B2"/>
      <rect x="70" y="54" width="11" height="2" fill="#0072B2"/>
      <rect x="70" y="57" width="17" height="2" fill="#0072B2"/>
      <rect x="70" y="60" width="6" height="2" fill="#0072B2"/>
      <rect x="70" y="63" width="13" height="2" fill="#0072B2"/>
      <rect x="70" y="66" width="19" height="2" fill="#F0E442"/>
      <rect x="70" y="69" width="8" height="2" fill="#0072B2"/>
      <rect x="70" y="72" width="14" height="2" fill="#0072B2"/>
      <rect x="70" y="75" width="10" height="2" fill="#0072B2"/>
      <rect x="70" y="78" width="16" height="2" fill="#0072B2"/>
      <rect x="70" y="81" width="7" height="2" fill="#0072B2"/>
      <rect x="70" y="84" width="12" height="2" fill="#0072B2"/>
      <rect x="70" y="87" width="18" height="2" fill="#0072B2"/>
      <rect x="70" y="90" width="9" height="2" fill="#0072B2"/>
      <rect x="70" y="93" width="15" height="2" fill="#F0E442"/>
      <rect x="70" y="96" width="11" height="2" fill="#0072B2"/>
      <rect x="70" y="99" width="17" height="2" fill="#0072B2"/>
      <rect x="70" y="102" width="6" height="2" fill="#0072B2"/>
      <rect x="70" y="105" width="13" height="2" fill="#0072B2"/>
      <rect x="70" y="108" width="19" height="2" fill="#0072B2"/>
      <rect x="70" y="111" width="8" height="2" fill="#0072B2"/>
      <rect x="70" y="114" width="14" height="2" fill="#0072B2"/>
      <rect x="70" y="117" width="10" height="2" fill="#0072B2"/>
      <rect x="70" y="120" width="16" height="2" fill="#0072B2"/>
      <text x="120" y="18" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">pick.ts</text>
      <rect x="120" y="24" width="12" height="2" fill="#0072B2"/>
      <rect x="120" y="27" width="8" height="2" fill="#0072B2"/>
      <rect x="120" y="30" width="14" height="2" fill="#0072B2"/>
      <rect x="120" y="33" width="10" height="2" fill="#0072B2"/>
      <rect x="120" y="36" width="16" height="2" fill="#0072B2"/>
      <rect x="120" y="39" width="7" height="2" fill="#0072B2"/>
      <rect x="120" y="42" width="11" height="2" fill="#0072B2"/>
      <rect x="120" y="45" width="9" height="2" fill="#0072B2"/>
      <rect x="120" y="48" width="13" height="2" fill="#0072B2"/>
      <rect x="120" y="51" width="6" height="2" fill="#F0E442"/>
      <rect x="120" y="54" width="15" height="2" fill="#0072B2"/>
      <rect x="120" y="57" width="8" height="2" fill="#0072B2"/>
      <rect x="120" y="60" width="12" height="2" fill="#0072B2"/>
      <text x="180" y="40" fill="#D55E00" font-family="JetBrains Mono, monospace" font-size="9">this week</text>
      <text x="180" y="58" fill="#F0E442" font-family="JetBrains Mono, monospace" font-size="9">this quarter</text>
      <text x="180" y="76" fill="#56B4E9" font-family="JetBrains Mono, monospace" font-size="9">untouched ≥12mo</text>
      <text x="180" y="110" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">Friday review: did the agent touch authn, or thrash tests?</text>
      <text x="180" y="128" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">Faster than git log -p. Filter lockfiles or they steal the red.</text>
    </svg>
    <figcaption>V09. Direct descendant of the most cited software-vis paper. The GitHub contribution calendar is the same encoding at year grain.</figcaption>
  </figure>
</section>

<section class="artifact-grid artifact-grid-2">
  <article class="artifact-panel">
    <p><span class="artifact-tag artifact-tag-accent">V10 v1</span> Hotspot map</p>
    <p><strong>Where does unhealthy code meet actual work?</strong> Same path-sorted treemap as V01 so spatial memory transfers. Area = LOC (complexity proxy). Color = sequential hot for 90-day relative churn (Nagappan/Ball 2005; Tornhill 2015). Ranked table with a complexity-trend sparkline beside it.</p>
    <p>Lifetime commits rank historical construction sites. Window to 90 days for “what now.” Micro-commit bias: offer relative-churn mode.</p>
    <p>Agent default: do not edit the top-10 hotspots unless the task names them.</p>
  </article>
  <figure class="artifact-figure artifact-figure-diagram">
    <svg viewBox="0 0 440 180" role="img" aria-label="Hotspot treemap with sessions.ts hot and large, plus a ranked table with sparklines">
      <rect x="8" y="8" width="240" height="164" rx="4" fill="#0a0a0a" stroke="#333"/>
      <rect x="16" y="20" width="130" height="140" fill="#D55E00"/>
      <text x="24" y="48" fill="#0a0a0a" font-family="JetBrains Mono, monospace" font-size="10">sessions.ts</text>
      <text x="24" y="64" fill="#0a0a0a" font-family="JetBrains Mono, monospace" font-size="9">6392 · hot</text>
      <rect x="152" y="20" width="88" height="80" fill="#E69F00"/>
      <text x="160" y="44" fill="#0a0a0a" font-family="JetBrains Mono, monospace" font-size="9">discover</text>
      <rect x="152" y="104" width="88" height="56" fill="#F0E442"/>
      <text x="160" y="128" fill="#0a0a0a" font-family="JetBrains Mono, monospace" font-size="9">db.ts</text>
      <text x="260" y="24" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">90d rank</text>
      <text x="260" y="48" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="9">1 sessions.ts</text>
      <polyline points="380,40 388,44 396,36 404,42 412,30" fill="none" stroke="#D55E00"/>
      <text x="260" y="72" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="9">2 discover.ts</text>
      <polyline points="380,64 388,60 396,68 404,62 412,58" fill="none" stroke="#E69F00"/>
      <text x="260" y="96" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="9">3 db.ts</text>
      <polyline points="380,88 388,90 396,86 404,88 412,84" fill="none" stroke="#F0E442"/>
      <text x="260" y="128" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">Sparkline = indent-complexity</text>
      <text x="260" y="144" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">over releases, not Gource.</text>
    </svg>
    <figcaption>V10. The refactor backlog. Most used actionable vis in industry that is not a dashboard of counts.</figcaption>
  </figure>
</section>

<section class="artifact-grid artifact-grid-2">
  <article class="artifact-panel">
    <p><span class="artifact-tag">V11</span> Knowledge map</p>
    <p><strong>Who knows this, and what happens if they leave?</strong> Same layout as V10. Color = primary author, max 12 categorical + grey. Sidebar: Avelino truck-factor, slider “remove Alice” desaturates her files and lists newly orphaned hotspots.</p>
    <p>CODEOWNERS is declared, not observed — overlay it, do not substitute. Exclude bots, formatters, `vendor/`.</p>
    <p>The scary cell is hotspot ∩ single-owner. Pair with V10 always.</p>
  </article>
  <figure class="artifact-figure artifact-figure-diagram">
    <svg viewBox="0 0 440 150" role="img" aria-label="Same treemap as the hotspot, recolored by author, with a remove-owner slider listing orphaned hotspots">
      <rect x="8" y="8" width="200" height="134" rx="4" fill="#0a0a0a" stroke="#333"/>
      <rect x="16" y="20" width="110" height="110" fill="#56B4E9"/>
      <rect x="132" y="20" width="68" height="60" fill="#CC79A7"/>
      <rect x="132" y="84" width="68" height="46" fill="#56B4E9" opacity="0.35"/>
      <text x="24" y="48" fill="#0a0a0a" font-family="JetBrains Mono, monospace" font-size="9">owner A</text>
      <text x="140" y="44" fill="#0a0a0a" font-family="JetBrains Mono, monospace" font-size="9">owner B</text>
      <text x="140" y="108" fill="#0a0a0a" font-family="JetBrains Mono, monospace" font-size="8">orphan?</text>
      <text x="220" y="28" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">truck factor 2</text>
      <rect x="220" y="40" width="200" height="8" rx="2" fill="#141414" stroke="#333"/>
      <rect x="300" y="38" width="8" height="12" fill="#a3e635"/>
      <text x="220" y="68" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="9">remove B →</text>
      <text x="220" y="88" fill="#D55E00" font-family="JetBrains Mono, monospace" font-size="9">discover.ts orphaned</text>
      <text x="220" y="108" fill="#D55E00" font-family="JetBrains Mono, monospace" font-size="9">and it is a hotspot</text>
      <text x="220" y="132" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">That intersection is the page-out.</text>
    </svg>
    <figcaption>V11. Avelino ICPC 2016. Line authorship is not expertise; treat the slider as a risk probe, not an HR tool.</figcaption>
  </figure>
</section>

<section class="artifact-grid artifact-grid-2">
  <article class="artifact-panel">
    <p><span class="artifact-tag">V12</span> Change-coupling Sankey</p>
    <p><strong>What co-changes that the compiler cannot see?</strong> Directory-to-directory Sankey, width = same-commit co-occurrence. Filter “not explained by a static import.” Drill to file pairs.</p>
    <p>This is the hidden architecture: proto ↔ mapper, schema ↔ DAO, CSS ↔ component. A static import graph misses it entirely.</p>
    <p>Failure: mass refactors paint all-to-all. Window the history. Agent about to edit `foo.proto` should be shown `foo_mapper.ts`.</p>
  </article>
  <figure class="artifact-figure artifact-figure-diagram">
    <svg viewBox="0 0 440 150" role="img" aria-label="Sankey from session and browser directories into db and service files, one flow marked as no static import">
      <rect x="16" y="24" width="90" height="36" rx="4" fill="#141414" stroke="#0072B2"/>
      <text x="61" y="46" text-anchor="middle" fill="#56B4E9" font-family="JetBrains Mono, monospace" font-size="9">session/</text>
      <rect x="16" y="80" width="90" height="36" rx="4" fill="#141414" stroke="#0072B2"/>
      <text x="61" y="102" text-anchor="middle" fill="#56B4E9" font-family="JetBrains Mono, monospace" font-size="9">browser/</text>
      <path d="M106 42 C180 42, 180 42, 250 42" fill="none" stroke="#56B4E9" stroke-width="14" opacity="0.5"/>
      <path d="M106 98 C180 98, 180 70, 250 70" fill="none" stroke="#D55E00" stroke-width="8" opacity="0.8"/>
      <rect x="250" y="24" width="170" height="36" rx="4" fill="#141414" stroke="#333"/>
      <text x="335" y="46" text-anchor="middle" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="9">db.ts  (has import)</text>
      <rect x="250" y="72" width="170" height="36" rx="4" fill="#16120a" stroke="#D55E00"/>
      <text x="335" y="94" text-anchor="middle" fill="#D55E00" font-family="JetBrains Mono, monospace" font-size="9">no static import</text>
      <text x="16" y="140" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">Orange flow is the architecture the compiler cannot see.</text>
    </svg>
    <figcaption>V12. Tornhill logical coupling. Width is co-change count, not LOC.</figcaption>
  </figure>
</section>

### Contracts and the agent overlay

<section class="artifact-grid artifact-grid-2">
  <article class="artifact-panel">
    <p><span class="artifact-tag artifact-tag-accent">V13 v1</span> Contract overlay</p>
    <p><strong>Which dependencies violate the architecture we said we had?</strong> Take the V02 DSM (or Holten bundles) and paint illegal edges in one alarm color. Legal edges mute. The only KPI is violation count, trended.</p>
    <p>Data: dependency-cruiser `forbidden` rules, or a `layers.yml` generated once from the partitioned DSM and then frozen. A spec that describes the status quo is rot.</p>
    <p>CI already owns the fail. This view is what you open when CI goes red, and what an agent consults *before* adding an import.</p>
  </article>
  <figure class="artifact-figure artifact-figure-diagram">
    <svg viewBox="0 0 440 140" role="img" aria-label="Same DSM as V02 with only the illegal commands-to-native cell lit, everything else muted">
      <text x="16" y="20" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">declared: commands must not import native/</text>
      <rect x="40" y="36" width="24" height="24" fill="#1a1a1a" stroke="#333"/>
      <rect x="68" y="36" width="24" height="24" fill="#1a1a1a" stroke="#333"/>
      <rect x="96" y="36" width="24" height="24" fill="#1a1a1a" stroke="#333"/>
      <rect x="124" y="36" width="24" height="24" fill="#1a1a1a" stroke="#333"/>
      <rect x="152" y="36" width="24" height="24" fill="#D55E00" stroke="#D55E00" stroke-width="2"/>
      <rect x="180" y="36" width="24" height="24" fill="#1a1a1a" stroke="#333"/>
      <rect x="40" y="64" width="24" height="24" fill="#1a1a1a" stroke="#333"/>
      <rect x="68" y="64" width="24" height="24" fill="#1a1a1a" stroke="#333"/>
      <rect x="96" y="64" width="24" height="24" fill="#1a1a1a" stroke="#333"/>
      <rect x="124" y="64" width="24" height="24" fill="#1a1a1a" stroke="#333"/>
      <rect x="152" y="64" width="24" height="24" fill="#1a1a1a" stroke="#333"/>
      <rect x="180" y="64" width="24" height="24" fill="#1a1a1a" stroke="#333"/>
      <text x="220" y="52" fill="#D55E00" font-family="JetBrains Mono, monospace" font-size="10">1 illegal cell</text>
      <text x="220" y="70" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">commands.ts:14 import native</text>
      <text x="220" y="88" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">rule: cli ↛ native</text>
      <text x="16" y="118" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">Show the exception, mute the rule. Agent: refuse the import, do not warn-and-continue.</text>
    </svg>
    <figcaption>V13. Structure101 overlays + dependency-cruiser, as a picture. Generate the first spec from V02, then freeze it.</figcaption>
  </figure>
</section>

<section class="artifact-grid artifact-grid-2">
  <article class="artifact-panel">
    <p><span class="artifact-tag">V14</span> Public-surface census</p>
    <p><strong>What do we promise, and is the promise growing faster than callers?</strong> Icicle of the public namespace. Area = caller count, not LOC. Zero-caller public function is a thin sliver with an alarm hatch. Timeline: public-symbol count vs used-public-symbol count.</p>
    <p>Data: `surface.ts --cli` / `--exports`. Orphans are candidates, not proof — commands resolve by name. Truncation (`meta.truncated`) must render as truncated, never as the count.</p>
    <p>Agents love to export helpers “for reuse.” This view is the counter-pressure.</p>
  </article>
  <figure class="artifact-figure artifact-figure-diagram">
    <svg viewBox="0 0 440 130" role="img" aria-label="Public surface icicle with a hatched zero-caller sliver and a sparkline of public versus used symbols">
      <rect x="8" y="24" width="280" height="40" fill="#141414" stroke="#CC79A7"/>
      <text x="16" y="48" fill="#CC79A7" font-family="JetBrains Mono, monospace" font-size="10">agents sessions *</text>
      <rect x="8" y="64" width="160" height="28" fill="#009E73"/>
      <text x="16" y="82" fill="#0a0a0a" font-family="JetBrains Mono, monospace" font-size="9">used</text>
      <rect x="168" y="64" width="80" height="28" fill="none" stroke="#D55E00" stroke-dasharray="3 2"/>
      <text x="176" y="82" fill="#D55E00" font-family="JetBrains Mono, monospace" font-size="9">0 callers</text>
      <text x="300" y="40" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9">public vs used</text>
      <polyline points="300,70 320,68 340,64 360,60 380,52 400,48" fill="none" stroke="#CC79A7"/>
      <polyline points="300,90 320,88 340,88 360,86 380,84 400,82" fill="none" stroke="#009E73"/>
      <text x="300" y="112" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">upper = exported</text>
    </svg>
    <figcaption>V14. <code>surface.ts</code> already walks this. The picture is the missing half: promise growing, callers not.</figcaption>
  </figure>
</section>

<section class="artifact-grid artifact-grid-2">
  <article class="artifact-panel">
    <p><span class="artifact-tag artifact-tag-accent">V15 v1</span> Agent-traffic board</p>
    <p><strong>Where are agents reading and writing, and are two about to collide?</strong> Live: file tree with pulse, agent-id chips, collision when two sessions hold the same file or a V07 neighbor. Heatmap: treemap colored by agent-touched lines / total over 7/30 days.</p>
    <p>Data: `exposure.ts` (git churn + agent Read/Edit from `sessions.db`). Keep path, op, timestamp, agent-id, diff stats. Prompts in this telemetry are a secret-retention bug.</p>
    <p>This is the fleet-specific view. Gource with analysis discipline. Symphony’s constellation is a demo; the collision panel is the steal.</p>
  </article>
  <figure class="artifact-figure artifact-figure-diagram">
    <svg viewBox="0 0 440 170" role="img" aria-label="File tree with two agent chips colliding on session/db.ts and a blast-radius preview">
      <text x="16" y="20" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">lib/session</text>
      <text x="28" y="40" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="10">discover.ts</text>
      <circle cx="200" cy="36" r="6" fill="#a3e635"/>
      <text x="212" y="40" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="8">ag-a</text>
      <text x="28" y="60" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="10">db.ts</text>
      <circle cx="200" cy="56" r="6" fill="#a3e635"/>
      <circle cx="216" cy="56" r="6" fill="#56B4E9"/>
      <text x="230" y="60" fill="#f87171" font-family="JetBrains Mono, monospace" font-size="9">COLLIDE</text>
      <text x="28" y="80" fill="#666666" font-family="JetBrains Mono, monospace" font-size="10">index.ts</text>
      <rect x="16" y="100" width="408" height="54" rx="4" fill="#1a0e0a" stroke="#D55E00"/>
      <text x="24" y="120" fill="#D55E00" font-family="JetBrains Mono, monospace" font-size="10">blast radius · hops=1 from db.ts</text>
      <text x="24" y="138" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="9">discover.ts · commands/sessions.ts · accounting/usage.ts</text>
      <text x="16" y="164" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="10">Write-fence until one session yields. UI does not schedule the resume; the CLI daemon does.</text>
    </svg>
    <figcaption>V15. Fleet control-plane view. Collision + blast radius, not a 3D constellation. Scheduling stays in the CLI daemon (one executor).</figcaption>
  </figure>
</section>

## v1 kit — what to build first

Eight views cover every genre without repeating a known failure. The sourced `code:refactor` before/after stays as the ninth, because it is the only figure whose numbers cannot drift from `modules.json`.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg viewBox="0 0 960 220" role="img" aria-label="v1 kit of eight views plus the existing refactor figure, mapped to data sources">
    <rect x="12" y="16" width="110" height="72" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
    <text x="67" y="44" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">V02 DSM</text>
    <text x="67" y="62" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">modules.ts</text>
    <rect x="130" y="16" width="110" height="72" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
    <text x="185" y="44" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">V03 cycles</text>
    <text x="185" y="62" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">Tarjan / tear</text>
    <rect x="248" y="16" width="110" height="72" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
    <text x="303" y="44" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">V04 dual</text>
    <text x="303" y="62" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">jscpd + trees</text>
    <rect x="366" y="16" width="110" height="72" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
    <text x="421" y="44" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">V06 types</text>
    <text x="421" y="62" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">SCIP / knip</text>
    <rect x="484" y="16" width="110" height="72" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
    <text x="539" y="44" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">V07 ego</text>
    <text x="539" y="62" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">cgraph MCP</text>
    <rect x="602" y="16" width="110" height="72" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
    <text x="657" y="44" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">V10 hot</text>
    <text x="657" y="62" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">git log 90d</text>
    <rect x="720" y="16" width="110" height="72" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
    <text x="775" y="44" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">V13 rules</text>
    <text x="775" y="62" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">depcruiser</text>
    <rect x="838" y="16" width="110" height="72" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
    <text x="893" y="44" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">V15 fleet</text>
    <text x="893" y="62" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="8">sessions.db</text>
    <rect x="12" y="104" width="936" height="96" rx="8" fill="#111312" stroke="#26302a"/>
    <text x="28" y="128" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="13">Payoff</text>
    <text x="28" y="148" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="12">A tech lead can point at a cell and say invert this import, extract this pair, do not enlarge this file, two agents will collide. That is a landed refactor, not a findings queue.</text>
    <text x="28" y="176" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="13">Cost of skipping</text>
    <text x="160" y="176" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="12">Agents keep growing sessions.ts because the signal is a LOC integer. Comment % stays the thing the skill already told you not to target.</text>
  </svg>
  <figcaption><b>Figure 2.</b> v1 kit. Later views (SeeSoft, knowledge, Sankey, coverage, polymetric, forked ribbons, public surface) reuse these layouts. Do not add a new metaphor until these eight are click-through to file:line.</figcaption>
</figure>

## Pipeline — map first, then draw

CGraph maps symbols. `modules.ts` maps packages. Git maps time. `sessions.db` maps agents. The picture is a projection, not a second source of truth. The LLM may caption a cluster; it may not invent an edge.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg viewBox="0 0 960 280" role="img" aria-label="Data plane from extractors into a graph store then into human views and agent queries">
    <rect x="16" y="24" width="140" height="56" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
    <text x="86" y="48" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">modules.ts</text>
    <text x="86" y="66" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="10">package graph</text>
    <rect x="16" y="96" width="140" height="56" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
    <text x="86" y="120" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">CGraph</text>
    <text x="86" y="138" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="10">graph.json MCP</text>
    <rect x="16" y="168" width="140" height="56" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
    <text x="86" y="192" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">SCIP / tsserver</text>
    <text x="86" y="210" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="10">precise refs</text>
    <rect x="180" y="24" width="140" height="56" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="250" y="48" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">jscpd</text>
    <text x="250" y="66" text-anchor="middle" fill="#38bdf8" font-family="JetBrains Mono, monospace" font-size="10">clone pairs</text>
    <rect x="180" y="96" width="140" height="56" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="250" y="120" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">git log</text>
    <text x="250" y="138" text-anchor="middle" fill="#38bdf8" font-family="JetBrains Mono, monospace" font-size="10">churn · blame · DOA</text>
    <rect x="180" y="168" width="140" height="56" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="250" y="192" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">sessions.db</text>
    <text x="250" y="210" text-anchor="middle" fill="#38bdf8" font-family="JetBrains Mono, monospace" font-size="10">Read / Edit</text>
    <line x1="156" y1="52" x2="348" y2="52" stroke="#38bdf8" stroke-dasharray="3 3" opacity="0.7"/>
    <line x1="156" y1="124" x2="348" y2="124" stroke="#38bdf8" stroke-dasharray="3 3" opacity="0.7"/>
    <line x1="156" y1="196" x2="348" y2="196" stroke="#38bdf8" stroke-dasharray="3 3" opacity="0.7"/>
    <line x1="320" y1="52" x2="348" y2="124" stroke="#38bdf8" stroke-dasharray="3 3" opacity="0.7"/>
    <line x1="320" y1="196" x2="348" y2="124" stroke="#38bdf8" stroke-dasharray="3 3" opacity="0.7"/>
    <rect x="348" y="88" width="160" height="80" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="428" y="120" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="13">graph store</text>
    <text x="428" y="140" text-anchor="middle" fill="#38bdf8" font-family="JetBrains Mono, monospace" font-size="10">one index, many views</text>
    <line x1="508" y1="112" x2="560" y2="52" stroke="#38bdf8" stroke-dasharray="3 3" opacity="0.7"/>
    <line x1="508" y1="128" x2="560" y2="128" stroke="#38bdf8" stroke-dasharray="3 3" opacity="0.7"/>
    <line x1="508" y1="144" x2="560" y2="196" stroke="#38bdf8" stroke-dasharray="3 3" opacity="0.7"/>
    <rect x="560" y="24" width="180" height="72" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="650" y="52" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="13">human wall</text>
    <text x="650" y="72" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">overview → file:line</text>
    <rect x="560" y="112" width="180" height="56" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="650" y="136" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">ranked worklist</text>
    <text x="650" y="154" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">always beside the picture</text>
    <rect x="560" y="184" width="180" height="56" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="650" y="208" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">agent queries</text>
    <text x="650" y="226" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">blast_radius · find_similar</text>
    <rect x="760" y="88" width="184" height="80" rx="8" fill="#1a0e0a" stroke="#D55E00" stroke-width="1.5"/>
    <text x="852" y="120" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">LLM labels only</text>
    <text x="852" y="140" text-anchor="middle" fill="#D55E00" font-family="JetBrains Mono, monospace" font-size="10">never invents edges</text>
    <text x="16" y="260" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="11">Also in: patterns.ts, surface.ts, exposure.ts, comments.ts (essay_blocks, not comment_pct), knip, dependency-cruiser. Also out: npm package named cgraph — different product.</text>
  </svg>
  <figcaption><b>Figure 3.</b> Extractors on the left are amber (concept A, measurement). The store is the blue hand-off. Human wall and agent queries are lime (concept B, the product). The LLM box is vermillion on purpose: caption, never edges.</figcaption>
</figure>

```text
# map (approximate; CGraph not installed on this worker)
cgraph-mcp --root . --daemon
# then MCP: graph_status, graph_query, graph_impact, graph_path, graph_context

# package grain the refactor skill already owns
bun plugins/code/skills/refactor/modules.ts   <run-dir>
bun plugins/code/skills/refactor/exposure.ts  <run-dir>
bun plugins/code/skills/refactor/surface.ts   <run-dir> --exports
bun plugins/code/skills/refactor/patterns.ts  <run-dir>
bun plugins/code/skills/refactor/comments.ts  <run-dir>   # essay_blocks, not a target

# clones / unused / rules
jscpd cli/src --format json
knip --reporter json
depcruise cli/src --config .dependency-cruiser.cjs --output-type json
```

Every human view has a query twin. Token budget is ego + worklist, never the city.

| View | Agent query |
| --- | --- |
| V02 DSM | `illegal_edges()` · `module_matrix(grain=package)` |
| V03 cycles | `sccs(min=2)` · `tear_edge(scc_id)` |
| V04 dual trees | `find_similar(span) → {canonical, bucket, safe_to_extract}` |
| V06 types | `refs(symbol, prodOnly=true)` · `unused_exports()` |
| V07 butterfly | `graph_impact(symbol, hops=2, exclude=test)` |
| V10 hotspot | `hotspots(window=90d, top=10)` |
| V13 overlay | `forbidden_would_add(from, to)` before writing an import |
| V15 traffic | `collisions()` · `agent_touches(path, days=7)` |

## Do not build

| Failure | Why it fails here | Ancestor |
| --- | --- | --- |
| Comment-ratio dashboard | `comments.ts` already says `comment_pct` is a map of mislocated essays, not a target | Understand / SourceMonitor |
| Repo cyclomatic score | McCabe is a procedure testability number. Averaging it across 322k LOC is trivia | Sonar Cognitive Complexity as a gate |
| 3D city / CodeCity | Occlusion, layout jitter, third dimension spent on a metric color already carries | Wettel/Lanza 2007; keep as a conference demo |
| Force-directed import hairball | Not a coordinate system. Unreadable past ~150 nodes with degree &gt; 3 | `madge .` / Gephi ForceAtlas2 / Graphviz `fdp` |
| Health pie / letter grade | Orthogonal failures compressed until they can be gamed | Sonar Maintainability Rating |
| Gource as analysis | Animation cannot compare frame 12 to frame 40 | Caudwell 2010 — trailer, not instrument |
| Repo-wide UML | Reverse-engineered 873-file class diagram is unread wallpaper | Enterprise Architect “generate UML” |
| Voronoi treemap as daily tool | Beautiful, labels fight cells, layout unstable | Balzer et al. 2005 — poster only |

<figure class="artifact-figure artifact-figure-diagram">
  <svg viewBox="0 0 440 120" role="img" aria-label="A crossed-out health pie next to a crossed-out 3D city silhouette and a hairball, labeled do not build">
    <circle cx="70" cy="60" r="36" fill="none" stroke="#555" stroke-width="16"/>
    <path d="M70 24 A36 36 0 0 1 102 78" fill="none" stroke="#333" stroke-width="16"/>
    <line x1="28" y1="24" x2="112" y2="96" stroke="#f87171" stroke-width="3"/>
    <text x="70" y="114" text-anchor="middle" fill="#f87171" font-family="JetBrains Mono, monospace" font-size="9">health pie</text>
    <rect x="160" y="28" width="24" height="48" fill="#333"/>
    <rect x="190" y="40" width="20" height="36" fill="#444"/>
    <rect x="216" y="20" width="28" height="56" fill="#555"/>
    <line x1="150" y1="18" x2="254" y2="90" stroke="#f87171" stroke-width="3"/>
    <text x="202" y="114" text-anchor="middle" fill="#f87171" font-family="JetBrains Mono, monospace" font-size="9">city</text>
    <circle cx="330" cy="48" r="6" fill="#444"/>
    <circle cx="360" cy="40" r="6" fill="#444"/>
    <circle cx="350" cy="70" r="6" fill="#444"/>
    <circle cx="310" cy="68" r="6" fill="#444"/>
    <circle cx="380" cy="64" r="6" fill="#444"/>
    <line x1="330" y1="48" x2="360" y2="40" stroke="#555"/>
    <line x1="330" y1="48" x2="350" y2="70" stroke="#555"/>
    <line x1="330" y1="48" x2="310" y2="68" stroke="#555"/>
    <line x1="360" y1="40" x2="380" y2="64" stroke="#555"/>
    <line x1="350" y1="70" x2="380" y2="64" stroke="#555"/>
    <line x1="286" y1="22" x2="400" y2="90" stroke="#f87171" stroke-width="3"/>
    <text x="340" y="114" text-anchor="middle" fill="#f87171" font-family="JetBrains Mono, monospace" font-size="9">hairball</text>
  </svg>
  <figcaption>Anti-patterns. If a prototype starts here, stop. The v1 kit already answers the question with encodings that survived 40 years of this literature.</figcaption>
</figure>

## Raw records

| Claim | Record | Window |
| --- | --- | --- |
| 873 source files, 322,363 LOC, 1,003 tests / 230,179 LOC | `git ls-files 'cli/src/**/*.ts'` + `wc -l`, this checkout `cursor/codebase-health-viz-248c` at `ed99e4a2f` | 2026-09-06 |
| Top files 6392 / 5885 / 5188 / 4142 | same `wc -l` on `commands/sessions.ts`, `lib/session/discover.ts`, `lib/session/db.ts`, `lib/accounting/usage.ts` | 2026-09-06 |
| `cli/src/lib/session` 79 source files | path-prefix count of that list | 2026-09-06 |
| 2,214 files · 586,097 LOC · 47 files &gt; 1500 · 125 families · 16 bypassed / 42 missing contracts · 2,347 collapsible arms | `.agents/artifacts/2026-08-17/refactor-100723/metrics-summary.json` repo `agents-cli` | 2026-08-17 |
| 44 modules, 196 edges, 1 cycle of 38, `lib` 193 / 88,644 / fan-in 1095, `lib/terminal` 17 / 1,636 inside the cycle | `phnx-labs/.agents` `plugins/code/skills/refactor/reference-figure.md` | 2026-08-12 |
| `comment_pct` is a map, signal is `essay_blocks` ≥ 15 lines | `plugins/code/skills/refactor/comments.ts` header comment | skill as cloned 2026-09-06 |
| CGraph node/edge kinds and MCP tools | [Nxtsoft/CGraph](https://github.com/Nxtsoft/CGraph) README; fleet argv in `cli/src/lib/tmux/orphan-reap.ts` | 2026-09-06 |
| Historical encodings (SeeSoft, DSM, treemap, Holten, flame, hotspot, truck factor, SCIP) | survey committed beside this file: `.agents/artifacts/2026-09-06/survey-software-quality-visualization.md` | compiled 2026-09-06 |

`modules.ts` was not re-run in this session. Do not quote the 44-module / 38-cycle counts as today’s graph.
