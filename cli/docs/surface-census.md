---
kind: report
title: agents CLI Surface Census
summary: What is actually in the 324K-line CLI, which of its 75 command groups agents really use, and what should stay, merge, move out, or go.
header: Phoenix Labs / Engineering
project: agents-cli
repository: phnx-labs/agi-cli
status: draft
harness: claude
agent: claude-fable-5-1
date: "2026-09-06"
facts:
  - 324,510 source lines + 246,527 test lines in cli/
  - 75 top-level nouns, 553 visible commands, 38 hidden
  - 10,173 transcripts measured; 1,961 invoke the CLI
links: []
---

## Summary

<section class="artifact-grid artifact-grid-3">
  <article class="artifact-stat"><div class="artifact-stat-value">571K</div><div class="artifact-stat-label">lines in cli/src and cli/tests: 324,510 source, 246,527 test</div></article>
  <article class="artifact-stat"><div class="artifact-stat-value">75</div><div class="artifact-stat-label">top-level nouns, 553 visible commands, 38 more hidden</div></article>
  <article class="artifact-stat"><div class="artifact-stat-value">14</div><div class="artifact-stat-label">nouns carry 100+ sessions; 32 nouns sit under 10; 14 were never invoked</div></article>
</section>

The codebase is not 200K lines. It is 324K lines of source and 247K of tests, behind 75 top-level nouns and 553 visible commands. Real usage across 10,173 transcripts on one fleet workstation is concentrated in 14 nouns. The surface has already had one consolidation pass (31 nouns retired since 2026-08-12), so the remaining size is mostly not dead commands. It is a small number of very large subsystems, several of which have their own product identity and can leave the package.

<div class="artifact-callout">
<strong>The takeaway.</strong> Cutting unreachable code removes far less than first reported — a reference check on 2026-09-06 (see the corrected Step 1 below) found the original ~11K cut list was mostly <em>relocated-but-live</em> code, leaving only ~1–2K of genuinely dead deprecated-alias registrations. Extracting six self-contained subsystems removes about 44K (13%). The other ~250K is the product. It becomes reviewable by splitting it into packages with one-way imports, starting with the 51K-line <code>sessions</code> subsystem, not by deleting features. The real leverage is Step 2 (fold) and Step 3 (extract), which reorganize live code rather than delete it.
</div>

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg class="artifact-diagram" viewBox="0 0 960 760" role="img" aria-label="Non-test lines versus distinct sessions using each subsystem, colored by verdict">
<text x="330" y="22" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Non-test lines in cli/src</text>
<text x="706" y="22" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Sessions that invoke it</text>
<text x="330" y="38" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">command modules + owning lib, 324,510 total</text>
<text x="706" y="38" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">of 1,961 CLI-using transcripts, 2026-09-06</text>
<line x1="330" y1="50" x2="330" y2="720" stroke="#333333" stroke-width="1"/>
<line x1="706" y1="50" x2="706" y2="720" stroke="#333333" stroke-width="1"/>
<text x="320" y="69" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">sessions</text>
<rect x="330" y="59" width="300" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="636" y="69" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">50,757</text>
<rect x="706" y="59" width="175" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="887" y="69" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">653</text>
<text x="320" y="89" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">resources (rules, hooks, mcp, plugins, ...)</text>
<rect x="330" y="79" width="163" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="499" y="89" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">27,510</text>
<rect x="706" y="79" width="7" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="719" y="89" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">26</text>
<text x="320" y="109" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#38bdf8">devices + ssh + hosts + fleet</text>
<rect x="330" y="99" width="130" height="14" rx="2" fill="#38bdf8" opacity="0.85"/>
<text x="466" y="109" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">22,018</text>
<rect x="706" y="99" width="116" height="14" rx="2" fill="#38bdf8" opacity="0.85"/>
<text x="828" y="109" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">432</text>
<text x="320" y="129" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">versions (add, use, update, prune, ...)</text>
<rect x="330" y="119" width="128" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="464" y="129" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">21,600</text>
<rect x="706" y="119" width="4" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="716" y="129" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">14</text>
<text x="320" y="149" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#c084fc">browser</text>
<rect x="330" y="139" width="106" height="14" rx="2" fill="#c084fc" opacity="0.85"/>
<text x="442" y="149" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">18,016</text>
<rect x="706" y="139" width="154" height="14" rx="2" fill="#c084fc" opacity="0.85"/>
<text x="866" y="149" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">576</text>
<text x="320" y="169" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">secrets</text>
<rect x="330" y="159" width="99" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="435" y="169" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">16,746</text>
<rect x="706" y="159" width="194" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="906" y="169" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">725</text>
<text x="320" y="189" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#38bdf8">reconcile (sync, doctor, inspect)</text>
<rect x="330" y="179" width="84" height="14" rx="2" fill="#38bdf8" opacity="0.85"/>
<text x="420" y="189" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">14,212</text>
<rect x="706" y="179" width="27" height="14" rx="2" fill="#38bdf8" opacity="0.85"/>
<text x="739" y="189" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">102</text>
<text x="320" y="209" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">teams</text>
<rect x="330" y="199" width="78" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="414" y="209" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">13,120</text>
<rect x="706" y="199" width="52" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="764" y="209" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">195</text>
<text x="320" y="229" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">accounts + auth</text>
<rect x="330" y="219" width="77" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="413" y="229" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">13,076</text>
<rect x="706" y="219" width="11" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="723" y="229" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">40</text>
<text x="320" y="249" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">daemon</text>
<rect x="330" y="239" width="61" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="397" y="249" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">10,390</text>
<rect x="706" y="239" width="16" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="728" y="249" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">59</text>
<text x="320" y="269" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">run / exec</text>
<rect x="330" y="259" width="58" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="394" y="269" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">9,854</text>
<rect x="706" y="259" width="75" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="787" y="269" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">281</text>
<text x="320" y="289" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">routines + webhooks</text>
<rect x="330" y="279" width="55" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="391" y="289" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">9,357</text>
<rect x="706" y="279" width="34" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="746" y="289" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">128</text>
<text x="320" y="309" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">feed</text>
<rect x="330" y="299" width="51" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="387" y="309" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">8,688</text>
<rect x="706" y="299" width="103" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="815" y="309" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">386</text>
<text x="320" y="329" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#c084fc">share / artifacts</text>
<rect x="330" y="319" width="43" height="14" rx="2" fill="#c084fc" opacity="0.85"/>
<text x="379" y="329" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">7,312</text>
<rect x="706" y="319" width="39" height="14" rx="2" fill="#c084fc" opacity="0.85"/>
<text x="751" y="329" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">145</text>
<text x="320" y="349" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#38bdf8">harness cluster (harness, route, models, modes)</text>
<rect x="330" y="339" width="40" height="14" rx="2" fill="#38bdf8" opacity="0.85"/>
<text x="376" y="349" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">6,835</text>
<rect x="706" y="339" width="2" height="14" rx="2" fill="#38bdf8" opacity="0.85"/>
<text x="714" y="349" font-family="JetBrains Mono, monospace" font-size="10" fill="#f59e0b">9</text>
<text x="320" y="369" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#c084fc">projects + linear</text>
<rect x="330" y="359" width="36" height="14" rx="2" fill="#c084fc" opacity="0.85"/>
<text x="372" y="369" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">6,037</text>
<rect x="706" y="359" width="3" height="14" rx="2" fill="#c084fc" opacity="0.85"/>
<text x="715" y="369" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">12</text>
<text x="320" y="389" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#c084fc">terminal engine (pty, tmux)</text>
<rect x="330" y="379" width="35" height="14" rx="2" fill="#c084fc" opacity="0.85"/>
<text x="371" y="389" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">5,947</text>
<rect x="706" y="379" width="10" height="14" rx="2" fill="#c084fc" opacity="0.85"/>
<text x="722" y="389" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">39</text>
<text x="320" y="409" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#c084fc">traces (Phoenix sync)</text>
<rect x="330" y="399" width="31" height="14" rx="2" fill="#c084fc" opacity="0.85"/>
<text x="367" y="409" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">5,329</text>
<rect x="706" y="399" width="2" height="14" rx="2" fill="#c084fc" opacity="0.85"/>
<text x="714" y="409" font-family="JetBrains Mono, monospace" font-size="10" fill="#f59e0b">3</text>
<text x="320" y="429" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#c084fc">computer</text>
<rect x="330" y="419" width="30" height="14" rx="2" fill="#c084fc" opacity="0.85"/>
<text x="366" y="429" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">5,143</text>
<rect x="706" y="419" width="18" height="14" rx="2" fill="#c084fc" opacity="0.85"/>
<text x="730" y="429" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">68</text>
<text x="320" y="449" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">insights + analytics + perf</text>
<rect x="330" y="439" width="25" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="361" y="449" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">4,231</text>
<rect x="706" y="439" width="3" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="715" y="449" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">13</text>
<text x="320" y="469" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">cloud + factory</text>
<rect x="330" y="459" width="24" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="360" y="469" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">4,114</text>
<rect x="706" y="459" width="13" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="725" y="469" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">48</text>
<text x="320" y="489" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#38bdf8">comms (message, send, notify, mailboxes, humans)</text>
<rect x="330" y="479" width="22" height="14" rx="2" fill="#38bdf8" opacity="0.85"/>
<text x="358" y="489" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">3,805</text>
<rect x="706" y="479" width="9" height="14" rx="2" fill="#38bdf8" opacity="0.85"/>
<text x="721" y="489" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">34</text>
<text x="320" y="509" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">monitors</text>
<rect x="330" y="499" width="21" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="357" y="509" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">3,621</text>
<rect x="706" y="499" width="33" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="745" y="509" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">124</text>
<text x="320" y="529" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">watchdog</text>
<rect x="330" y="519" width="18" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="354" y="529" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">3,004</text>
<rect x="706" y="519" width="3" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="715" y="529" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">10</text>
<text x="320" y="549" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">view</text>
<rect x="330" y="539" width="16" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="352" y="549" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">2,727</text>
<rect x="706" y="539" width="32" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="744" y="549" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">121</text>
<text x="320" y="569" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">config + budget</text>
<rect x="330" y="559" width="16" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="352" y="569" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">2,679</text>
<rect x="706" y="559" width="11" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="723" y="569" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">40</text>
<text x="320" y="589" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">upgrade + uninstall + import</text>
<rect x="330" y="579" width="13" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="349" y="589" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">2,124</text>
<rect x="706" y="579" width="5" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="717" y="589" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">17</text>
<text x="320" y="609" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">crabbox (lib, live)</text>
<rect x="330" y="599" width="12" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="348" y="609" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">2,088</text>
<text x="712" y="609" font-family="JetBrains Mono, monospace" font-size="10" fill="#f59e0b">0</text>
<text x="320" y="629" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">menubar</text>
<rect x="330" y="619" width="12" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="348" y="629" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">2,056</text>
<rect x="706" y="619" width="3" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="715" y="629" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">11</text>
<text x="320" y="649" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">packages / registry / search</text>
<rect x="330" y="639" width="12" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="348" y="649" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">2,011</text>
<text x="712" y="649" font-family="JetBrains Mono, monospace" font-size="10" fill="#f59e0b">0</text>
<text x="320" y="669" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#38bdf8">events + logs</text>
<rect x="330" y="659" width="10" height="14" rx="2" fill="#38bdf8" opacity="0.85"/>
<text x="346" y="669" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">1,684</text>
<rect x="706" y="659" width="3" height="14" rx="2" fill="#38bdf8" opacity="0.85"/>
<text x="715" y="669" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">12</text>
<text x="320" y="689" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">setup</text>
<rect x="330" y="679" width="10" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="346" y="689" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">1,635</text>
<rect x="706" y="679" width="37" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="749" y="689" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">137</text>
<text x="320" y="709" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">aliases + acp + tombstones (mostly live)</text>
<rect x="330" y="699" width="5" height="14" rx="2" fill="#a3e635" opacity="0.85"/>
<text x="341" y="709" font-family="JetBrains Mono, monospace" font-size="10" fill="#c8c8c8">780</text>
<text x="712" y="709" font-family="JetBrains Mono, monospace" font-size="10" fill="#f59e0b">0</text>
<rect x="330" y="733" width="12" height="12" rx="2" fill="#a3e635"/>
<text x="347" y="743" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">keep</text>
<rect x="397.4" y="733" width="12" height="12" rx="2" fill="#38bdf8"/>
<text x="414.4" y="743" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">merge concepts</text>
<rect x="530.8" y="733" width="12" height="12" rx="2" fill="#c084fc"/>
<text x="547.8" y="743" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">extract to its own package</text>
<rect x="743.4" y="733" width="12" height="12" rx="2" fill="#f59e0b"/>
<text x="760.4" y="743" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">cut</text>
</svg>
<figcaption>Left: non-test lines per subsystem (command modules plus owning lib). Right: distinct sessions that invoke the subsystem's primary noun. Amber <em>numbers</em> are under 10 sessions. Verdict by bar/label color. <strong>Verdict colors revised 2026-09-06</strong> after a per-row reference check (see §1): the four bars first colored amber ("cut") — insights, crabbox, packages/registry/search, and the alias cluster — are live code, so no subsystem is a clean cut; the only confirmed-cut surface is ~1–2K lines of deprecated top-level alias registrations, which do not form a bar of their own. Source: <code>git ls-files</code> + <code>wc -l</code> on cli/src at commit 1486bfeea; transcripts under ~/.agents/.history as of 2026-09-06.</figcaption>
</figure>

## Findings

**1. The size is in a few subsystems, not in many commands.** Five subsystems hold 42% of the source: sessions (50,757), resources (27,510), devices/ssh/hosts/fleet (22,018), versions/installations (21,600), and browser (18,016). The 33 nouns under 3K lines each add up to about 25K combined. Removing every one of them would not change how the codebase feels.

**2. Usage follows a cliff.** Of 1,961 sessions that call the CLI at all, 37% use `secrets`, 33% `sessions`, 29% `browser`, 22% `ssh`, 20% `feed`, 14% `run`. Then it drops: 14 nouns above 100 sessions, 29 between 10 and 99, and 32 below 10. Fourteen registered nouns were never invoked once: `budget`, `feedback`, `fork`, `humans`, `jobs`, `mine`, `packages`, `perms`, `reconnect`, `reminders`, `search`, `snapshot`, `uninstall`, `utils`. But **zero direct invocations is not the same as dead** (verified 2026-09-06): `packages` is reached through `packages materialize` and the `install` alias, `reminders` is a live command whose statusline feature has no separate noun, and `uninstall`/hidden aliases are correct at zero by design. Genuinely removable at zero are the deprecated top-level aliases (`feedback`, `fork`, `reconnect`) — the confirmed-cut set §1 names.

**3. `sessions` is a monolith.** 15,313 lines of command modules plus 35,444 in `lib/session/` (35,793 with its three bench files) sit behind one noun with 24 leaves. That is 16% of the source, and it was also the most-changed noun in the last 90 days (69 commits, 20 tickets) with a 172-line doc. Nothing else is close. Any human review of the CLI starts and stalls here.

**3a. Dead code inside the sessions monolith is small; the debt is surface and duplication.** Measured over the 106 files in scope (51,424 lines, including the bench files and the deprecated command shims) with an import graph and an identifier index, since neither `knip` nor `ts-prune` is installed:

| Category | Lines | Evidence |
|---|---:|---|
| Unreachable managed-sessions provisioner | 938 | `lib/session/sync/provision.ts` has zero importers and is the only importer of `sync/worker-template.ts`; its documented caller `commands/sync-provision.ts` no longer exists |
| Deprecated verbs past their stated one-release window | 252 | `attach.ts`, `reconnect.ts`, the `go` registration, and the top-level `fork` alias, the first three hidden since 1.22.37 "for one release" and the `fork` alias since 1.22.23; the CLI is at 1.22.82 |
| Exports with zero references anywhere | 74 | 9 of 819 exports, two of them `*ForTest` helpers that no test calls |
| Test-only hooks in product files | 174 | 30 `__reset*ForTest`-style exports |
| Migration-only code | 1,204 | the 47-step `migrateSchema` ladder in `db.ts` (809 lines) over a rebuildable derived cache, the pre-SQLite index cleanup that can only be a no-op now, and `sessions backfill` |

That is about 2,200 to 2,600 lines, 4 to 5% of the subsystem. Only 2 of 106 files have no importer, and `go.ts`, the file labeled deprecated, is 462 lines of reach engine that `focus.ts` imports. What the measurement did find is exposure and duplication: 330 of 819 exports (40%) have no consumer outside their own file; three fleet session resolvers and five document renderers coexist; ten helper pairs are duplicated across files, three byte-identical and three (`formatDuration`, `lineCount`, `clipLabel`) returning different answers for the same input. That is the case for splitting the subsystem into packages with explicit exports, not for a deletion pass.

**4. One concept, three lib namespaces.** The fleet fabric is `lib/devices/` (7,658), `lib/hosts/` (5,314), and `lib/fleet/` (2,131), plus `ssh-exec`, `device-config`, and four `fleet-*.ts` files: 17,740 lines. No command is named `hosts`. The `ssh` and `devices` nouns share one 3,022-line module.

**5. Nine ways to say "make it current".** `sync`, `sync status`, `devices apply`, `devices sync`, `devices snapshot`, `devices status`, `doctor`, `inspect`, `repos sync`, plus hidden `memory sync`, `plugins sync`, and `refresh-rules`. The description of `devices snapshot` disambiguates itself against `sync status` in its own help text. The reconcile cluster is 14,212 lines across sync, doctor, and inspect.

**6. Duplicate tokens that survived the first consolidation.**

| Cluster | Tokens today | Evidence |
|---|---|---|
| Trajectory | `trace`, `sessions trace`, `traces` | `trace` and `sessions trace` have byte-identical descriptions and load the same module. `traces` is an unrelated Phoenix sync with a near-identical name. |
| Insights | `insights`, `sessions insights` | byte-identical descriptions |
| Logs | `logs`, `events` | `logs audit` is documented as "Alias for `agents events --audit`"; `logs` is a 336-line shim |
| Comms | `message`, `send`, `notify`, `mailboxes`, `humans`, `feed post` | `notify` labels itself `[DEPRECATED]` and is still a top-level group; `mailboxes` has one verb (`prune`); `humans` has one verb (`show owner`) |
| Update | `update`, `upgrade`, `devices update`, `plugins update` | four meanings; `upgrade` is a 17-line module |
| Prune | top-level `prune` = uninstall a version; every nested `prune` = garbage-collect | eight nested `prune` verbs |
| Soft delete | `trash`, `restore`, `prune` | `trash restore` was deleted as a duplicate, leaving `trash` with `list` and a description that still promises restore |
| Webhooks | `webhooks serve`, `daemon webhooks`, `routines webhook`, `daemon funnel` | four homes for one receiver |
| Harness | `harness`, `route`, `models`, `modes`, `clis` | 5 groups, 22 subcommands, 6,835 lines; `models tier` already deprecated in favor of `config set` |
| Cloud | `cloud`, `factory` | `cloud`'s own provider list includes Factory; `factory` is a beta-gated second door |

**7. Shape problems.** 27 of 68 visible groups have one or zero subcommands. 32 of 68 groups ship on Commander's default help rather than a workflow-first `setHelpSections` block, including two of the busiest nouns, `view` and `feed`, and most of the resource family. `cli/src/commands/utils.ts` (377 lines) is not a command; 55 command modules import it.

**8. Subsystems with their own product identity.** Six pieces have a separate release cadence, a sibling CLI, or a different customer, and none of them needs the CLI's internals beyond a narrow seam:

| Subsystem | Lines | Why it can leave |
|---|---|---|
| browser page driver (`lib/browser/`) | ~14,000 | generic CDP driver; only fleet routing, consent, and secrets injection are CLI-specific |
| share worker (`lib/share/`, `commands/share.ts`) | 7,312 | a Cloudflare Worker template and publisher; `worker-template.ts` had 39 commits in the 12 days since the move, the most-churned file in the repo; the standalone `artifacts` CLI already owns `share` |
| projects + linear (`lib/project-*`, `lib/linear-*`) | 6,037 | 12 sessions in 10K; the `linear` CLI is installed and `agents tickets` was already retired in its favor |
| terminal engine (`lib/tmux/`, `lib/terminal/`, pty) | 5,947 | internal infrastructure behind `sessions inject` and `resume`; no agent-facing reason to be a top-level surface |
| traces (`lib/traces/`) | 5,329 | the evals capture client; 3 sessions today, but it is the capture seam for evals and deserves its own package and tests |
| computer (`lib/computer/`) | 5,143 + 4,600 native | thin RPC to helpers that already release on their own tags; the embedded `computer run --task` model loop is a second agent runtime |

**9. Browser and computer, specifically.** The earlier question was whether they earn their place. Browser does: 576 sessions, 29% of CLI-using sessions, 8,903 calls, against 111 sessions that hand-rolled Playwright or osascript, 82 of which also used the built-in. What agents cannot write per session is the fleet layer: a profile name resolving to the machine that holds the logins, a consent gate enforced in the daemon under all 18 implicit-attach verbs, and secret typing that never hits the transcript. Computer is weaker: 68 sessions, and osascript rivals it at 53. Its irreplaceable part is the signed helper with a stable TCC identity and a default-deny allowlist, which already lives outside the CLI.

**10. Tests are 43% of the tree.** 233,963 lines of `*.test.ts` plus 12,564 in `cli/tests/`, at 0.76 test lines per source line. The repo's own rule says to delete implementation-detail and constant-guard tests. That rule has not been applied at scale.

## Evidence

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg class="artifact-diagram" viewBox="0 0 960 300" role="img" aria-label="Distinct sessions per top-level command, all 75 canonical nouns sorted descending">
<text x="50" y="18" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Distinct sessions per top-level noun, all 75 canonical nouns, sorted (of 1,961 CLI-using sessions)</text>
<line x1="50" y1="230.0" x2="940" y2="230.0" stroke="#333333" stroke-width="1"/>
<text x="44" y="234.0" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">0</text>
<line x1="50" y1="177.6" x2="940" y2="177.6" stroke="#333333" stroke-width="1"/>
<text x="44" y="181.6" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">200</text>
<line x1="50" y1="125.2" x2="940" y2="125.2" stroke="#333333" stroke-width="1"/>
<text x="44" y="129.2" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">400</text>
<line x1="50" y1="72.8" x2="940" y2="72.8" stroke="#333333" stroke-width="1"/>
<text x="44" y="76.8" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">600</text>
<rect x="51.0" y="40.0" width="9.9" height="190.0" fill="#a3e635" opacity="0.9"/>
<text transform="translate(58.9 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#a3e635">secrets</text>
<rect x="62.9" y="58.9" width="9.9" height="171.1" fill="#a3e635" opacity="0.9"/>
<text transform="translate(70.8 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#a3e635">sessions</text>
<rect x="74.7" y="79.0" width="9.9" height="151.0" fill="#a3e635" opacity="0.9"/>
<text transform="translate(82.7 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#a3e635">browser</text>
<rect x="86.6" y="116.8" width="9.9" height="113.2" fill="#a3e635" opacity="0.9"/>
<text transform="translate(94.5 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#a3e635">ssh</text>
<rect x="98.5" y="128.8" width="9.9" height="101.2" fill="#a3e635" opacity="0.9"/>
<text transform="translate(106.4 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#a3e635">feed</text>
<rect x="110.3" y="156.4" width="9.9" height="73.6" fill="#a3e635" opacity="0.9"/>
<text transform="translate(118.3 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#a3e635">run</text>
<rect x="122.2" y="172.3" width="9.9" height="57.7" fill="#a3e635" opacity="0.9"/>
<text transform="translate(130.1 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#a3e635">devices</text>
<rect x="134.1" y="178.9" width="9.9" height="51.1" fill="#a3e635" opacity="0.9"/>
<text transform="translate(142.0 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#a3e635">teams</text>
<rect x="145.9" y="192.0" width="9.9" height="38.0" fill="#a3e635" opacity="0.9"/>
<text transform="translate(153.9 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#a3e635">artifacts</text>
<rect x="157.8" y="194.1" width="9.9" height="35.9" fill="#a3e635" opacity="0.9"/>
<text transform="translate(165.7 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#a3e635">setup</text>
<rect x="169.7" y="196.5" width="9.9" height="33.5" fill="#a3e635" opacity="0.9"/>
<text transform="translate(177.6 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#a3e635">routines</text>
<rect x="181.5" y="197.5" width="9.9" height="32.5" fill="#a3e635" opacity="0.9"/>
<text transform="translate(189.5 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#a3e635">monitors</text>
<rect x="193.4" y="198.3" width="9.9" height="31.7" fill="#a3e635" opacity="0.9"/>
<text transform="translate(201.3 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#a3e635">view</text>
<rect x="205.3" y="203.3" width="9.9" height="26.7" fill="#a3e635" opacity="0.9"/>
<text transform="translate(213.2 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#a3e635">doctor</text>
<rect x="217.1" y="204.1" width="9.9" height="25.9" fill="#38bdf8" opacity="0.9"/>
<rect x="229.0" y="212.2" width="9.9" height="17.8" fill="#38bdf8" opacity="0.9"/>
<rect x="240.9" y="212.4" width="9.9" height="17.6" fill="#38bdf8" opacity="0.9"/>
<rect x="252.7" y="214.5" width="9.9" height="15.5" fill="#38bdf8" opacity="0.9"/>
<rect x="264.6" y="217.4" width="9.9" height="12.6" fill="#38bdf8" opacity="0.9"/>
<rect x="276.5" y="217.4" width="9.9" height="12.6" fill="#38bdf8" opacity="0.9"/>
<rect x="288.3" y="219.5" width="9.9" height="10.5" fill="#38bdf8" opacity="0.9"/>
<rect x="300.2" y="219.5" width="9.9" height="10.5" fill="#38bdf8" opacity="0.9"/>
<rect x="312.1" y="219.5" width="9.9" height="10.5" fill="#38bdf8" opacity="0.9"/>
<rect x="323.9" y="219.8" width="9.9" height="10.2" fill="#38bdf8" opacity="0.9"/>
<rect x="335.8" y="221.1" width="9.9" height="8.9" fill="#38bdf8" opacity="0.9"/>
<rect x="347.7" y="221.6" width="9.9" height="8.4" fill="#38bdf8" opacity="0.9"/>
<rect x="359.5" y="222.4" width="9.9" height="7.6" fill="#38bdf8" opacity="0.9"/>
<rect x="371.4" y="223.2" width="9.9" height="6.8" fill="#38bdf8" opacity="0.9"/>
<rect x="383.3" y="223.2" width="9.9" height="6.8" fill="#38bdf8" opacity="0.9"/>
<rect x="395.1" y="224.8" width="9.9" height="5.2" fill="#38bdf8" opacity="0.9"/>
<rect x="407.0" y="225.5" width="9.9" height="4.5" fill="#38bdf8" opacity="0.9"/>
<rect x="418.9" y="226.1" width="9.9" height="3.9" fill="#38bdf8" opacity="0.9"/>
<rect x="430.7" y="226.1" width="9.9" height="3.9" fill="#38bdf8" opacity="0.9"/>
<rect x="442.6" y="226.1" width="9.9" height="3.9" fill="#38bdf8" opacity="0.9"/>
<rect x="454.5" y="226.3" width="9.9" height="3.7" fill="#38bdf8" opacity="0.9"/>
<rect x="466.3" y="226.6" width="9.9" height="3.4" fill="#38bdf8" opacity="0.9"/>
<rect x="478.2" y="226.9" width="9.9" height="3.1" fill="#38bdf8" opacity="0.9"/>
<rect x="490.1" y="226.9" width="9.9" height="3.1" fill="#38bdf8" opacity="0.9"/>
<rect x="501.9" y="226.9" width="9.9" height="3.1" fill="#38bdf8" opacity="0.9"/>
<rect x="513.8" y="227.1" width="9.9" height="2.9" fill="#38bdf8" opacity="0.9"/>
<rect x="525.7" y="227.1" width="9.9" height="2.9" fill="#38bdf8" opacity="0.9"/>
<rect x="537.5" y="227.4" width="9.9" height="2.6" fill="#38bdf8" opacity="0.9"/>
<rect x="549.4" y="227.4" width="9.9" height="2.6" fill="#38bdf8" opacity="0.9"/>
<rect x="561.3" y="227.6" width="9.9" height="2.4" fill="#f59e0b" opacity="0.9"/>
<rect x="573.1" y="228.2" width="9.9" height="1.8" fill="#f59e0b" opacity="0.9"/>
<rect x="585.0" y="228.2" width="9.9" height="1.8" fill="#f59e0b" opacity="0.9"/>
<text transform="translate(592.9 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#f59e0b">send</text>
<rect x="596.9" y="228.4" width="9.9" height="1.6" fill="#f59e0b" opacity="0.9"/>
<rect x="608.7" y="228.4" width="9.9" height="1.6" fill="#f59e0b" opacity="0.9"/>
<rect x="620.6" y="228.4" width="9.9" height="1.6" fill="#f59e0b" opacity="0.9"/>
<text transform="translate(628.5 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#f59e0b">update</text>
<rect x="632.5" y="228.5" width="9.9" height="1.5" fill="#f59e0b" opacity="0.9"/>
<rect x="644.3" y="228.5" width="9.9" height="1.5" fill="#f59e0b" opacity="0.9"/>
<rect x="656.2" y="228.5" width="9.9" height="1.5" fill="#f59e0b" opacity="0.9"/>
<text transform="translate(664.1 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#f59e0b">commands</text>
<rect x="668.1" y="228.5" width="9.9" height="1.5" fill="#f59e0b" opacity="0.9"/>
<rect x="679.9" y="228.5" width="9.9" height="1.5" fill="#f59e0b" opacity="0.9"/>
<rect x="691.8" y="228.5" width="9.9" height="1.5" fill="#f59e0b" opacity="0.9"/>
<text transform="translate(699.7 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#f59e0b">import</text>
<rect x="703.7" y="228.5" width="9.9" height="1.5" fill="#f59e0b" opacity="0.9"/>
<rect x="715.5" y="228.5" width="9.9" height="1.5" fill="#f59e0b" opacity="0.9"/>
<rect x="727.4" y="228.5" width="9.9" height="1.5" fill="#f59e0b" opacity="0.9"/>
<text transform="translate(735.3 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#f59e0b">traces</text>
<rect x="739.3" y="228.5" width="9.9" height="1.5" fill="#f59e0b" opacity="0.9"/>
<rect x="751.1" y="228.5" width="9.9" height="1.5" fill="#f59e0b" opacity="0.9"/>
<rect x="763.0" y="228.5" width="9.9" height="1.5" fill="#f59e0b" opacity="0.9"/>
<text transform="translate(770.9 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#f59e0b">trace</text>
<rect x="774.9" y="228.5" width="9.9" height="1.5" fill="#f59e0b" opacity="0.9"/>
<rect x="786.7" y="228.5" width="9.9" height="1.5" fill="#f59e0b" opacity="0.9"/>
<rect x="798.6" y="228.5" width="9.9" height="1.5" fill="#f59e0b" opacity="0.9"/>
<text transform="translate(806.5 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#f59e0b">registry</text>
<rect x="810.5" y="228.5" width="9.9" height="1.5" fill="#f59e0b" opacity="0.9"/>
<rect x="822.3" y="228.5" width="9.9" height="1.5" fill="#f59e0b" opacity="0.9"/>
<text transform="translate(842.1 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#f59e0b">feedback</text>
<text transform="translate(865.9 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#f59e0b">humans</text>
<text transform="translate(877.7 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#f59e0b">packages</text>
<text transform="translate(889.6 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#f59e0b">reconnect</text>
<text transform="translate(913.3 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#f59e0b">search</text>
<text transform="translate(937.1 236) rotate(60)" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#f59e0b">refresh-rules</text>
<line x1="216.1" y1="40" x2="216.1" y2="230" stroke="#a3e635" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>
<line x1="560.3" y1="40" x2="560.3" y2="230" stroke="#f59e0b" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>
<text x="224.1" y="54" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#a3e635">14 nouns carry 100+ sessions</text>
<text x="552.3" y="54" text-anchor="end" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#38bdf8">29 nouns at 10 to 99</text>
<text x="568.3" y="54" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#f59e0b">32 nouns under 10 sessions</text>
</svg>
<figcaption>Distinct sessions per top-level noun, all 75 canonical nouns. Method: one streaming jq over every Bash tool_use in 14,075 transcript files deduplicated to 10,173 session IDs, then a noun extractor that matches <code>agents</code>, <code>ag</code>, and <code>agents-dev</code> at invocation position and strips leading global flags. <code>add</code> and <code>use</code> are the least trustworthy rows because they are common words reachable through the <code>ag</code> alias.</figcaption>
</figure>

### Per-noun census

Subs = leaf subcommands. cmd = non-test lines in the noun's command modules. lib = non-test lines in its owning lib. Sessions = distinct transcripts invoking the noun. 90d = commits touching its command modules since 2026-06-08 (both pre- and post-move paths). Help = has a workflow-first `setHelpSections` block. 72 rows cover the 75 canonical nouns: `add`, `use`, and `remove` share one row, and so do `packages` and `search`.

| Noun | Subs | cmd | lib | Sessions | 90d | Help | Verdict |
|---|---:|---:|---:|---:|---:|:-:|---|
| sessions | 24 | 15,313 | 35,444 | 653 | 69 | Y | keep; split lib/session |
| secrets | 37 | 4,348 | 12,398 | 725 | 30 | Y | keep |
| browser | 57 | 4,057 | 13,959 | 576 | 21 | Y | extract the driver; keep fleet layer |
| ssh | 0 | shared | 17,740 | 432 | 14 | N | keep; merge devices/hosts/fleet libs |
| devices (fleet) | 32 | 4,278 | shared | 220 | 14 | Y | keep |
| feed | 3 | 1,066 | 7,622 | 386 | 6 | N | keep; add help |
| run | 0 | 4,365 | 5,489 | 281 | 51 | Y | keep |
| teams | 14 | 3,476 | 9,644 | 195 | 17 | Y | keep |
| artifacts | 13 | 2,041 | 5,271 | 145 | 23 | Y | extract to artifacts-cli |
| setup | 24 | 1,394 | 241 | 137 | 12 | Y | keep |
| routines | 22 | 2,546 | 6,674 | 128 | 13 | Y | keep; absorb webhooks |
| monitors | 11 | 1,215 | 2,406 | 124 | 14 | Y | keep |
| view | 0 | 2,635 | 92 | 121 | 28 | N | keep; add help |
| doctor | 0 | 1,820 | 2,365 | 102 | 19 | Y | keep; absorb inspect |
| repo | 10 | 1,518 | 2,677 | 99 | 14 | Y | keep |
| computer | 23 | 2,007 | 3,136 | 68 | 15 | N | extract; drop `run --task` loop |
| sync | 1 | 1,508 | 7,208 | 67 | 14 | N | keep; one status lens |
| daemon | 22 | 1,341 | 9,049 | 59 | 13 | Y | keep |
| add / use / remove | 0 | 1,135 | 18,676 | 48 / 40 / 7 | 15 | Y | keep |
| cloud | 8 | 589 | 3,382 | 48 | 7 | N | keep; unhide; absorb factory |
| accounts | 17 | 1,319 | 10,965 | 40 | 19 | Y | keep |
| config | 6 | 751 | 1,928 | 40 | 7 | Y | keep |
| pty | 13 | 442 | 1,078 | 39 | 2 | Y | extract into terminal engine; hide |
| message | 0 | 383 | shared | 34 | 4 | Y | fold into send |
| auth | 11 | 399 | 393 | 32 | 6 | Y | keep |
| clis | 5 | 269 | 710 | 29 | 2 | N | keep |
| plugins | 12 | 972 | 4,064 | 26 | 7 | N | keep |
| notify | 0 | shared | shared | 26 | 6 | Y | cut (self-declared deprecated) |
| rules | 5 | 756 | 1,234 | 20 | 8 | Y | keep |
| upgrade | 0 | 17 | 1,162 | 17 | 1 | N | keep |
| hooks | 5 | 740 | 4,883 | 15 | 5 | N | keep |
| inspect | 0 | 2,379 | shared | 15 | 17 | N | fold into doctor |
| mcp | 6 | 1,035 | 1,243 | 15 | 7 | N | keep |
| prune | 1 | 437 | shared | 14 | 4 | Y | keep; absorb trash + restore |
| insights | 9 | 1,823 | 2,408 | 13 | 5 | Y | keep; relocated under `agents insights` (PHNX-3391) — cmd + lib live (verified 2026-09-06) |
| logs | 3 | 336 | 192 | 12 | 3 | N | fold into events |
| projects | 10 | 1,357 | 4,680 | 12 | 4 | Y | extract to linear-cli |
| tmux | 11 | 633 | 3,794 | 12 | 5 | Y | extract into terminal engine; hide |
| menubar | 5 | 280 | 1,776 | 11 | 5 | N | keep |
| skills | 4 | 732 | 1,006 | 11 | 4 | N | keep |
| permissions | 4 | 898 | 2,867 | 10 | 6 | N | keep |
| watchdog | 6 | 429 | 2,575 | 10 | 5 | Y | keep |
| models | 5 | 421 | 1,743 | 9 | 6 | N | fold into harness |
| send | 0 | 236 | 2,571 | 7 | 6 | Y | keep; absorbs message, notify, mailboxes, humans |
| harness | 7 | 1,749 | 2,073 | 6 | 4 | N | keep; absorbs route, models, modes |
| open | 3 | 101 | 586 | 6 | 2 | N | keep hidden (deep link) |
| update | 1 | 338 | shared | 6 | 4 | Y | keep hidden: version pinning is being phased out, still useful under the hood (owner, 2026-09-06) |
| install | 0 | shared | shared | 5 | 10 | N | keep; the plugin-install umbrella path (`docs/plugins.md:54`) (verified 2026-09-06) |
| route | 8 | 296 | 220 | 5 | 2 | Y | fold into harness |
| commands | 4 | 651 | 1,108 | 4 | 4 | N | keep |
| events | 6 | 557 | 791 | 4 | 5 | N | keep; absorbs logs |
| factory | 2 | 143 | 235 | 4 | 2 | N | decision; beta-gated command, distinct from the `FactoryCloudProvider` (verified 2026-09-06) |
| import | 0 | 385 | 422 | 3 | 6 | N | keep |
| mailboxes | 1 | 522 | shared | 3 | 1 | N | fold into send |
| modes | 0 | 187 | 146 | 3 | 1 | Y | fold into harness |
| traces | 4 | 743 | 4,586 | 3 | 7 | N | hide: daemon-owned sync, never run by hand (owner, 2026-09-06); code extracts as the evals capture client |
| webhooks | 1 | 137 | 951 | 3 | 2 | N | fold into routines |
| subagents | 4 | 481 | 1,196 | 2 | 4 | N | keep |
| trace | 0 | shared | shared | 2 | 0 | Y | cut (alias of sessions trace) |
| trash | 1 | 203 | shared | 2 | 5 | N | fold into prune |
| memory | 4 | 189 | 426 | 1 | 2 | Y | keep |
| registry | 6 | 1,090 | 921 | 1 | 10 | N | decision; co-loaded in the packages module; `lib/registry.ts` has 4 live importers (verified 2026-09-06) |
| restore | 0 | shared | shared | 1 | 5 | N | fold into prune |
| workflows | 4 | 579 | 1,471 | 1 | 4 | N | keep |
| feedback | 0 | 85 | 0 | 0 | 3 | N | cut |
| fork | 0 | 193 | shared | 0 | 3 | N | cut top-level alias |
| humans | 2 | 93 | 94 | 0 | 1 | Y | fold into send |
| packages / search | 1 / 0 | shared | shared | 0 / 0 | 10 | N | cut `search` only (sessions owns search, owner 2026-09-06); `packages` keep — backs the documented `packages materialize` (verified 2026-09-06) |
| reconnect | 0 | 125 | shared | 0 | 1 | N | cut (deprecated, hidden) |
| reminders | 0 | 68 | 98 | 0 | 1 | Y | decision; documented live command (the statusline feature survives a command cut) (verified 2026-09-06) |
| uninstall | 0 | 181 | 359 | 0 | 1 | Y | keep (human-only by design) |
| refresh-rules | 0 | 57 | shared | n/a | n/a | N | keep hidden (shim-internal) |

Lib with no owning command: `lib/crabbox/` 2,088 (**live, not dead** — the TS lib is imported by `run --lease/--box`, `ssh`, `devices lease`, `sessions migrate`; only the external `crabbox` binary is CI-sandbox-only, verified 2026-09-06), `lib/acp/` 324 (live — reached by `run --acp`), `lib/deeplink/` 377, plus shared infrastructure (`state.ts` 1,922, `types.ts` 1,389, `picker.ts` 932, `platform/` 909, `github/` 708, `self-heal/` 563, and about 11.5K of small leaves). Hidden tombstones and aliases inline in `bootstrap.ts`: `perms`, `exec`, `jobs`, `cron`, `check`, `resources`, `hq`, `_internal`.

### How the numbers were produced

```bash
# size: non-test TypeScript under cli/src (find is blocked by the sandbox; git ls-files is exact)
git ls-files 'cli/src/' | grep -E '\.ts$' \
  | grep -v -E '\.test\.ts$|\.bench\.ts$|/__tests__/|/testdata/|\.test-fixture\.ts$|-test-harness\.ts$' \
  | xargs wc -l | tail -1        # 324510 total; keeping .bench.ts or dropping fixtures moves this by under 0.5%

# surface: the generated command tree that CI verifies against buildFullCommandTree()
jq -r '.tree[] | .name' cli/docs/command-index.json | wc -l          # 68 visible groups
grep -rn "\.command(.*hidden" cli/src/commands/*.ts | grep -vc test  # 38 hidden

# usage: every Bash tool_use across every transcript root, deduped by session id
grep -rlF --include='*.jsonl' '"' ~/.agents/.history/{versions,backups,runs} \
  | awk -F/ '!seen[$NF]++' \
  | xargs jq -rR 'fromjson? // empty | select(.type=="assistant") | .message.content[]?
      | select(.type=="tool_use" and .name=="Bash")
      | "\(input_filename)\t\((.input.command // "") | gsub("[\\n\\r\\t]"; " "))"' \
  | perl -ne '<noun extractor: matches agents|ag|agents-dev at invocation position, strips global flags>'

# churn: both pre- and post-2026-08-25 paths, since the src/ -> cli/src/ move breaks plain pathspecs
git log --since=2026-06-08 --format=%H -- cli/src/commands/sessions*.ts src/commands/sessions*.ts | wc -l
```

Caveats that matter for the verdicts. The corpus is effectively all Claude Code; Codex rollouts store shell calls in a different schema and are excluded (about 2%). Session dedup keeps the first copy of each id, so call counts are floors. `hosts` (44 sessions), `status`, `profiles`, `apply`, and other retired top-level tokens still appear in old transcripts and were folded into their current homes for the table. The 90-day window spans ten CLI versions.

## Recommendations

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg class="artifact-diagram" viewBox="0 0 960 560" role="img" aria-label="Current single-package CLI versus proposed core plus five extracted packages">
<text x="40" y="26" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#f59e0b">Today: one package, 75 nouns, 324K lines</text>
<text x="520" y="26" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#a3e635">Proposed: a core plus packages with one-way imports</text>
<rect x="40" y="40" width="400" height="490" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
<text x="52" y="60" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">@phnx-labs/agents-cli</text>
<rect x="52" y="74" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="60" y="97" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">sessions 51K</text>
<rect x="180" y="74" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="188" y="97" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">devices/fleet 22K</text>
<rect x="308" y="74" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="316" y="97" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">versions 22K</text>
<rect x="52" y="122" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="60" y="145" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">browser 18K</text>
<rect x="180" y="122" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="188" y="145" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">secrets 17K</text>
<rect x="308" y="122" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="316" y="145" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">resources 28K</text>
<rect x="52" y="170" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="60" y="193" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">sync+doctor 14K</text>
<rect x="180" y="170" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="188" y="193" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">teams 13K</text>
<rect x="308" y="170" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="316" y="193" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">accounts 13K</text>
<rect x="52" y="218" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="60" y="241" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">daemon 10K</text>
<rect x="180" y="218" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="188" y="241" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">run 10K</text>
<rect x="308" y="218" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="316" y="241" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">routines 9K</text>
<rect x="52" y="266" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="60" y="289" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">feed 9K</text>
<rect x="180" y="266" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="188" y="289" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">share 7K</text>
<rect x="308" y="266" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="316" y="289" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">harness cluster 7K</text>
<rect x="52" y="314" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="60" y="337" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">projects/linear 6K</text>
<rect x="180" y="314" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="188" y="337" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">pty/tmux 6K</text>
<rect x="308" y="314" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="316" y="337" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">traces 5K</text>
<rect x="52" y="362" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="60" y="385" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">computer 5K</text>
<rect x="180" y="362" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="188" y="385" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">insights 4K</text>
<rect x="308" y="362" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="316" y="385" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">cloud 4K</text>
<rect x="52" y="410" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="60" y="433" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">comms 4K</text>
<rect x="180" y="410" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="188" y="433" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">monitors 4K</text>
<rect x="308" y="410" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="316" y="433" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">crabbox 2K</text>
<rect x="52" y="458" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="60" y="481" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">packages 2K</text>
<rect x="180" y="458" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="188" y="481" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">events/logs 2K</text>
<rect x="308" y="458" width="120" height="38" rx="6" fill="#0a0a0a" stroke="#333333" stroke-width="1"/>
<text x="316" y="481" font-family="JetBrains Mono, monospace" font-size="9.5" fill="#c8c8c8">20 more under 3K</text>
<text x="52" y="510" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">every module may import every other; the daemon constructs</text>
<text x="52" y="523" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">the browser, secrets, and session services directly</text>
<rect x="520" y="40" width="400" height="210" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
<text x="532" y="60" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">agents core</text>
<text x="532" y="76" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">run, sessions, devices, secrets, teams, feed, routines,</text>
<text x="532" y="240" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#a3e635">@phnx-labs/agents-cli   ~250K today; split lib/session first</text>
<text x="532" y="90" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">monitors, daemon, sync, setup, view, accounts, resources</text>
<text x="532" y="118" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#c8c8c8">stays in core and wraps each package:</text>
<text x="532" y="134" font-family="JetBrains Mono, monospace" font-size="10" fill="#a3e635">--device routing · consent gate · session linkage</text>
<text x="532" y="150" font-family="JetBrains Mono, monospace" font-size="10" fill="#a3e635">secrets injection · daemon service registration</text>
<rect x="520" y="290" width="195" height="70" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
<text x="532" y="310" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">@phnx-labs/browser</text>
<text x="532" y="326" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">CDP page driver, tabs, upload, record</text>
<text x="532" y="350" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#38bdf8">14K</text>
<line x1="617" y1="290" x2="617" y2="278" stroke="#38bdf8" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>
<rect x="725" y="290" width="195" height="70" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
<text x="737" y="310" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">@phnx-labs/computer</text>
<text x="737" y="326" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">helper RPC + VNC client</text>
<text x="737" y="350" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#38bdf8">5K + native</text>
<line x1="822" y1="290" x2="822" y2="278" stroke="#38bdf8" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>
<rect x="520" y="372" width="195" height="70" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
<text x="532" y="392" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">artifacts-cli</text>
<text x="532" y="408" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">share worker, publish, OG cards</text>
<text x="532" y="432" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#38bdf8">7K</text>
<line x1="617" y1="372" x2="617" y2="360" stroke="#38bdf8" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>
<rect x="725" y="372" width="195" height="70" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
<text x="737" y="392" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">linear-cli</text>
<text x="737" y="408" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">projects, tickets, autoclose</text>
<text x="737" y="432" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#38bdf8">6K</text>
<line x1="822" y1="372" x2="822" y2="360" stroke="#38bdf8" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>
<rect x="520" y="454" width="195" height="70" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
<text x="532" y="474" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">evals capture client</text>
<text x="532" y="490" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">traces sync, trajectory export</text>
<text x="532" y="514" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#38bdf8">5K</text>
<line x1="617" y1="454" x2="617" y2="442" stroke="#38bdf8" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>
<rect x="725" y="454" width="195" height="70" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
<text x="737" y="474" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">terminal engine</text>
<text x="737" y="490" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">pty server, tmux, inject</text>
<text x="737" y="514" font-family="JetBrains Mono, monospace" font-size="10.5" fill="#38bdf8">6K</text>
<line x1="822" y1="454" x2="822" y2="442" stroke="#38bdf8" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>
<line x1="720" y1="250" x2="720" y2="278" stroke="#38bdf8" stroke-width="1.5" opacity="0.8"/>
<line x1="522" y1="278" x2="918" y2="278" stroke="#38bdf8" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>
<text x="520" y="270" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#38bdf8">core imports packages; packages never import core</text>
<text x="520" y="548" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">each package: own tests, own release cadence, one narrow interface into core</text>
</svg>
<figcaption>Today every module can import every other and the daemon constructs the browser, secrets, and session services directly. Proposed: a core that imports six packages through narrow interfaces; packages never import core. Fleet routing, consent, session linkage, and secrets injection stay in core and wrap each package.</figcaption>
</figure>

Do these in order. Each step is a behavior-preserving PR or a short series, and each one shrinks the review surface before the next one starts.

### 1. Cut what nobody uses — verified 2026-09-06

<div class="artifact-callout artifact-callout-warn">
<strong>Correction.</strong> The original cut list below claimed ~11K removable lines. A per-row reference check on 2026-09-06 (grep for importers, command-tree registration, docs, and CI/script usage) found <strong>most of it is live code the census misread</strong> — commands that were <em>relocated to a subcommand</em>, and an <em>operator-only deploy path</em>, both read as "dead" because they left the top-level noun list. The genuinely-dead surface is <strong>~1–2K lines of deprecated top-level alias registrations</strong>, not ~11K. Verified verdicts:
</div>

| Original "remove" row | Claimed lines | Verified verdict | Evidence |
|---|---:|---|---|
| `insights`, `cost`, `output`, `perf` + `lib/analytics|perf|bench|pricing` | 4,231 | **KEEP — live** | relocated under `agents insights` (PHNX-3391), not deleted; `lib/pricing` feeds `budget`/`sessions`/`models`; `lib/bench` backs `run --broadcast`; `lib/analytics`/`lib/perf` are live `bootstrap.ts` ingest paths |
| `lib/crabbox/` | 2,088 | **KEEP — live** | imported by `run --lease/--box` (`exec.ts`), `ssh` (`ssh.ts:127`), `devices lease` (`lease.ts:14`), `sessions migrate` — the external `crabbox` binary was conflated with this TS lib |
| `packages`, `registry`, `install` + `lib/registry.ts`, `lib/packages/` | 2,011 | **KEEP — live** (only `search` cut) | `install` IS the plugin-install umbrella (`plugins.md:54`); `packages materialize` is documented; `lib/registry.ts` has 4 importers (`mcp`, `projects`, `project-pull`, `routines-project`) |
| `factory` | 378 | **DECISION** | beta-gated command; distinct from the `FactoryCloudProvider` (cutting the command leaves cloud dispatch intact) |
| `lib/acp/` | (in ~900) | **KEEP — live** | reached by the `run --acp` flag (`exec.ts:3433`) |
| `reminders` | (in ~900) | **DECISION** | documented live user command; the statusline feature survives a command cut, but it is a behavior removal, not dead code |
| `notify`, top-level `reconnect`/`fork`/`trace`, `feedback` | (in ~900) | **CUT — deprecated aliases** | each a hidden alias whose canonical spelling stays (`send`, `sessions resume`, `sessions fork`, `sessions trace`); registration-only |
| `bootstrap.ts` tombstones `perms`/`exec`/`jobs`/`cron`/`check`/`resources` | ~100 | **KEEP — active forwards** | these still *re-parse* to the canonical command; cutting turns a working forward into an unknown-command error (`hq` alone just dies → CUT) |
| `lib/session/sync/provision.ts` + `worker-template.ts` | ~938 of ~1,200 | **KEEP — live** | the managed session-backup Worker template (PHNX-3726) + its operator deploy path; exercised by a real-workerd render test (`sessions-r2-backup.test.ts:294`); tied to in-flight PR #3411 |
| `attach`/`reconnect`/`go` command bodies | (rest of ~1,200) | **DECISION** | hidden but live recovery aliases (`cli/CLAUDE.md` invariant 11 lists them live) |

Net: the safe cuts are a handful of deprecated top-level alias registrations (~1–2K lines) plus `search`. That is real cleanup but small; it does not move the review-surface needle. **The reduction that matters is Step 2 (fold) and Step 3 (extract)** — they reorganize live code, they do not delete it. Treat the original "cut" figures below and in the hero figure as an upper bound that this check did not confirm.

### 2. Fold the duplicate tokens (75 nouns to about 47)

```text
today                                    proposed
------                                   --------
message, send, notify, mailboxes, humans send            (send --to owner; send boxes; send prune)
logs, events                             events          (events audit|stats|rotate)
trace, sessions trace, traces            sessions trace  (traces sync becomes a daemon service with no noun)
harness, route, models, modes, clis      harness         (harness routes|models|modes) and clis stays
inspect, doctor                          doctor          (doctor --inspect for the divergence report)
sync status, devices status,
devices snapshot, devices apply          sync            (sync status is the one drift lens; apply moves under sync)
trash, restore, prune                    prune           (prune list|restore)
webhooks, daemon webhooks,
routines webhook, daemon funnel          routines        (routines webhooks add|serve|funnel)
update vs upgrade                        upgrade stays; update goes hidden (version pinning is being phased out)
```

<div class="artifact-callout">
<strong>Owner decisions recorded 2026-09-06.</strong> <code>trace</code> and <code>traces</code> are never run by hand; the daemon captures and uploads, so neither stays a top-level noun. <code>search</code> is cut because <code>sessions</code> already owns search. <code>update</code> is still used when an installed version is old, but version pinning is being phased out, so it stays available and hidden rather than advertised.
</div>

Payoff: 27 single-verb groups become verbs on the noun that owns them, and `agents --help` reads as a product instead of an index. Cost of not doing it: agents keep spending tokens picking between `message` and `send`, and `trace` and `traces`.

### 3. Extract the six packages (about 44K lines)

| Package | Moves out | Seam that stays in core |
|---|---:|---|
| `@phnx-labs/browser` | `lib/browser/` minus profiles, resolve-target, remote-control, caller-identity | `--device` routing, the profile registry, the consent gate, `type --secret`, session linkage, daemon service registration |
| `artifacts-cli` (existing) | `lib/share/`, `commands/share.ts`, `artifacts-setup.ts` | `agents artifacts` becomes a thin shim or goes away; the `artifacts` CLI already has `share` |
| `linear-cli` (existing) | `lib/project-*`, `lib/linear-*`, `commands/projects.ts` | `agents run` reads the ticket id from the environment, nothing else |
| evals capture client | `lib/traces/`, `commands/traces.ts`, `sessions-cli/src/lib/session/trajectory-html.ts` | the daemon runs the sync and upload; no top-level noun remains. `sessions trace` calls the renderer. This is the capture seam for evals and needs a home with its own tests |
| terminal engine | `lib/tmux/`, `lib/terminal/`, `pty-server.ts`, `pty-client.ts` | `sessions inject` and `resume` import it; `pty` and `tmux` stop being top-level nouns |
| `@phnx-labs/computer` | `lib/computer/` minus the model loop | `--device` tunnel, permissions groups, feed audit events; delete `computer run --task` and the DES/VNC client unless it gets a use |

Two snags to clear first. `lib/browser/drivers/ssh.ts` imports the computer SSH tunnel and `lib/computer/ssh-tunnel.ts` imports `encodePowerShell` back from browser, so lift both into `lib/ssh-exec.ts`. And `lib/daemon/daemon.ts` builds `BrowserService` directly; it needs a service-registration seam so a package can register its daemon service without the daemon importing the package.

### 4. Split `lib/session/` into four packages (no lines removed, blast radius quartered)

`lib/session/` is 35,444 lines and 76 files. Delete the ~1,200 confidently dead lines from finding 3a first, then split. The natural seams already exist as file clusters: the SQLite index and search (`db.ts`, `index-*`), transcript parsing and rendering (`render*`, `tool-calls.ts`, `trajectory-html.ts`), fleet sync and backup (`sync/`, `remote/`, `r2.ts`), and live identity (`active.ts`, `pid-registry.ts`, `hook-sessions.ts`). Each becomes an internal package with its own tests and a one-way dependency on the one below it. A reviewer can then hold one at a time.

### 5. Merge `devices`, `hosts`, and `fleet` into one lib

17,740 lines in three namespaces for one concept. Move `lib/hosts/` (the `--device` router) and `lib/fleet/` under `lib/devices/`, delete the duplicate SSH plumbing, and give `ssh` and `devices` separate command modules instead of one 3,022-line file.

### 6. Apply the repo's own test rule

The CLAUDE.md rule is already written: keep only tests that protect a distinct product invariant. At 247K test lines, a pass that deletes source-text assertions (the release tests grep `release.sh` as text in 41 places against 9 real invocations), constant guards, and duplicate shards is the second-largest single reduction available after the extractions.

<div class="artifact-callout artifact-callout-warn">
<strong>What this does not do.</strong> After all six steps the core is still about 250K lines because sessions, secrets, devices, teams, run, feed, routines, and the resource sync are the product. The goal is not a small CLI. It is a CLI where a human can review one package at a time and where the daemon, the fleet router, and the session index are the only things everything depends on.
</div>

### Tracking

The fold list in step 2 is one PR per row; the extractions in step 3 are one plan each (the secrets extraction is already under way as its own standalone repo — PHNX-3989 — separately from this census's six). Numbers in this report: keep 203,058 · merge 48,554 · extract 47,784 · cut 9,110 lines by verdict across the 33 subsystems in the hero figure; the ~1,200 lines inside sessions (finding 3a) sit under keep there, which is why step 1 originally said about 11K.

**Cut-verdict verification (2026-09-06).** The step-1 cut list was reference-checked row by row (see §1). The ~9,110 "cut" figure and the hero figure's per-subsystem cut colors did **not** survive: nearly all of it is live code the census misread (relocated subcommands, an operator-only deploy path, a lib conflated with an external binary). The confirmed-dead surface is ~1–2K lines of deprecated top-level alias registrations. The keep/merge/extract figures are unaffected — the correction moves the misread rows from "cut" into "keep". No cut PRs were opened; the value is in step 2 (fold) and step 3 (extract).
