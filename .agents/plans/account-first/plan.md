---
kind: plan
surface: cli
title: Finish the account-first launch cutover
summary: Keep account identity, credentials, settings, and history stable across automatic placement and harness updates.
status: audited proposal
project: AGI
harness: codex
agent: codex
host: development-device
session: account-first-audit
date: "2026-09-10"
tracking: PHNX-3940
repository: phnx-labs/agi-cli
links:
  - https://linear.app/getrush/issue/PHNX-3940
  - https://github.com/phnx-labs/agi-cli/pull/3512
  - https://github.com/phnx-labs/agi-cli/pull/3560
---

## Focus for review

The account is the durable identity. Auto selects an eligible account and device together. Every attempt launches that account's configuration with an installed harness binary. A release number is diagnostic information or an explicit pin; it must never choose a login, settings directory, quota record, or transcript location.

Finish the existing slot architecture; do not add another account store. Cut over all callers before removing legacy homes. Preserve running sessions and independently authenticated device credentials during migration.

<figure class="artifact-figure artifact-behavior">
<section data-state="current" data-evidence="mockup">
<h3>Current: account selected, version home launched</h3>
<pre>agents run claude --device auto
Select an account: work · unverified
no fresh usage … you picked work · claude@2.1.260
Welcome to Claude Code v2.1.267
Choose the text style that looks best for your terminal</pre>
<p>Faithful, sanitized reconstruction of the owner's September 10 capture. The selected account name is illustrative.</p>
</section>
<section data-state="proposed" data-evidence="mockup">
<h3>Proposed: Auto preserves the resolved account</h3>
<pre>agents run claude --device auto
Claude · account work · worker-1
Claude Code 2.1.267
Ready in your existing workspace</pre>
<p>Proposed output, not a shipped implementation. If no candidate has usable credentials or reliable capacity evidence, explain the actual reason. A user-directed stale-usage selection still preserves its account.</p>
</section>
</figure>

## Purpose

Audit and plan the removal of version-based account mechanisms across local run, Auto placement, fallback, resume, teams, routines, storage, sync, updates, and extension consumers. Ordinary launches must require neither a version choice nor a manually pinned account to work correctly.

<div class="artifact-callout"><strong>Observed:</strong> the chosen account candidate had an account slot; the running process used a version home. An OAuth token was present. Claude auth status on that installation reported loggedIn=true. Its configuration lacked completed onboarding. This establishes wrong setup/configuration selection; it does not establish a rejected or missing credential.</div>

Goals: preserve selected identity through every launch boundary; keep accounts independent of binary replacement; provide consistent device/account readiness; safely migrate existing state. Non-goals: changing providers' authentication semantics, copying rotating native OAuth credentials across devices, replacing the secret store, adding extension-owned account mechanisms, or changing active VSCodium windows.

| Journey | Required behavior | Evidence to accept |
| --- | --- | --- |
| New / Auto from terminal or extension | Choose eligible device and account, launch its existing state | Real interactive launch and authenticated request |
| All usage stale | Honest decision or explicit picker; picker preserves full account | Capture plus spawned context inspection |
| Account exhausts quota | Retry another eligible account without inheriting old credential/config | Actual refusal followed by successful distinct-account request |
| Resume on another device | Preserve account intent; resolve local slot on target | Session, account, and target host agree |
| Harness update/removal | Change executable only; preserve settings/login/history | Before/after account and transcript checks |
| Existing legacy install | Adopt identity/state without disturbing active processes | Interrupted and concurrent migration checks |

## Current architecture

<figure class="artifact-figure artifact-figure-diagram">
<svg viewBox="0 0 940 330" role="img" aria-label="Current launch flow loses account slot between candidate selection and execution">
<defs><marker id="arrow-current" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0 0 L10 4 L0 8 Z" fill="#38bdf8"/></marker></defs>
<rect x="15" y="20" width="910" height="280" fill="#101820" stroke="#718096"/>
<text x="35" y="48" fill="#dbe5ee" font-size="18">CLI components · observed current flow</text>
<rect x="35" y="95" width="235" height="100" fill="#102319" stroke="#a3e635"/>
<text x="50" y="122" fill="#dbe5ee" font-size="17">collectRunCandidates</text><text x="50" y="148" fill="#b8c5cf" font-size="15">account + slot + binary label</text><text x="50" y="174" fill="#b8c5cf" font-size="15">TypeScript component</text>
<rect x="355" y="95" width="235" height="100" fill="#291e10" stroke="#f59e0b"/>
<text x="370" y="122" fill="#dbe5ee" font-size="17">stale-usage picker branch</text><text x="370" y="148" fill="#fbbf24" font-size="15">retains version, drops slot</text><text x="370" y="174" fill="#b8c5cf" font-size="15">commands/exec.ts</text>
<rect x="675" y="95" width="225" height="100" fill="#10202a" stroke="#38bdf8"/>
<text x="690" y="122" fill="#dbe5ee" font-size="17">spawn + version shim</text><text x="690" y="148" fill="#b8c5cf" font-size="15">version-home config</text><text x="690" y="174" fill="#b8c5cf" font-size="15">missing setup state</text>
<path d="M270 140 H350" stroke="#38bdf8" stroke-width="2" marker-end="url(#arrow-current)"/><text x="278" y="115" fill="#b8c5cf" font-size="13">candidate</text>
<path d="M590 140 H670" stroke="#38bdf8" stroke-width="2" marker-end="url(#arrow-current)"/><text x="600" y="115" fill="#b8c5cf" font-size="13">version</text>
<text x="35" y="245" fill="#b8c5cf" font-size="15">Key: boxes = CLI components; arrows = in-process data; amber = identity loss.</text>
<text x="35" y="272" fill="#b8c5cf" font-size="15">Binary release remains valid; using its label to recover account state is the defect.</text>
</svg>
</figure>

Audit baseline: CLI main `fdccef7d3` (1.22.94), plus the subsequent main delta to `45d1c8a8c`. Extension baseline `ac104f7`. The later CLI delta is principally browser work; account-source findings below reference the 1.22.94 commit for stable line anchors. Three independent read-only audits cover local launch, storage/lifecycle, and remote consumers. Findings are source observations unless marked inferred risk.

### Removal and cutover map

All CLI paths below are under `cli/src/`; links pin the audited source.

| Area | Current evidence | Required change |
| --- | --- | --- |
| Stale picker / strategy | [exec.ts:2936](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/commands/exec.ts#L2936), [2961](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/commands/exec.ts#L2961): selected slot is discarded; automatic native choice only keeps version | One account selection result through all branches |
| Sign-in selection | [run-account-picker.ts:298](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/commands/run-account-picker.ts#L298): returns version | Explicit account/sign-in intent, never an identity encoded in a release label |
| Readiness / stamps | [rotate.ts:449](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/lib/accounting/rotate.ts#L449), 699, 1423, 1460: first same-version candidate / version stamp | Key by account ID and device; keep auth, quota, and freshness distinct |
| Fallback | [rotate.ts:1512](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/lib/accounting/rotate.ts#L1512): skips all same-version accounts; [exec.ts:2890](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/lib/exec.ts#L2890): spreads primary options into next attempt | Re-resolve each account attempt; retain only task intent and explicit user overrides |
| Feedback / preflight | [exec.ts:3114](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/commands/exec.ts#L3114), [lib/exec.ts:2941](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/lib/exec.ts#L2941): inspect version home | Probe and attribute the account actually spawned |
| Slot foundation | [slots.ts:30](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/lib/accounts/slots.ts#L30), [add.ts:454](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/lib/accounts/add.ts#L454) | Keep account-ID directories and current login/provisioning |
| Resource sync | [slots.ts:62](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/lib/accounts/slots.ts#L62) copies default-version resources; [versions.ts:2549](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/lib/installations/versions.ts#L2549) writes version home | One home-targeted resource writer; enumerate intended account slots |
| Logout / compatibility | [accounts.ts:1044](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/commands/accounts.ts#L1044), [914](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/commands/accounts.ts#L914): logout/attach address version homes | Login/status/logout use same account context; legacy syntax cannot recreate version-owned auth |
| Update / switch | [shims.ts:1655](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/lib/installations/shims.ts#L1655), 1741: copy freshest auth from version homes | Delete credential carry-forward from binary switching after migration |
| Uninstall | [versions.ts:1746](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/lib/installations/versions.ts#L1746) trashes version directory and linked config | Binary lifecycle must preserve account state and sessions |
| Legacy lookup | [exec-account-home.ts:196](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/lib/exec-account-home.ts#L196): slot then legacy version-home search | Put adoption in migration; remove steady-state identity search by installation |
| Auto readiness | [hosts/ready.ts:261](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/lib/hosts/ready.ts#L261): consumes version rows | Consume account/device readiness with consistent timestamps |
| Resume | [session/recovery.ts:231](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/lib/session/recovery.ts#L231): finds origin by version | Carry account identity in recovery and resolve target-local slot |
| Routines | [daemon/runner.ts:1226](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/lib/daemon/runner.ts#L1226): emits agent/version chain; routine readiness keys version | Same resolver and account-aware launch contract as interactive run |
| Teams | [commands/teams.ts:285](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/commands/teams.ts#L285): separate parser | Shared agent/account selector and remote launch intent |

### Remote and consumer details

Explicit SSH account forwarding already works in [hosts/dispatch.ts:499](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/lib/hosts/dispatch.ts#L499). Reuse this transport. Auto must carry the selected account as well as host; target-local resolution validates provisioning without sending local account paths or tokens.

Routine host placement currently rejects every native account at [daemon/runner.ts:1285](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/lib/daemon/runner.ts#L1285). Replace the account-kind ban with destination-slot capability checks, while preserving the distinction between desktop OAuth and portable worker credentials.

Durable session metadata has an org-scoped account key at [session/types.ts:408](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/lib/session/types.ts#L408). The live stream mostly carries account display text. Publish resolved identity through the existing stream; do not recover credentials from display email. Resume command omission alone is not proof of failure because later recovery may recover context; the version-only recovery match is the concrete structural defect.

The extension currently makes version pinning suppress Auto and account strategy in [core/agents.ts:231](https://github.com/phnx-labs/agi-ext/blob/ac104f7/src/core/agents.ts#L231). Remove this coupling only alongside the CLI contract and its consumer tests. Preserve exact workspace cwd and the single-stream presentation design.

Existing tests expose coverage gaps: recovery fixtures derive account keys from versions; automatic routine tests do not cover two account slots sharing one binary; remote-native rejection is explicitly codified. Replace those assumptions with real distinct-account cases. Keep existing explicit SSH account-forwarding coverage.

## Proposed architecture

<figure class="artifact-figure artifact-figure-diagram">
<svg viewBox="0 0 940 430" role="img" aria-label="Proposed account-first launch resolver preserves identity through local and remote execution">
<defs><marker id="arrow-next" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0 0 L10 4 L0 8 Z" fill="#38bdf8"/></marker></defs>
<rect x="15" y="15" width="910" height="390" fill="#101820" stroke="#718096"/>
<text x="35" y="45" fill="#dbe5ee" font-size="18">CLI components · proposed account-first contract</text>
<rect x="35" y="82" width="220" height="90" fill="#10202a" stroke="#38bdf8"/><text x="50" y="110" fill="#dbe5ee" font-size="17">Launch callers</text><text x="50" y="136" fill="#b8c5cf" font-size="15">run / ext / teams / routines</text><text x="50" y="158" fill="#b8c5cf" font-size="15">resume / fallback</text>
<rect x="350" y="82" width="235" height="90" fill="#102319" stroke="#a3e635"/><text x="365" y="110" fill="#dbe5ee" font-size="17">Resolve account + device</text><text x="365" y="136" fill="#b8c5cf" font-size="15">registry + readiness policy</text><text x="365" y="158" fill="#b8c5cf" font-size="15">stable account ID</text>
<rect x="680" y="82" width="220" height="90" fill="#102319" stroke="#a3e635"/><text x="695" y="110" fill="#dbe5ee" font-size="17">Resolve local attempt</text><text x="695" y="136" fill="#b8c5cf" font-size="15">slot + credential reference</text><text x="695" y="158" fill="#b8c5cf" font-size="15">installed executable</text>
<rect x="680" y="262" width="220" height="90" fill="#10202a" stroke="#38bdf8"/><text x="695" y="290" fill="#dbe5ee" font-size="17">Spawn harness</text><text x="695" y="316" fill="#b8c5cf" font-size="15">inject credential locally</text><text x="695" y="338" fill="#b8c5cf" font-size="15">use resolved account home</text>
<rect x="350" y="262" width="235" height="90" fill="#10202a" stroke="#38bdf8"/><text x="365" y="290" fill="#dbe5ee" font-size="17">Events + feedback</text><text x="365" y="316" fill="#b8c5cf" font-size="15">account ID / host / release</text><text x="365" y="338" fill="#b8c5cf" font-size="15">actual attempt outcome</text>
<path d="M255 127 H345" stroke="#38bdf8" stroke-width="2" marker-end="url(#arrow-next)"/><text x="267" y="105" fill="#b8c5cf" font-size="13">intent</text>
<path d="M585 127 H675" stroke="#38bdf8" stroke-width="2" marker-end="url(#arrow-next)"/><text x="590" y="205" fill="#b8c5cf" font-size="13">local call or SSH:</text><text x="590" y="225" fill="#b8c5cf" font-size="13">ID, never secret/path</text>
<path d="M790 172 V257" stroke="#38bdf8" stroke-width="2" marker-end="url(#arrow-next)"/><text x="803" y="216" fill="#b8c5cf" font-size="13">attempt</text>
<path d="M680 307 H590" stroke="#38bdf8" stroke-width="2" marker-end="url(#arrow-next)"/><text x="608" y="284" fill="#b8c5cf" font-size="13">result</text>
<text x="35" y="382" fill="#b8c5cf" font-size="14">Key: boxes = CLI components; arrows = labeled data; green = canonical resolution boundary.</text>
</svg>
</figure>

Account and executable remain distinct fields internally because several accounts may use the same binary, and an account must survive an update. They form one complete launch result; consumers must not reconstruct account identity from the release. The user chooses a task and optionally an account; Auto handles the ordinary case.

## Proposed Changes

Extend existing account resolution into one typed result per attempt. Keep credential references out of events and materialize secret values only inside the target-local spawn boundary. A resolved local home must not be serialized across SSH.

```diff
- selected version -> rebuild account/home later
- fallback = { agent, version }
+ LaunchIntent = harness + account policy + device policy + workspace + release policy
+ SelectedAccount = stable account ID + device + readiness evidence
+ ResolvedAttempt = selected account + local slot + executable + local credential reference
+ fallback selects a new account and resolves a fresh attempt
```

This is a conceptual contract, not an implemented type declaration. Extend the existing resolver rather than adding a parallel subsystem. Explicit profile/provider behavior and account-less harnesses need typed cases, not a fabricated native account.

```diff
- syncVersionConfig(agent, version) owns mutable auth/config home
- switchConfigToVersion carries credentials from another installation
+ project resources into the resolved account home
+ installation lifecycle changes executable state only
+ explicit migration adopts old homes into account slots
```

Reuse `accounts/migrate.ts`. Add launch/migration exclusion, an active-process recheck under that exclusion, and crash-recoverable steps before applying across the fleet. Do not automatically run migration as part of this audit.

### Existing work to reuse

[PR3560](https://github.com/phnx-labs/agi-cli/pull/3560) already fixed the shim to honor a supplied slot and seeds worker onboarding. Its reported live proof used an explicit named account. The remaining branches fail earlier by dropping the selected slot.

[PR3512](https://github.com/phnx-labs/agi-cli/pull/3512) is open, based on an older account/home model. Reuse its user-facing account names, release display, and identity-aware intent. Reconcile it with current slots before adopting code: its diff still includes version-home resolution and same-version exclusions in failover. Do not merge it unchanged as the complete cutover. [PR3509](https://github.com/phnx-labs/agi-cli/pull/3509) owns usage-freshness work; coordinate readiness changes with that scope.

## Public Interface

Keep ordinary `agents run claude --device auto`. It must use the same resolver as explicit `claude#work`, without requiring users to type a name to avoid bugs. Explicit account selection remains useful; explicit release pinning remains an advanced executable choice. An account never gets renamed or reset when a binary updates.

Keep credential policy: portable worker credentials are provisioned through the existing secrets system; per-device native logins remain per-device. Missing provisioning, invalid credentials, quota exhaustion, stale usage, and incomplete onboarding are separate states with separate messages.

Extension New/Auto, resume and dashboards remain thin consumers. They pass account intent and render account/release fields from the CLI stream; they do not choose auth directories or fetch a parallel account roster on tab switches.

## Plan

1. Inventory current callers and establish regression cases: this audit. Confirm legacy compatibility consumers and active owners before implementation.
2. Implement a single resolved attempt through local picker, automatic strategy, preflight, spawn, event attribution, and account fallback. Delete version-keyed account comparisons in those paths together.
3. Carry account identity through Auto eligibility, SSH, recovery, teams, routines, and the CLI session projection. Resolve paths/secrets only on the target device. Update extension callers in a coordinated consumer PR.
4. Move sync/login/status/logout to the same account-home boundary. Establish binary-only installation/update behavior for adopted accounts; retain legacy compatibility for unmigrated accounts until stage 5 verifies adoption.
5. Extend and verify existing migration. Adopt non-busy homes, preserve differing settings/transcripts, recover interrupted operations, then remove credential copying on version switching, steady-state legacy home lookups, and version-scoped metadata. Deletion is gated on successful adoption and consumer cutover, never shipped ahead of migration.
6. Independently review composed changes; run canonical tests and real local/remote interactive and headless flows; release CLI and affected extension; verify installed results without restarting the owner's active windows.

Stages are dependency boundaries, not a fixed number of PRs. No runtime change, credential migration, or release is performed by the audit document.

## Validation

Use source-adjacent tests and real command/service boundaries. A green resolver test alone cannot establish authenticated launch or preserved history.

```text
Two accounts × one binary: correct distinct home, credential and account attribution.
One account × two releases: login/settings/history unchanged after switching binary.
Stale picker: selected account is the spawned account.
Quota refusal A -> B: B credential/config, no primary state carried over.
Provider -> native / cross-harness fallback: no leaked credential ownership.
Auto local -> remote: target-local slot, portable cwd, exact selected identity.
Resume / teams / routines / extension: same account result as direct run.
Upgrade / uninstall: account and session data survive.
Migration while active / interrupted / retried: no moved live home or lost data.
```

For auth proof, inspect only safe identity/status metadata and actual model output. Never print tokens, copy native OAuth stores across devices, or treat token presence as server acceptance. Validate supported harness-specific home semantics using the existing capability registry. Unknown provider availability is an explicit coverage limit, not a fabricated pass.

## Risks

- Migration inventory checks active state at [migrate.ts:225](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/lib/accounts/migrate.ts#L225), but apply later renames a home at 712/622. Launch-versus-migration race is inferred from the lack of a shared exclusion/recheck; it was not triggered on user sessions.
- Rename precedes metadata/manifest persistence at 712–720; transcript reindex occurs later at 783. Exercise interruption and recovery before rollout.
- Existing populated slots can cause legacy homes to be treated as duplicates at 422–448 and 742–753. Preserve differing settings/history; matching account identity alone is not proof of identical contents.
- Trash restore is not a demonstrated full rollback of moved homes, rewritten bindings, and session indices. Specify and test rollback or forward recovery explicitly.
- Harness auth capabilities differ. Use [harness-auth-capabilities.ts:44](https://github.com/phnx-labs/agi-cli/blob/fdccef7d3/cli/src/lib/harness-auth-capabilities.ts#L44); a generic HOME swap is insufficient for adopted harnesses and XDG-based config.
- Existing public version syntax may have external callers. Translate compatibility syntax into account/release intent at entry, deprecate deliberately, and remove credential-bearing version state only after adoption evidence.

## Tracking

- [PHNX-3940: Fleet account state is inconsistent across machines](https://linear.app/getrush/issue/PHNX-3940)
- [PR3512: existing accounts-first launch work](https://github.com/phnx-labs/agi-cli/pull/3512)
- [PR3560: slot-aware shim and worker onboarding, merged](https://github.com/phnx-labs/agi-cli/pull/3560)
- [PR3509: usage freshness, open](https://github.com/phnx-labs/agi-cli/pull/3509)

Tracker reviewed read-only. Runtime work remains pending; this document does not close the umbrella ticket.
