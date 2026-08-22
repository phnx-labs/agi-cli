---
kind: plan
surface: native
title: Remote session tabs follow the harness-owned session name
summary: Keep the first prompt as topic, carry Claude's generated title as label, reconcile it through the existing fleet stream, and preserve automatic-label provenance across editor reloads.
status: implementing
tracking: RUSH-3011
project: agents-cli
repository: phnx-labs/agents-cli
date: 2026-08-21
links:
  - https://linear.app/getrush/issue/RUSH-3011/agi-ext-editor-tab-never-replaces-provisional-topic-with-session-name
facts:
  - The reported active tab showed an early `/continue …` value while the agent status showed a later human session name.
  - The transcript carried repeated Claude `ai-title` events for that later name.
  - The existing elected `agents sessions watch --json` stream already reaches the interactive editor; no second poller is required.
---

## Focus for review

- **Visible behavior:** a remote tab may begin as the bare harness code, but it
  never settles on a slash command; when the agent names the session, the active
  tab changes to that name.
- **Field contract:** `topic` remains the first meaningful prompt and `label`
  carries `/rename`, Claude `ai-title`, or the launch handle.
- **Manual intent:** `Cmd+Shift+L` still wins over an agent-generated name.
- **Execution shape:** reconciliation consumes the existing elected fleet
  stream. It adds no per-tab SSH request, timer, watcher, or scheduler.

## Intent

When an editor on one computer launches an agent on another, the editor tab
should show the session name reported by the agent. An early transport command
such as `/continue <attachment>` is provisional input, not the durable identity
of the work.

## Purpose

Restore the documented session contract at the source and let the existing
fleet stream carry that correction into AGI EXT, so local and offloaded tabs use
the same session identity without per-tab network work.

<div class="artifact-callout"><strong>Root cause:</strong> the CLI collapsed two different values into <code>topic</code>, then the editor treated its first topic-derived label as final and never reconciled later session-stream names.</div>

## What the user sees

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="mockup">
    <h3>Current</h3>
    <p><code>CC - /continue attachment.png</code></p>
    <p>The agent status already says <strong>Release the project</strong>, but the tab stays on transport input.</p>
  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">
    <h3>Proposed</h3>
    <p><code>CC - Release the project</code></p>
    <p>The canonical session name replaces the provisional title as soon as the fleet stream carries it.</p>
  </div>
</div>

<svg viewBox="0 0 1120 310" role="img" aria-labelledby="visible-title visible-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="visible-title">Current and proposed editor-tab behavior</title>
  <desc id="visible-desc">The current tab stays on a slash command even after the agent names the session. The proposed tab replaces it with the generated session name.</desc>
  <rect x="20" y="20" width="520" height="270" rx="18" fill="#141414" stroke="#3f3f46"/>
  <text x="48" y="60" fill="#a1a1aa" font-family="Inter, sans-serif" font-size="16">CURRENT</text>
  <rect x="48" y="82" width="464" height="52" rx="10" fill="#242424" stroke="#ef4444"/>
  <text x="70" y="115" fill="#fafafa" font-family="JetBrains Mono, monospace" font-size="16">CC - /continue attachment.png</text>
  <text x="48" y="178" fill="#a1a1aa" font-family="Inter, sans-serif" font-size="15">Agent status</text>
  <text x="48" y="210" fill="#fafafa" font-family="JetBrains Mono, monospace" font-size="17">Session name: Release the project</text>
  <text x="48" y="256" fill="#ef4444" font-family="Inter, sans-serif" font-size="15">The tab never catches up.</text>
  <rect x="580" y="20" width="520" height="270" rx="18" fill="#141414" stroke="#3f3f46"/>
  <text x="608" y="60" fill="#a3e635" font-family="Inter, sans-serif" font-size="16">PROPOSED</text>
  <rect x="608" y="82" width="464" height="52" rx="10" fill="#242424" stroke="#a3e635"/>
  <text x="630" y="115" fill="#fafafa" font-family="JetBrains Mono, monospace" font-size="16">CC - Release the project</text>
  <text x="608" y="178" fill="#a1a1aa" font-family="Inter, sans-serif" font-size="15">Agent status</text>
  <text x="608" y="210" fill="#fafafa" font-family="JetBrains Mono, monospace" font-size="17">Session name: Release the project</text>
  <text x="608" y="256" fill="#a3e635" font-family="Inter, sans-serif" font-size="15">Both surfaces share one canonical label.</text>
</svg>

## Current architecture

The break is a two-part seam. Claude's title events are parsed on the execution
computer, but `finalizeClaudeScan` folds them into `topic`. On the editor side,
the stream event updates the presentation store and Fleet view only. The
first-topic tab poller stops after its first value, so no later event can replace
it. The lines responsible are preserved by blame to the original topic-title
fold and the later stream-store integration; this is a missing transition, not a
recent working path that regressed.

<svg viewBox="0 0 1120 440" role="img" aria-labelledby="arch-title arch-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="arch-title">Before and after data flow for session tab labels</title>
  <desc id="arch-desc">Before, Claude title events overwrite topic and the editor stream updates only Fleet. After, title events populate label and the existing stream reconciles the active tab.</desc>
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#a3e635"/></marker>
    <marker id="bad-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#ef4444"/></marker>
  </defs>
  <text x="20" y="35" fill="#a1a1aa" font-family="Inter, sans-serif" font-size="16">BEFORE</text>
  <rect x="20" y="55" width="205" height="72" rx="12" fill="#18181b" stroke="#52525b"/>
  <text x="42" y="86" fill="#fafafa" font-family="JetBrains Mono, monospace" font-size="15">Claude JSONL</text>
  <text x="42" y="108" fill="#a1a1aa" font-family="Inter, sans-serif" font-size="13">first prompt + ai-title</text>
  <rect x="315" y="55" width="205" height="72" rx="12" fill="#18181b" stroke="#ef4444"/>
  <text x="337" y="86" fill="#fafafa" font-family="JetBrains Mono, monospace" font-size="15">CLI scanner</text>
  <text x="337" y="108" fill="#ef4444" font-family="Inter, sans-serif" font-size="13">title overwrites topic</text>
  <rect x="610" y="55" width="205" height="72" rx="12" fill="#18181b" stroke="#52525b"/>
  <text x="632" y="86" fill="#fafafa" font-family="JetBrains Mono, monospace" font-size="15">Fleet stream</text>
  <text x="632" y="108" fill="#a1a1aa" font-family="Inter, sans-serif" font-size="13">presentation store</text>
  <rect x="905" y="55" width="195" height="72" rx="12" fill="#18181b" stroke="#ef4444"/>
  <text x="927" y="86" fill="#fafafa" font-family="JetBrains Mono, monospace" font-size="15">Editor tab</text>
  <text x="927" y="108" fill="#ef4444" font-family="Inter, sans-serif" font-size="13">provisional latch</text>
  <path d="M225 91 H305" stroke="#ef4444" stroke-width="2" marker-end="url(#bad-arrow)"/>
  <path d="M520 91 H600" stroke="#ef4444" stroke-width="2" marker-end="url(#bad-arrow)"/>
  <path d="M815 91 H895" stroke="#ef4444" stroke-width="2" stroke-dasharray="7 6" marker-end="url(#bad-arrow)"/>
  <text x="20" y="230" fill="#a3e635" font-family="Inter, sans-serif" font-size="16">AFTER</text>
  <rect x="20" y="250" width="205" height="88" rx="12" fill="#18181b" stroke="#52525b"/>
  <text x="42" y="282" fill="#fafafa" font-family="JetBrains Mono, monospace" font-size="15">Claude JSONL</text>
  <text x="42" y="306" fill="#a1a1aa" font-family="Inter, sans-serif" font-size="13">topic + ai-title</text>
  <rect x="315" y="250" width="205" height="88" rx="12" fill="#18181b" stroke="#a3e635"/>
  <text x="337" y="282" fill="#fafafa" font-family="JetBrains Mono, monospace" font-size="15">CLI scanner</text>
  <text x="337" y="306" fill="#a3e635" font-family="Inter, sans-serif" font-size="13">topic + label stay separate</text>
  <rect x="610" y="250" width="205" height="88" rx="12" fill="#18181b" stroke="#a3e635"/>
  <text x="632" y="282" fill="#fafafa" font-family="JetBrains Mono, monospace" font-size="15">Fleet stream</text>
  <text x="632" y="306" fill="#a3e635" font-family="Inter, sans-serif" font-size="13">existing elected stream</text>
  <rect x="905" y="250" width="195" height="88" rx="12" fill="#18181b" stroke="#a3e635"/>
  <text x="927" y="282" fill="#fafafa" font-family="JetBrains Mono, monospace" font-size="15">Editor tab</text>
  <text x="927" y="306" fill="#a3e635" font-family="Inter, sans-serif" font-size="13">canonical label wins</text>
  <path d="M225 294 H305" stroke="#a3e635" stroke-width="2" marker-end="url(#arrow)"/>
  <path d="M520 294 H600" stroke="#a3e635" stroke-width="2" marker-end="url(#arrow)"/>
  <path d="M815 294 H895" stroke="#a3e635" stroke-width="2" marker-end="url(#arrow)"/>
  <rect x="20" y="380" width="16" height="16" rx="3" fill="#a3e635"/><text x="46" y="393" fill="#d4d4d8" font-family="Inter, sans-serif" font-size="13">canonical transition</text>
  <rect x="235" y="380" width="16" height="16" rx="3" fill="#ef4444"/><text x="261" y="393" fill="#d4d4d8" font-family="Inter, sans-serif" font-size="13">broken or missing transition</text>
</svg>

### Source-grounded findings

| Claim | Evidence |
| --- | --- |
| Claude's first prompt and generated title now remain separate. | `apps/cli/src/lib/session/discover.ts:3837-3857` returns `topic: state.topic` and `label: state.customTitle || state.aiTitle`. |
| The indexed row exposes the title through the canonical field. | `apps/cli/src/lib/session/discover.ts:1598-1601` assigns transcript/live names to `SessionMeta.label`. |
| Empty metadata cannot erase a prior name. | `apps/cli/src/lib/session/db.ts:2379-2384` skips null/blank refinements. |
| Raw slash commands are provisional, not task names. | `apps/ext/src/core/sessionTabLabelSync.ts:16-21` recognizes wrappers and raw slash commands. |
| Manual labels remain authoritative. | `apps/ext/src/core/sessionTabLabelSync.ts:37-45` refuses a canonical update when a genuine manual label exists. |
| The editor consumes the existing stream transition. | `apps/ext/src/vscode/extension.ts:3641-3678` reconciles matching tabs; `apps/ext/src/vscode/extension.ts:5320-5324` invokes it only after an accepted stream event. |
| A generated title stays replaceable after reload. | `apps/ext/src/core/sessions.persist.ts` stores `autoLabel`; `apps/ext/src/vscode/terminals.vscode.ts` restores it separately from a user label. |

## Proposed Changes

### Implementation as real code

```diff
- const resolvedTopic = state.customTitle || state.aiTitle || state.topic;
+ const label = state.customTitle || state.aiTitle;
  return {
-   topic: resolvedTopic,
+   topic: state.topic,
+   label,
  };
```

```diff
  if (sessionPresentationStore.apply(event.payload)) {
    void settings.refreshFloorFromSessionStream();
+   void syncCanonicalSessionTabLabels(context);
  }
```

```diff
+ const update = planSessionTabLabelUpdate(
+   { manualLabel: entry.label, autoLabel: entry.autoLabel },
+   sessionPresentationStore.liveSession(entry.sessionId),
+ );
+ terminals.setAutoLabel(entry.terminal, update.label);
```

```diff
  sessions.push({
    label: entry.label,
+   autoLabel: entry.autoLabel,
  });
```

## Public Interface

No command or flag is added. The existing `agents sessions` JSON shape already
contains `topic` and `label`; this change makes their values obey the documented
contract. AGI EXT continues consuming `agents sessions watch --json` and changes
only the editor-tab presentation derived from an accepted stream event.

## Validation

- Claude full and incremental parsers must agree on both `topic` and `label` at
  every boundary.
- A title arriving in an appended JSONL chunk must update the indexed label
  without changing topic.
- A stream label must replace the reported `/continue …` auto-label, including
  the reload migration where an older extension promoted it to manual.
- A genuine manual label, an unlabelled stream row, and an already-current tab
  must remain unchanged.
- The packaged extension must be installed on the interactive editor and the
  shipped tab visually inspected after the fleet session produces a name.

## Risks

- **Manual-label overwrite:** bounded by refusing updates when a genuine manual
  label exists. Automatic-label provenance is persisted across reloads; only
  slash-command/first-topic values promoted by older releases are migrated.
- **Focus theft:** inactive tabs store the new auto-label and wait for the
  existing focus handler; only the already-active terminal is renamed at event
  time.
- **Double scheduling:** none. Reconciliation is a pure consequence of the one
  elected CLI stream event and owns no timer or subprocess.

## To-do checklist

- [x] Reproduce from the attached screenshot and live transcript.
- [x] Trace CLI scan, active stream, presentation store, and tab lifecycle.
- [x] Obtain two independent blinded traces.
- [x] Split Claude `topic` and `label`; preserve non-empty labels.
- [x] Reconcile canonical labels into tabs without a second scheduler.
- [x] Add parser, database, and presentation regression tests.
- [x] Run full CLI and extension verification plus packaged build.
- [ ] Install on the interactive editor and visually verify the real tab.
- [ ] Land reviewed PR, release both surfaces, and verify installed versions.

## Tracking

- [RUSH-3011 — AGI EXT: editor tab never replaces provisional topic with session name](https://linear.app/getrush/issue/RUSH-3011/agi-ext-editor-tab-never-replaces-provisional-topic-with-session-name)
