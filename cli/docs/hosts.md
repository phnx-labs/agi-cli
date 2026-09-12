<!-- guide -->
# Hosts — dispatch agents to your own machines

> **Status:** Implemented. `agents hosts` and the `-D, --device` flag
> ship today across virtually every first-class group (`repos`, `view`, `inspect`,
> `usage`, `cost`, `doctor`, `list`, `sync`, `plugins`, `skills`,
> `teams`, `routines`, …), on `agents run`, and on multi-host aggregators
> (`sessions`, `feed`, `logs`). Groups with no remote semantics reject the flag
> with a clear message — never a raw commander `unknown option`.  Every `agents run` option is classified
> by the forwarding contract (`RUN_OPTION_FORWARDING`,
> `src/lib/hosts/remote-cmd.ts`) — forwarded, rejected loud, or local-only;
> nothing silently drops at the SSH boundary. This document is
> the design rationale; see [concepts.md](concepts.md#devices--hosts) for
> the concept overview and how hosts relate to the Tailscale-backed
> `agents devices` registry, and [ssh-transport.md](ssh-transport.md) for
> the shared, multiplexed SSH transport every `--device` command rides.

`agents hosts` lets you run any agent (`claude`, `codex`, `droid`, …) on any of
*your* machines — a Mac mini, a Windows mini, a couple of DGX Sparks — addressed
by name from a small local registry, over plain SSH, with no central service to
run or pay for.

**Placement** (where the body runs) is one model shared with lease, cloud, and
routines — see [concepts.md § Placement](concepts.md#placement). On
`agents run`, prefer `--where`; the older flags remain aliases:

```
agents run claude "fix the auth bug"   --where device:mac-mini   # = --device mac-mini
agents run claude "…"                  --where auto              # = --device auto
agents run claude "fix CI"            --where lease --mode edit # = --lease
agents run claude "fix the auth bug"   --device mac-mini
agents run codex  "port this to rust"  --device spark-0
agents run droid  "triage the inbox"   --device win-mini
agents run claude                      --device mac-mini          # interactive: TTY forwarded
agents run claude "…"                  --device auto
```

Pass `auto` as the `--device` value to pick a host from 14-day session
affinity (weighted by launch counts on `sessions.db` `machine`; most-used online
device has highest probability). Harness stays the agent you typed — never
auto-picked. Affinity failure degrades to local rather than aborting the run.

### A bare interactive run places itself (PHNX-4083)

A bare human-facing `agents run <harness>` — no prompt, so an interactive TUI
run — places itself like `--device auto`: the same pool, the same health
checks, the same `[agents] device=auto → <box>` banner, with the TUI forwarded
over SSH. A marker you leave off is decided for you: no `#` means balanced
rotation, no `@` means automatic device placement. Headless runs are
unchanged — any prompt (`agents run claude "fix it"`), `--json`, no TTY,
teams/routines/hooks — those keep running in place. Two spellings stay local:

```
agents run claude --device $(hostname -s)   # pin this machine explicitly
agents run claude@                          # …or pick "this machine" (listed first) in the @ menu
```

Placement failure never silently becomes a local launch: with no healthy
device (an empty pool, or every candidate refused — e.g. the PHNX-4051
stale-usage gate) the run exits nonzero with the placement error plus one
line naming the local spelling: `Run here instead: agents run claude --device <this machine>`.

### Which devices `auto` may pick — device roles

Automatic placement draws from a **pool**, not from every online box. Mark what a
device is for, once, from any machine:

```
agents devices role yosemite-s0 worker    # agents run here
agents devices role yosemite-s1 worker    # …and here
agents devices role zion personal         # your laptop — keep agents off it
agents devices role                       # who is marked what, and what auto would pick
```

| Fleet state | `--device auto` picks from |
|---|---|
| nothing marked | every online device (the historical behavior) |
| any device marked `worker` | ONLY the marked workers |
| a device marked `personal` | never, under either state |

Marking a worker is what turns the pool into an **allowlist** — that is the whole
opt-in: two marks and every automatic launch lands on those two boxes. The rule
lives in one place (`src/lib/devices/pool.ts`) and every automatic-placement
caller reads it, so `agents run --device auto`, `agents teams add --device auto`,
`agents ssh auto`, and the AGI EXT `New <Harness>` commands agree. Widen it back
with `agents config set auto.pool all`; a `personal` box stays excluded, since
that is what the mark is for.

An empty pool is an error, not a shrug: with workers marked and none of them
reachable, `--device auto` fails loud naming the fix rather than quietly running
on the machine you are sitting at — including through `agents ssh auto` and the
generic `--device auto` passthrough, which resolve `auto` via the same pool.

### Probe budget: relayed peers get longer (PHNX-3682)

Placement probes each candidate over SSH and excludes any box that does not
answer inside a budget. That budget is **path-aware**, because a DERP-relayed
hop pays relay path setup on top of the TCP + SSH handshake:

| Last handshake | Budget | Constant |
|---|---|---|
| direct Tailscale path (or unknown, e.g. a `via:"manual"` device) | 2.5 s | `PROBE_TIMEOUT_MS` |
| DERP-relayed (`tailscale.direct === false`) | 8 s | `RELAYED_PROBE_TIMEOUT_MS` |
| windows (powershell) | 6 s | `WIN_PROBE_TIMEOUT_MS` |

One flat 2.5 s used to apply to every device. On a fleet with **no** direct
paths that is shorter than a cold relayed handshake — measured across a nine-box
relayed fleet, probed in parallel from cold: 1.7 / 1.8 / 1.9 / 2.7 / 2.7 / 2.7 /
3.1 / 5.6 / 6.6 s, six of nine over budget while every one of them was healthy
(all answered within 10 s). `--device auto` therefore reported the entire fleet
as `unreachable` and refused to launch. Warm, the same probes take 0.5–0.9 s,
which is why the failure looked intermittent and "fixed itself" after any other
fleet command warmed the paths.

A probe killed for exceeding its budget is now reported as **`probe timed out`**,
not `unreachable`, in `--device auto`, `agents devices pick`, and `agents teams`
placement alike. The two
mean different things — a slow link versus a box that is actually down — and the
error only mentions usage-window resets when a device was genuinely turned away
for one. Check `tailscale status` for `relay "<region>"` on rows you expect to be
direct; restoring a direct path removes the latency rather than masking it.

Roles live in that device's tracked `devices/<name>/agents.yaml` `config.role`
and travel with `agents repo push` / `pull`. Per-device files are
conflict-free because each machine writes only its own folder; a role set
from any box writes that device's folder, not a shared central map.
`agents devices list` tags marked rows (and shows each box's `spec` —
cores/RAM/disk — plus live load/mem/disk and the one-line `description`), and
`agents devices list --json`
carries `role` plus an `autoPool` boolean per device.

### `agents run auto` — all three routing layers

`auto` as the AGENT name (`agents run auto "…"`, distinct from `--device auto`)
composes the full dispatch stack:

1. **Host** — with no `--device` flag, the affinity pick above runs
   (launches^1.3 weighted sample among online devices). A remote pick dispatches
   `agents run auto …` to that host over the same SSH path, and the harness +
   account layers resolve THERE (usage is per-machine); the dispatcher marks the
   host layer resolved (`AGENTS_RUN_AUTO_HOST_RESOLVED=1`) so the remote never
   re-runs affinity and chain-hops. `--device <name>` pins this layer.
2. **Harness** — `pickHarnessWeighted` (lib/rotate.ts): installed harnesses with
   ≥1 healthy account, weighted by best-account headroom
   (`100 − min routingUsed%`), sampled with the same `weightedRandomByCapacity`
   the account layer uses. A harness whose accounts are all rate-limited,
   signed out, or server-revoked (the live auth-health probe saw a genuine
   401/403 rejection — not Claude's setup-token `user:profile` scope gap,
   which is `unverified` / RUSH-2392) is excluded outright. Naming a concrete
   harness (`run claude`) pins this layer.
3. **Account** — `pickBalancedCandidate` within the chosen harness (or the
   `--strategy` you passed). Eligibility excludes an account that is
   rate-limited, out of credits, signed out, or `revoked` (a token the daemon's
   live auth-health probe saw rejected — so rotation never routes into a login
   that would fail at spawn). A Claude setup-token that 403s only for missing
   `user:profile` on the usage endpoint is `unverified`, not `revoked`, and
   stays eligible to run (RUSH-2392). Fail-open: a missing probe or any
   non-revoked verdict never blocks; a cached `revoked` keeps gating (the
   conservative choice for a security signal) until the daemon's next probe
   clears it.

Every layer fails loud when it finds nothing: zero healthy accounts on any
harness exits nonzero naming each harness's exclusion reason and the earliest
window reset; zero healthy accounts within the picked harness exits nonzero
with `agents: no healthy <agent> account under strategy '<strategy>' — excluded:
…; earliest window resets <iso-time>. Use --strategy pinned to force the
default.` (the daemon watchdog tail-detects this text for rotate cooldowns).
`--session-id` keeps its claude-only semantics — honored when auto picks
claude, ignored with a stderr note otherwise.

### Choose an account after device placement

A trailing `#` on a concrete harness composes with device routing. agents-cli
forwards the marker unchanged, so the peer — not the launcher — lists and
selects from the installed versions/accounts it reported:

```bash
agents run claude# --device auto         # auto-place, then choose an account there
agents run claude# --device yosemite-s0  # choose from yosemite-s0 only
```

### Pick the device (`@`), or both (`#@`)

A trailing `@` opens the device picker instead: every registered fleet device,
rendered from the last cached fleet state (this machine first, offline rows
disabled, state age in the prompt). The pick becomes the run's `--device`;
choosing this machine is a plain local run — one of the two spellings that
keep a bare interactive run off the automatic-placement path (the other is
`--device <this machine>`). `#@` (or `@#`) asks both, in
order — the account picker runs first against this machine's slots, then the
device picker shows a ✓/– mark for the picked account on each device, and the
run dispatches to the chosen device with `claude#<label>` so the peer
resolves its own slot:

```bash
agents run claude@    # pick the device; the account stays balanced
agents run claude#@   # pick the account, then the device that runs it
```

The pickers remain interactive, and a cancelled menu launches nothing.
Account selection (`#`) cannot be combined with another account selector such
as `--account`, `--strategy`, `--balanced`, `--resume`, `--lease`, or `--box`;
device selection (`@`) cannot be combined with `--device`/`--on`/`--computer`/
`--host` or with `--lease`/`--box`. A pin for the same dimension is equally
invalid (`claude@2.1.218#`, `claude#work#`); `claude#work@` is the valid
spelling for "account work, device picker".

For `--device auto`, picker placement prefers a signed-in device but keeps a
reachable device with the harness installed eligible when every account there
is signed out or revoked. That fallback is what lets the device-local picker
offer `launch to sign in`. A device whose picker would contain only throttled
rows remains excluded; ordinary automatic runs still require a healthy,
signed-in account before placement.

The sign-in a device is judged by is the **strict per-version launch truth**, not
the display "who is logged in": a box whose selected harness only inherits the
active/global HOME login but has no credential in the per-version home the
isolated run launches is **not** a valid `--device auto` target and is excluded,
because such a launch would die at spawn. This is the same launchability the
local candidate uses (`isLaunchableSignedIn`), carried to remote candidates by a
per-version `launchable` field in `agents view --json` (PHNX-3466). A blind
worker with a real per-version credential but no readable usage snapshot stays
eligible — unverified usage is not a logout.

**One carve-out: a missing login is not an exhausted account.** When the only
thing wrong is that an account is signed out (or its token was revoked), a
terminal run does NOT fail loud — it launches so you can authenticate, because
the harness's own TUI is the login surface and there is nowhere else to do it.
`agents run <agent>` with a single such account launches it directly (naming the
version and the login command); with several it opens the account picker, where
an auth-blocked row is selectable and labelled `launch to sign in`. A
throttled account is never launched this way — only a window reset clears
`rate_limited` / `out_of_credits`, so those still exit nonzero with the message
above.

The launch requires a **human-facing** run, which is two conditions, not one: a
real TTY *and* no `--json`. Off a TTY nothing can complete a login, and `--json`
marks a machine consumer that must never be handed a picker or dropped into a
login TUI — so both keep failing loud, with the harness's login command added
alongside `--strategy pinned`. `--quiet` does not block the launch; it only
suppresses the explanatory lines. The gate is `signInLaunchDecision` in
`src/commands/run-account-picker.ts`, mirroring `Surface.interactive` from
`src/commands/utils.ts`.


Pass `all` as the `--device` value to fan any fleet-aware command out
across every registered device. The passthrough runs `agents <cmd> --json` on each
box concurrently, then renders a grouped-by-OS roster with one row per device
(`○ offline` rows for unreachable devices, `●` rows for successful ones). Add
`--json` to get the raw device-keyed object instead.

```
agents view kimi --device all          # every box's kimi version + account
agents insights output --device all             # per-device burn vs shipped output
agents view --device all --json        # machine-readable fleet inventory
```

`--devices all` fans out across every registered device. Commands that already register
`--all-hosts` (e.g. `agents insights output --all-hosts`) keep their existing behavior.

**The router only speaks for commands that exist.** `--device` is handled
before commander parses, so a group with no remote semantics gets a clear
`` `agents <cmd>` does not support --device `` instead of commander's raw
`unknown option`. That answer is reserved for a **real** command: a name the CLI
does not register falls straight through to `unknown command '<name>'` (plus its
did-you-mean). Without that gate `agents session resume --device <box>` — one letter
off `sessions`, which *does* take `--device` — was answered with a flag-support error
about a command nobody typed, sending the user looking in the wrong place
(RUSH-2022). `KNOWN_TOP_LEVEL_COMMANDS`
([`src/lib/startup/command-registry.ts`](../src/lib/startup/command-registry.ts))
is the name set, pinned to the real command tree by a test.

It sits next to the vendor clouds (`agents cloud run --provider rush|codex|…`),
not replacing them: those dispatch to *someone else's* cloud; `hosts` dispatches
to *your* boxes (owned, or leased on demand via crabbox — see Host sources).

## Motivation — the bottleneck is OS coordination, not RAM

This is grounded in a real incident (Agent Workload Resource Report, 2026-06-27).
A 30-core workstation became unusable while running agents — but **not** from
memory pressure (102G used, **25G free**). The failure was **OS-coordination
starvation**:

```
Load Avg: 232.61, 306.45, 245.25
CPU: 18.99% user, 79.35% sys, 1.65% idle
Processes: 1807 total, 13322 threads
```

~79% of CPU was spent *inside the kernel* (scheduling, vnode/path resolution,
symlink handling, filesystem metadata) — a recursive `ripgrep` search-storm from
an editor extension, plus the general process/file/UI fan-out of agent tooling. A
Linux 16-vCPU comparison showed the same shape (`system_pct` ~50, `runnable` ~38,
high fork rate). The report's conclusions map directly onto this design:

- **"Separate headless agent execution from interactive rendering."** Running an
  agent headless and publishing *summarized state transitions* — instead of
  rendering its full transcript character-by-character in a desktop UI — is what
  lets a machine carry more concurrent work. This is exactly the transcript-tail
  progress model (§4): the agent runs headless on the host; we read summarized
  events from its transcript, we don't live-render a remote TTY.
- **"A cloud or Linux box helps only if synchronization overhead is
  controlled."** Offloading is necessary (your laptop has finite coordination
  capacity), but the remote run must be bounded — headless, concurrency-capped,
  no unbounded recursive scans. The design must carry those constraints to the
  host, not just relocate the storm.

So `hosts` isn't only "I want more cores" — it's "keep my interactive machine
responsive by moving headless agent execution off it," which the report shows is
a coordination problem money-can't-buy-RAM doesn't fix.

## Why this is brokerless (the core thesis)

Every hosted-agent product surveyed — OpenAI Codex, Cursor cloud agents, Cognition
Devin, Factory Droid Computers, Google Jules, Anthropic Managed Agents — runs a
central relay/control-plane. But they all do it for **one** reason: they are
multi-tenant and their machines sit behind NAT they don't control, so they need a
relay for NAT traversal + discovery + identity + heartbeat. Cursor and Factory say
so directly — the relay exists "so no inbound ports / VPN required" (i.e.
*because there is no VPN*).

- Cursor self-hosted: outbound HTTPS worker → control plane. <https://cursor.com/blog/self-hosted-cloud-agents>
- Factory BYOM: outbound WebSocket → Factory relay. <https://docs.factory.ai/cli/features/droid-computers>
- Anthropic self-hosted: outbound HTTPS poll of a work queue. <https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes>

We don't have their constraint. These are **your** machines, few in number, that
you already know about — so discovery isn't a problem to solve, it's a **list you
write down**. The entire broker layer collapses to a small local registry plus
SSH:

| What a relay-broker provides | What we use instead |
|---|---|
| connection registry (name → address) | a `hosts:` map in `agents.yaml` you maintain (`name → {address, user, caps}`) |
| heartbeat / "is it online?" | checked **lazily, on dispatch** — one SSH probe to the *one* host you're targeting, never a fleet-wide poll |
| NAT traversal | whatever already makes the address reachable — LAN, or a tailnet/VPN you happen to run. Out of scope for agents-cli. |
| SSH key distribution / rotation | the existing `ssh-keys` bundle / your own `~/.ssh` |
| identity / always-on nodes | a registry entry; the box is as always-on as you keep it |

So this prior art's relay (rush's `prix/api/src/computers/relay.ts` + the Go daemon's
outbound WebSocket in `rush/cli/internal/daemon`) is exactly the part we **don't**
need — and neither do we need a *discovery* layer that enumerates a whole network.
What a free CLI needs is: resolve a **name** in the registry → `ssh <address>
'agents run …'`. No metadata service, no DB, no heartbeat, no fleet enumeration.

**On Tailscale specifically (deliberately not a dependency).** A tailnet is a great
*transport* — if a box is only reachable over yours, you register its `.ts.net`
name as the `address` and SSH rides the tailnet with zero extra code. But agents-cli
will **not** call `tailscale status`, enumerate peers, or connect to nodes you
didn't name. Treating "the tailnet" as the fleet is the wrong default: it pulls in
machines you don't want to dispatch to and assumes a VPN that not every host needs.
The registry is the source of truth; Tailscale is one optional way an `address`
becomes reachable. (A convenience importer — `agents hosts import --from-tailscale`
— can *prefill* registry entries from `tailscale status` on request; it reads names
and connects to nothing.)

## What the field actually does (and where we can be better)

Remote-agent UX has converged on two modes:

- **Relay / remote-control** — the agent keeps running on machine A; B is a live
  window (Claude Code Remote Control, Codex remote-SSH from the phone). Seamless,
  but A must stay awake. <https://code.claude.com/docs/en/remote-control>
- **Migrate / handoff** — the session moves (Claude `--teleport`, Codex thread
  handoff, Cursor "Move to Cloud", Devin `/handoff`). But **every one transfers
  only committed git + the transcript and either blocks on or silently drops
  uncommitted changes.** Devin alone moves full state — via proprietary VM
  block-diff snapshots, only inside its own cloud (<https://cognition.com/blog/blockdiff>).

The uncommitted-changes wall exists because those tools **can't reach into your
machine** — no direct network path, multi-tenant. We don't have that constraint: we
control both ends and have an SSH path to each host, so a handoff can `rsync` the
dirty working tree directly — no "clean git required," no VM snapshots. That is the
differentiated capability (Phase 2), and it's something Claude Teleport / Cursor
have open issues asking for.

## The HostProvider seam (the pluggable directory + reachability layer)

The one design decision that keeps this open and general-purpose: **where host
metadata lives and how a host is reached is a pluggable provider**, not a hardcoded
mechanism. This mirrors the existing `CloudProvider` registry
(`src/lib/cloud/registry.ts`) — capability-gated, so partial providers are
first-class. Two orthogonal concerns:

1. **`HostProvider`** — *"what are my hosts, and how do I reach them?"* Owns the
   registry/metadata + presence + (optionally) its own dispatch channel.
2. **Transport** — *how a command actually runs*: SSH to an address, or a provider's
   own relay. Shared, so every provider benefits.

```ts
interface HostProvider {
  id: string                  // 'local' | 'rush' | 'tailscale' | 'crabbox' | <yours>
  capabilities(): {
    directory   // list/track hosts            (all)
    mutate      // add / remove                 (local, rush — not tailscale)
    presence    // online/offline               (rush relay, tailscale status)
    relay       // dispatch w/o an SSH address    (rush; others fall back to SSH)
    lease       // provision new hosts            (crabbox / infra)
  }
  list(): Host[]              // {name, address?, user?, os?, caps?, status?, provider}
  resolve(name): Host | null
  register?(spec) / remove?(name)
  presence?(name)
  dispatch?(name, cmd)       // relay path, if capabilities.relay
}
```

**Dispatch is provider-agnostic:** `resolve(name)` → if the owning provider has
`relay` and the host is online, use it (NAT-free, no address); else SSH to
`host.address`. Adding a provider is a few `providers.set(...)` lines, no core
reshape.

| Provider | directory | mutate | presence | relay | lease | What it is |
|---|---|---|---|---|---|---|
| `local` | ✓ | ✓ | — | — | — | a `hosts:` map in `agents.yaml` — **the v1 provider**; offline, no account |
| `rush` | ✓ | ✓ | ✓ | ✓ | — | account-keyed `computers` table + WS relay (fast-follow) |
| `tailscale` | ✓ | — | ✓ | — | — | reads `tailscale status` as the fleet; SSH transport (fast-follow) |
| `crabbox` | ✓ | ✓ | partial | — | ✓ | leases boxes from Hetzner/AWS/… then registers them (fast-follow) |
| *(yours)* | … | … | … | … | … | a VPN/SDN/infra API — implement the contract, register it |

**v1 ships only `local`.** It meets the core "offload from the thrashing laptop to a
stable SSH box" need with zero account/daemon dependency. The other providers are
purely additive behind this contract — see Phasing for why deferring `rush` costs
nothing.

### Why `local` first, not `rush` (cost/benefit)

Rush's `computers` backend is real and fully built (`prix/api/src/computers/` —
Supabase table keyed by `user_id`, `POST/GET /api/v1/computers`, WS-relay presence,
`POST /api/v1/computers/:name/exec`). It would give cross-device registry sync,
presence, and NAT-free relay dispatch. But every one of those benefits is
**conditional**, and none blocks the primary use case:

| Rush buys | v1 substitute | Blocks core offload? |
|---|---|---|
| cross-device registry sync (no git push) | registry on the driver machine | No — you drive from one machine, offload to others |
| presence (online/offline) | one lazy SSH probe at dispatch | No — you target one host at a time |
| NAT-free relay exec | SSH to the address | No — your boxes are SSH-reachable (LAN/tailnet/public) |

Costs of taking it in v1: forces `rush login`, requires a daemon holding a WebSocket
on every machine, and couples the OSS CLI to the proprietary Rush backend. So `rush`
is a fast-follow `HostProvider`, opt-in when logged in — not a v1 dependency.

## Architecture

```
agents run <agent> ["<task>"] --device <device>
  │
  ├─ resolveHost(name)         one merged lookup (devices registry ∪ agents.yaml
  │                            overlay ∪ ssh_config) → {address,user,caps,os,…}   [Phase 1]
  │
  ├─ ensureHostReady(name)     lazy SSH probe (online?) + config + agent + branch  [Phase 1]
  │
  ├─ prompt given?             headless detach-and-follow path
  │     ssh <node> 'agents run <agent> --json "<task>"'
  │     progress ◀── incrementally tail the REMOTE transcript file        [Phase 1]
  │          not the live SSH stdout pipe — the transcript on disk is the
  │          durable log. Offset-tracked reads, parsed by session/parse.ts.
  │
  └─ no prompt?                interactive TTY-forwarded path
        ssh -tt <node> 'agents run <agent>'   (only when local stdin is a TTY)
        remote agents-cli launches its normal direct interactive UI
        with tmux.enabled on: network drop (ssh exit 255) → auto-reattach the live remote pane;
        clean detach / agent exit → local CLI exits with that code
```

> Shipped surface: dispatch is `agents run <agent> ["<task>"] --device <name>`.
> With a prompt, the run is headless, follows live by default, and `--no-follow`
> detaches; track with `agents hosts ps` and `agents hosts logs <id>`. With no
> prompt (and a local TTY), the local TTY is forwarded over SSH and the agent runs
> interactively on the remote host (`ssh -tt`). The remote machine spawns it
> directly unless its device-local `tmux.enabled` setting opts into the wrapper.
> Host runs are tracked in a **local** task store, not `agents cloud` (a separate
> subsystem for Rush/Codex/Factory backends).
>
> **Surviving a network drop with tmux enabled.** A remote agent wrapped in a
> *detached* tmux session survives an SSH blink; a direct run does not. When a
> wrapped interactive host run has a known session id (Claude, or a
> `--resume`d run) drops (ssh reports its connection-layer code, 255), the local CLI
> **re-attaches the live remote pane automatically** — it drives the host's own
> `agents sessions focus <id> --local` over SSH, which JOINS the live pane when it
> survived and RESUMES the session in place when the pane is already gone (so a
> reattach landing after the pane died recovers the agent instead of dead-ending at
> a bare shell — RUSH-2085), with bounded exponential backoff (2s→30s, up to 6
> attempts; the budget refills after a genuinely live reconnection — one that
> reached the host **and** held the pane for at least 10 seconds). A clean detach
> (`Ctrl-b d`, exit 0) or a real agent exit (any non-255 code) is left alone, and
> `--raw`/no-tmux runs are not retried (they don't survive a drop). If every attempt
> fails the CLI prints the manual **`agents reconnect <id>`** to get back in once the
> link is back.
>
> **`agents reconnect [session-id]`** is the manual companion — one verb that always
> tries hardest to put you back into a dropped agent terminal: attach the live pane
> if it survived, else resume the session (best-effort: live pane > resumed copy > a
> clear message about what was lost). Use it after the auto-loop above gave up on a
> sustained outage, or when a VS Code terminal tab closed with the dead ssh client.
> With no id it reconnects the most recent session started from the current
> directory — the terminal that most likely just dropped — not the full fleet
> picker. It is also spelled `agents sessions reconnect`.
>
> The remote `agents sessions focus --local` invocation the reattach
> drives is wrapped so that whatever exit code it decides on, a 255 is remapped to
> 254 before this process sees it — so a remote-side path that happened to exit
> 255 for its own reasons would never be mistaken for the link dropping again.
> This closes a channel-level flaw (any future remote-side 255 producer would
> have been indistinguishable from a real drop) rather than a confirmed live bug.
>
> **A recurring *local* ssh failure is bounded too (#1884).** The retry budget
> refills only on a reattach that reached the host **and** held the pane for at
> least 10 seconds, timed on the attach alone (the reachability probe has already
> returned by then). A fast-flapping link — or an attach that dies at TTY
> negotiation on every reconnect — therefore drains the budget like an unreachable
> host instead of refilling it forever, and the loop gives up with a message that
> names what actually happened ("kept dropping again within 10 seconds of getting
> back in"), not the unreachable-host "couldn't reconnect". The floor is
> deliberately a *hold* requirement rather than a flat cap on total attempts: any
> fixed total would eventually strand the all-day-blinking session this feature
> exists for, while the hold floor only ever stops a loop that is failing to put
> you back into the agent.
>
> Pass `--name <slug>` at dispatch to give the run a durable handle instead of an
> opaque id: `agents hosts ps` shows it under a **NAME** column, and
> `agents hosts logs <name>` resolves by name (case-insensitive, newest-wins). The
> name also seeds the run's **session label**, so it shows up as `<name>` in
> `agents sessions` and `agents sessions <name>` resolves it. Omitting `--name` is
> a no-op — unnamed runs stay id-only, render `-` in the NAME column, and show the
> `[host/<name>]` tag as their session label.
>
> `agents hosts ps` re-probes each still-`running` task against the remote `.exit`
> marker so a finished (or crashed) run does not stay stuck at `running` after the
> local follower dies. `agents hosts stop <id>` (alias `kill`) terminates the
> remote process group from this machine, writes exit `143`, and keeps the log
> for `agents hosts logs <id>`.
>
> **Steering a detached dispatch.** `agents message <id|name> "<text>"` resolves a
> `--no-follow` dispatch the same way `agents hosts ps`/`logs` do (dispatch id,
> `--name` handle, or the remote agent's own session id) and reroutes the message
> over `--device` to the box that actually owns the live process — no need to know
> which host it landed on. A task that already finished fails loud naming its
> status instead of silently doing nothing.

### Host sources — owned (registered) + leased on demand (crabbox)

A "host" comes from one of two sources, but both reduce to **a named SSH target in
the registry**, so the dispatch path (§2–§4) is identical:

- **Owned, always-on** — your mac-mini, win-mini, DGX Sparks. You register them
  once in `agents.yaml` (§1); the `address` is a LAN host, a tailnet name, or a
  public host — whatever is SSH-reachable. Zero provisioning; they're just there.
- **Leased, on demand** — ephemeral cloud machines provisioned by **crabbox**,
  which is already installed and already a multi-cloud leasing layer:
  `--provider hetzner|aws|azure|gcp|proxmox|e2b|modal|sprites|daytona|…`
  (verified from `crabbox warmup --help`; AWS/EC2 is `--provider aws` with
  `CRABBOX_AWS_REGION` + spot/on-demand). Crucially, crabbox machines **join your
  tailnet** (`CRABBOX_TAILSCALE_AUTH_KEY`) and expose SSH (`crabbox ssh --id`),
  with idle-timeout/TTL auto-expiry (`CRABBOX_IDLE_TIMEOUT`, `CRABBOX_TTL`). So a
  leased box is the same kind of target as an owned one.

This is the answer to "I need machines but don't own enough": when the laptop is
starving, lease one.

```
agents run claude "big refactor" --on new           # crabbox warmup (default provider) → run → idle-release
agents run codex  "gpu eval"     --on new:aws        # provider/class selector → EC2 → run
agents run droid  "triage"       --on mac-mini       # owned, always-on
```

`--on new[:<provider/class>]` leases via crabbox, registers the leased box as a
**transient registry entry** (its `crabbox ssh` address), runs headless, and
releases on idle/TTL — tearing the entry down on release. agents-cli **does not**
reimplement provisioning — crabbox owns lease lifecycle, cost, and multi-cloud;
`hosts` owns *dispatch*. The overlap is deliberate: `crabbox run --provider ssh
--static-host mac.local` shows crabbox already unifies leased + static SSH targets;
we layer harness-agnostic agent dispatch + transcript-tail progress on top.

Open question (carried below): how thin is the crabbox integration — shell out to
the `crabbox` CLI (`warmup`/`ssh`/`stop`) and register the resulting SSH address,
or a tighter binding? (Leaning: shell out for lease/release, then the common
named-SSH dispatch path for everything else.)

### 1. Discovery — an explicit registry (metadata you write down)

The fleet is a curated `hosts:` map in `agents.yaml` — the few machines *you* own,
with the metadata a driver agent needs to choose one. There is **no auto-discovery
and no fleet enumeration**: nothing is contacted until you dispatch to a named
host, and only that host. This matches how the work actually flows — you (or your
driver agent) name a machine; we resolve its metadata and SSH to it.

```yaml
hosts:
  mac-mini: { address: mac-mini.local,            user: muqsit, os: macos }
  spark-0:  { address: spark-0.tailXXXX.ts.net,   user: muqsit, os: linux, caps: [gpu] }
  win-mini: { address: 100.84.x.x,                user: muqsit, os: windows }
```

`address` is **any SSH-reachable target** — LAN hostname, tailnet `.ts.net` name,
or public host. agents-cli does not care how it's reachable; it just runs SSH.
`caps`/`os` are free-form metadata for capability-based selection (e.g. a driver
agent routing a GPU eval to a host tagged `gpu`).

`agents hosts` is a thin layer over this map, stored via the existing atomic+locked
`readMeta`/`updateMeta` (`Meta` gains a `hosts?: Record<string, HostSpec>` field):

- `agents hosts add <name> <user@address> [--cap gpu] [--os linux]` — write an entry.
- `agents hosts list [--json]` — print the registry (name · address · os · caps).
  **No probing** — pure metadata, instant, machine-readable for the driver agent.
- `agents hosts check <name>` — the *only* command that touches the network: one
  SSH probe to that host → reachable? remote `agents --version` + `agents list`
  (which agents are installed). This is also what `ensureHostReady` calls before
  dispatch (lazy, single-host — never a fleet poll).
- `agents hosts remove <name>` / `agents hosts import --from-tailscale` (opt-in:
  prefill entries from `tailscale status` names; reads only, connects to nothing).

Resolution for an address goes through **one** resolver,
[`matchHost`](../src/lib/hosts/registry.ts) (RUSH-1967), shared by every caller —
`run --device`, the `sessions --device` fan-out, and `agents ssh` alike, so a token
can never dial two different boxes depending on which subcommand typed it. It
merges three directories **per-field**, it does not let one shadow another:

- the **devices** registry (`agents devices`) supplies address, OS, and presence
  — so the address is always live (`agents devices sync` takes effect without
  re-enrolling) and a stale enrolled snapshot can't freeze the route;
- the **agents.yaml** `hosts` overlay supplies capability tags and hints;
- **`~/.ssh/config`** supplies hosts Tailscale has never seen (dialed by their
  bare name, so ssh applies the stanza).

One grammar for every caller: `name`, `user@name` (login user overridden, same
box), a tailnet FQDN, an ssh_config alias, an ad-hoc `user@host`, and two reserved
sentinels — all resolve identically. The sentinels are `auto` (RUSH-2185:
`matchHost` resolves it via the same `resolveDeviceAffinity` engine `agents run
--device auto` uses, so `agents ssh auto` and `agents teams add --device auto`
pick a device the same way `run` does) and `interactive`, which resolves to the
device pinned as `interactive.host` — the box a human is sitting at, as opposed
to `auto`'s pick-by-load. `interactive` refuses rather than falling back to the
local machine when no host is pinned. Both names are reserved: a device cannot
be registered under either, and `interactive.host` cannot be pinned to one. `dispatchable` follows the device's auth method,
so a password-auth device can't be made dispatchable by shadowing it with an
inline entry. A bare unknown name resolves to nothing, which keeps
capability-tag routing (`--device gpu`) and the `agents ssh` "Unknown device"
verdict reachable. `agents ssh` additionally refuses an `auto` pick that lands
on the machine you're already on — dialing yourself isn't the useful outcome
`agents ssh auto` exists for — with a clear message instead of self-SSHing.

### 2. Transport — plain SSH (reuse, don't reinvent)

`src/lib/browser/drivers/ssh.ts` already has the whole pattern: `runSSHCommand`,
`shellQuote`, `startSSHTunnel`, `ensureRemoteBrowser`, with
`StrictHostKeyChecking=accept-new`, `BatchMode=yes`, `ConnectTimeout` (verified at
`ssh.ts:132-137`). Note: only `shellQuote` is currently `export`ed; `runSSHCommand`
/ `startSSHTunnel` / `ensureRemoteBrowser` are module-private, so step one is a
small lift — extract the ssh-exec primitive into a shared helper both the browser
driver and `src/lib/hosts/dispatch.ts` import (no behavior change). `dispatch.ts`
then calls it to run the remote command and inherit stdout/stderr/exit. SSH is the protocol — it gives auth + transport +
stream + exit code; no custom `command_output`/`command_done` framing (which is
what the rush daemon had to invent over its WebSocket).

Auth: your existing SSH keys, or a per-device private key configured with
`agents devices config <name> ssh.identity-file <path>`. The configured
path is passed to every OpenSSH connection for that device. If a host is reachable only
over a tailnet, the registered `address` is its tailnet name and SSH rides it
transparently — no Tailscale-specific code path. (Tailscale SSH / ACL-tag auth
works too, since it's still `ssh <address> <cmd>` under the hood, but it's not
required and not assumed.)

#### Windows OpenSSH key enrollment

`agents doctor` audits Windows key enrollment without reading or printing a private
key or password. It asks `sshd -T` for the effective `AuthorizedKeysFile`, checks
that the selected file exists and contains a public-key record, and inspects its
ACL. Administrator accounts use
`C:\ProgramData\ssh\administrators_authorized_keys`; normal accounts use
`%USERPROFILE%\.ssh\authorized_keys`. The administrator file must grant
`FullControl` to `SYSTEM` and `Administrators` and no unrelated principal.

Enroll or rotate by writing the replacement **public** key to the effective file,
then restore those ACLs and run `agents doctor` again before removing the old key.
Revoke by deleting that public-key line. If key auth is already locked out, recover
through the Windows console or a separately configured password-auth device profile,
repair the effective file and ACL, then return the device to key auth. Doctor is
read-only: it diagnoses these states but never requests credentials or changes the file.

### 3. Execution — remote `agents run` (harness-agnostic)

Host dispatch has two shapes, chosen by whether a prompt is present:

- **Headless** (`agents run <agent> "<task>" --device <h>`): the remote command is
  `agents run <agent> "<task>" --json` (+ `--mode`, `--model`, `--quiet`). The local
  CLI launches it detached, then incrementally tails the remote transcript.
- **Interactive** (`agents run <agent> --device <h>`): the remote command is
  `agents run <agent>` with no prompt and no `--quiet`; the local CLI forwards its
  TTY over SSH (`ssh -tt`) so the remote agent starts its normal interactive UI.
  The tmux wrapper runs on the remote machine, exactly as it would if you had
  SSH'd in and typed `agents run <agent>` yourself. Passing both a prompt and
  `--interactive` with `--device` also takes the interactive path and forwards the
  prompt to the remote TUI.

Headless dispatch supports Linux, macOS, and Windows OpenSSH hosts. Windows uses
a hidden detached PowerShell process plus the same durable per-task log and exit
sentinel as POSIX hosts; follow, reconnect, `hosts logs`, `hosts ps`, and
`hosts stop` select the matching remote protocol from the task record.

(`--json`/`--quiet`/`--mode`/`--model` are real flags on `agents run`, registered in
`src/commands/exec.ts`; there is no user-facing `--print` — the per-harness
headless/`--print` mapping is internal to `buildExecCommand`.) `agents run` already
produces the right headless or interactive argv per harness via
`buildExecCommand` (`src/lib/exec.ts`), so **every harness, mode, and
secret-injection path works remotely for free** — provided agents-cli + that agent
are installed and authed on the box, which `ensureHostReady` / `agents hosts check`
guarantee (see Context, below).

**Working directory on the host.** The remote command is prefixed with a
`cd <dir> &&` computed from the run's flags (see `remoteCdPrefix`,
`src/lib/hosts/dispatch.ts`):

- `--cwd <dir>` sets the host working directory. A home-anchored path (`~/…`,
  `$HOME/…`, or a local-home absolute the local shell already expanded) is
  re-rooted at the **remote** `$HOME`, so it resolves across machines with
  different homes (`/Users/me` → `/home/me`). Resolution happens locally: the
  forwarded argv is still a plain `agents run <agent> …`.
- `-P, --project <slug>[@worktree]` resolves `<slug>` against your projects root
  (auto-inferred from the launch repo and cached in `agents.yaml`; set via
  `agents config set project.root <path>`) and lands on the host home-relative
  (`~/…`), so the host expands it to its own home. `@worktree` targets
  `<repo>/.agents/worktrees/<worktree>`.
- `--remote-cwd <dir>` is the explicit escape hatch — a literal remote path used
  verbatim (never re-rooted). Precedence: `--remote-cwd` > `--project`/`--cwd`;
  `--project` is mutually exclusive with `--cwd`/`--remote-cwd`.
- **With none of them, the run mirrors your local cwd** (`deriveMirroredCwd`): a
  cwd under the local home is re-rooted onto the remote home, so launching from
  `~/src/x` lands the agent in the host's `~/src/x` rather than its bare `$HOME`.
  This is the fleet layout where every box holds the same checkout at the same
  home-relative path. A mirror is best-effort — a host without that directory
  falls back to its home rather than failing the run — whereas an explicit
  `--cwd`/`--remote-cwd` you named is never softened: a missing one fails the
  `cd`. A cwd outside the local home is not mirrored at all, since a path like
  `/opt/thing` says nothing about the target's filesystem.

Workspace (where the run executes) is a deliberate scoping choice — see Open
Questions. Phase 1 default: a caller-specified `--remote-cwd` (or the repo's
existing checkout on the box). The rush per-task git-worktree workspace
(`rush/cli/internal/daemon/workspace.go`: warm clone + `git worktree add
--detach` + secret denylist + PATH shim) is the model to port **later** if we
want isolated, repo-URL-driven runs.

### 4. Progress — incrementally tail the remote transcript (the key idea)

Streaming raw SSH stdout ties progress to the live pipe: drop the connection and
you lose the run's visibility. Instead, lean on the fact that **every agent already
writes a JSONL transcript to disk** (Claude/Codex/Gemini/Droid/…), and agents-cli
**already parses those** (`src/lib/session/parse.ts`: `parseClaude`, `parseCodex`,
`parseGemini`, … → `SessionEvent[]`; locations via
`session/discover.ts:getAgentSessionDirs`).

So host progress = **tail the remote transcript file, offset-tracked**, parse the
new lines, render with the existing `SessionEvent` pipeline. This is the same shape
as `session/active.ts:200-248`, which already does offset reads
(`fs.readSync(fd, chunk, 0, chunkSize, totalRead)`) rather than re-reading the
file or scanning the directory.

Mechanics:
1. Resolve the run's transcript path on the remote (agent + session id; `agents
   run --json` surfaces the session id, or we derive it from the agent's dir).
2. Poll cheaply over SSH from a byte offset — `ssh <node> "tail -c +<offset>
   <file>"` (or `dd`/`stat` for size), keeping a per-run `{file, offset}` cursor.
3. Feed new bytes to the matching `parseX` function; render incrementally.
4. Reconnect = resume from the saved offset. No live-pipe dependency.

This is precisely the user's "use the session parser, read updates from the file,
efficiently — like the ssh/remote-browser pattern."

### 5. Scheduling — falls out of the existing daemon

Scheduled fleet dispatch needs **no new machinery**: the routines scheduler
(`src/lib/daemon/daemon.ts`) fires jobs on cron; a job whose command is `agents run …
--on <host>` is a scheduled remote dispatch. Online-gating is the same lazy SSH
probe `ensureHostReady` already does (skip/retry if the one targeted host is
unreachable) — no fleet poll. (We do **not** turn the scheduler into an RPC
server — see Non-goals.)

### 6. Tracking — reuse the cloud store (Phase 1.5)

To make `agents cloud list/status/logs` show host runs alongside cloud runs, add a
thin `host` entry to the cloud provider model that records `{host, agent, prompt,
transcriptPath, offset, status}` in the existing SQLite store
(`src/lib/cloud/store.ts`) and streams via the transcript tailer above. This makes
"fleet observability" free and unifies the dispatch surface.

## Context — what travels to the host (and what doesn't)

An agent host is useless until the user's context is on it — but "sync everything"
is the wrong instinct. The `.history` tree (versions, runs, sessions, backups) is
large and almost all of it is irrelevant to any one task; bulk-copying it would
*recreate the exact filesystem/IO storm the incident was about*, just on a second
machine. The right model decomposes context into four layers, each carried by a
mechanism that **already exists** — there is no new "sync engine":

| Layer | How it gets there | Mechanism (today) |
|---|---|---|
| **`~/.agents` config** (commands, skills, hooks, memory) | The DotAgents user repo is git-backed — the box runs `agents repo pull user` (or `git pull`). One-time/idempotent bootstrap, **not** a per-dispatch push. | `agents repo pull user`; bootstrapped + verified by `ensureHostReady` / `hosts check` |
| **Working codebase** | Phase 1: committed branch → `git fetch` + checkout on the box (per-repo, caller's `--remote-cwd`/`--branch`). Phase 2: uncommitted working tree → `rsync` over SSH (the differentiator). | per-repo git; rsync (Phase 2) |
| **Secrets** | Persistent boxes self-auth once via `agents secrets` (keychain). Blank/leased boxes get an on-demand, never-on-disk injection. | `agents secrets export <bundle> --to-ssh --device <t>` (`secrets.ts:1089-1097`, env over ssh stdin) |
| **Sessions / `.history`** | **Not bulk-copied.** Recall is exposed as a *remote command*, not a file sync (below). | the routines daemon + `agents sessions`; selective `session/sync/` for the rare "make this transcript present" case |

### `ensureHostReady(name)` — the Phase 1 readiness precondition

Before dispatch, ensure the box can actually run the agent. This replaces the
heavier "syncContext" idea — most of it is already solved by git + the existing
sync substrate, so the precondition is thin and mostly one-time/cached:

1. **agents-cli present** — `hosts check` already probes `agents --version`; if
   absent, bootstrap (mirror `scripts/sandbox.sh:218-239`).
2. **Config current** — `agents repo pull user` on the box so `~/.agents` matches (git-backed;
   cheap, idempotent).
3. **Agent installed** — remote `agents view --json` (fallback: `agents list`)
   confirms the requested harness exists. A **concrete version pin**
   (`agents run codex@0.145.0 --device <box>`) is checked against that listing and
   **fails loud** when the pin is missing — naming the box, the missing pin, what
   *is* installed, and the install command — so a detached `--no-follow` dispatch
   never prints `Dispatched` for a pin the box cannot run (RUSH-2313). Aliases
   (`@latest` / `@oldest` / `@pinned`) still resolve on the remote. A bare agent
   name (no pin) keeps the soft warning.

   The dispatched `agents run` on the box is the backstop for that soft warning:
   it probes the executable it is about to spawn and exits `1` with
   `agents: <agent> is not installed on this machine.` plus the
   `agents add <agent>` fix. Before RUSH-2339 it execed the bare `cliCommand`
   instead and died as `sh: 1: exec: cursor-agent: not found` (exit 127), behind
   a `⚠ <agent> looks logged out` banner that was also wrong — the harness was
   absent, not signed out. The probe is **existence**, not "does agents-cli
   manage a version" (`resolveLaunchBinary`, [`src/lib/exec.ts`](../src/lib/exec.ts)):
   a harness the user installed themselves (Homebrew, a vendor `curl | sh`, a
   distro package) has no version home on the box and still launches, resolved
   through PATH exactly as `spawnAgent` would. The PATH lookup skips the
   agents-cli shims dir, so a dispatcher shim planted for an absent harness is
   never mistaken for an install.
4. **Codebase present** — the target repo/branch is checked out at the run cwd
   (`git fetch` + checkout; no working-tree copy in Phase 1).

It does **not** copy `.history`, and it does **not** push secrets unless asked —
persistent hosts are authed once, out of band.

### Session recall is recall-as-RPC, not recall-as-copy

The killer detail: you almost never want another machine's `.history` *on disk* —
you want to *query* it. The routines daemon can already run commands on a host, so
recall becomes a remote call:

```
agents hosts sessions <box> --search "<topic>"   # runs `agents sessions` ON the box, returns hits
```

The agent on box A searches box B's history without ever copying it — the same
"expose a capability over the daemon" shape this design uses for dispatch. For the
narrow case where a transcript must actually be *present* on the target (resume /
handoff), `agents sessions migrate` (shipped since this doc was written) ships
**that one session** selectively over the direct SSH transport
(`resolveExplicitTargets` + `ssh-exec`) — never the whole tree, and no R2/CRDT
substrate (that background-sync mechanism this doc originally cited has since
been removed; see [sessions.md](sessions.md#migration-relocate-a-live-session)).

## Phase 2 — session handoff (the differentiator)

`agents run --resume <session-id> --on <host>` — move a live session, *including
uncommitted work*, to another box and continue:

1. **Code**: push/sync the git branch; **`rsync` the working tree** (uncommitted
   included) over SSH — the thing the cloud tools can't do.
2. **Conversation**: ship the transcript. `agents sessions migrate` already does
   this over a direct SSH hop (`resolveExplicitTargets` + `ssh-exec`) — the R2/CRDT
   background-sync substrate this section originally proposed reusing has since
   been removed; the direct-transport path is the one that shipped.
3. **Resume**: `agents run <agent> --resume <session-id>` on the target.
4. **Relay/attach mode**: attach to a still-running remote session by tailing its
   transcript (Phase 1 §4) and sending follow-ups over SSH — the "remote-control"
   UX, built on the *existing* daemon, not a new one.

Honest hard parts (consistent across the whole field): model/provider continuity
and concurrent-session collisions on one branch. Secrets are handled by the Context
model above (persistent hosts self-auth; blank/leased hosts take an on-demand
`secrets export --to-ssh` injection) — not an unsolved wall, but the bundle must
exist on or be pushed to the target. The doc will spell these out before Phase 2
implementation.

## Non-goals / what we explicitly will NOT build

- **No broker / relay / connection-registry / heartbeat service.** The registry is
  a local list; reachability is the host's own network (LAN/VPN). No central
  service, ever.
- **No discovery / fleet enumeration.** We never scan a network or call `tailscale
  status` to find machines. The registry is hand-maintained (with an opt-in
  `import --from-tailscale` prefill); only the targeted host is ever contacted.
- **No Tailscale dependency.** A tailnet is a fine transport if you use one (just
  register the `.ts.net` address), but agents-cli neither requires it nor knows
  about it — SSH to an address is the whole contract.
- **No provisioning engine.** crabbox already leases across Hetzner/AWS/Azure/GCP/
  e2b/modal/… `hosts` shells out to crabbox for lease/release and registers the
  resulting SSH address as a transient host. We do not reimplement multi-cloud
  provisioning, cost, or lifecycle.
- **No new daemon.** Phase 2 relay/attach expands the existing routines daemon;
  it does not add a second long-running process.
- **No custom wire protocol.** SSH + on-disk transcript are the protocol.
- **No VM snapshots.** `rsync` over SSH replaces Devin-style block-diff for our
  single-tenant case.

## Design constraints carried from the incident

The Resource Report is also a list of things the remote run must NOT do (or it
just relocates the storm):

- **Headless by default** — `agents run --json` when a prompt is supplied.
  Progress is summarized state from the transcript, not a live char stream.
  Interactive TTY forwarding is supported only when no prompt is given
  (`agents run <agent> --device <h>`), so the user can drive the remote agent
  directly; the remote machine still owns the actual session and tmux wrapper.
- **Bound concurrency** — cap simultaneous agents per host; a host's value is
  finite coordination capacity, not infinite parallelism.
- **No unbounded recursive scans** — the incident's trigger was `rg --no-ignore
  --follow` over `.agents/worktrees` + `.gocache`. Remote workspace setup must
  respect ignore boundaries and avoid scanning generated/worktree trees.
- **Don't sync junk** — a working-tree `rsync` (Phase 2) must exclude
  `node_modules`, `.gocache`, build caches, nested worktrees.

## Resolved decisions

- **Pluggable `HostProvider` seam** — the directory/metadata/reachability layer is a
  capability-gated provider (mirrors `CloudProvider`). v1 ships **only `local`**;
  `rush`/`tailscale`/`crabbox` are additive fast-follows behind the same contract.
  This is the "open & general-purpose" decision — anyone can swap in their own
  metadata/network backend.
- **v1 = `local`, no Rush dependency.** No `rush login`, no daemon, no account.
  Registry is a `hosts:` map in `agents.yaml`; reach is SSH. The Rush `computers`
  backend (cross-device sync + presence + relay) is real but its benefits are
  conditional — deferred to the `rush` provider, which the seam makes free to add
  later (see "Why `local` first").
- **Discovery** — an **explicit registry**, not network enumeration. No fleet scan;
  only the targeted host is contacted, and only at dispatch. Tailscale is **not** a
  v1 dependency — it's a future `HostProvider`, and an opt-in `import
  --from-tailscale` can prefill `local` entries.
- **Driver-agent first.** The primary caller is a conversational driver agent that
  reads the registry metadata (`agents hosts list --json`), picks a host by
  task/capability, and dispatches (`agents run --on <name> --json`). The VS Code
  extension is a second front-end onto the same commands. So Phase 1 prioritizes
  clean, deterministic, machine-readable `--json` on `hosts list` and `run --on`.
- **Naming** — `agents hosts` (list/check/add/remove) + `agents run --on <host>`.
  (The singular `agents computer` macOS-accessibility command is unrelated, stays.)
- **Provider model** — keep named-SSH dispatch as its own clean path; fold *tracked*
  host runs into the existing cloud store as a `host` provider so `agents cloud
  list/status/logs` see them (§6). No big `CloudProvider → AgentHostProvider`
  rename — observability is unified without it.
- **Context** — no bulk `.history` sync; `ensureHostReady` + recall-as-RPC over the
  daemon (see Context). Config via git, codebase via branch (P1) / rsync (P2),
  secrets via self-auth or `--to-ssh`.

## Open questions (decide before Phase 1 build)

1. **Workspace model for Phase 1** — caller-specified `--remote-cwd` only, or port
   the rush git-worktree workspace now? (Leaning: `--remote-cwd` first, worktree as
   a fast follow.)
2. **Windows targets** — `win-mini` over SSH: do remote `agents run` semantics hold
   on Windows (shims, paths)? Needs a verification pass.
3. **Capability routing** — should `--on` accept a capability selector (e.g. `--on
   gpu`) that resolves to a registered host tagged `gpu`, not just an exact name?
   (This is the driver-agent's main convenience; leaning yes, thin — filter the
   registry by `caps`, error if 0 or >1 match unless `--any`.)
4. **Enrollment scan sources for v1** — `~/.ssh/config` Host blocks + `known_hosts`
   (leaning both); LAN scan (mDNS/ping) deferred as noisier/more code.
5. **Concurrency cap** — default max simultaneous agents per host (the incident
   says "bound it"); per-host override in the `hosts:` map?

## Phasing & verification

- **Phase 1 (v1, no Rush)**: the `HostProvider` seam + the **`local`** provider only.
  `agents hosts add/list/check/remove` (registry in `Meta.hosts`; `add` scans SSH
  sources + `checkbox` multi-select enroll, ensures key auth, bootstraps/upgrades
  agents-cli to match the local version) + `agents run --on <host>` →
  `ensureHostReady` (lazy SSH probe + config/agent/branch) → remote `agents run
  --json` → transcript-tailed progress + a `host` row in the cloud store. Verify
  end-to-end against the live peer node `yosemite-s1`, registered from `yosemite-s0`:
  dispatch a trivial task, confirm it executed *off-box*, see live progress via the
  transcript tailer, correct exit code. No account, no daemon.
- **Phase 1.5 (fast-follows, behind the seam)**: the `rush` provider (account-keyed
  `computers` registry + presence + relay-exec, opt-in when `rush login` exists),
  the `tailscale` provider (presence/reachability without an account), and recall-as-
  RPC (`agents hosts sessions <name>`).
- **Phase 2**: the `crabbox` provider (lease → register → run → idle-release) and
  `--resume … --on` handoff (branch + working-tree rsync + transcript sync + resume)
  + attach/relay mode on the existing daemon.

## Key files (reuse map)

| Need | Existing code to reuse |
|---|---|
| SSH transport | `src/lib/browser/drivers/ssh.ts` (`shellQuote` exported; `runSSHCommand`/tunnels private — extract a shared ssh-exec helper) |
| Host registry storage | `src/lib/state.ts` (`readMeta`/`updateMeta`, atomic+locked) + `Meta.hosts` (new field) |
| Headless argv per harness | `src/lib/exec.ts` (`buildExecCommand`) + `agents run` (`src/commands/exec.ts`) |
| Transcript parse → events | `src/lib/session/parse.ts` (`parseClaude`/`parseCodex`/…) |
| Incremental offset read | `src/lib/session/active.ts:200-248` |
| Per-agent transcript dirs | `src/lib/session/discover.ts:getAgentSessionDirs` |
| Cross-machine transcript transport | `src/commands/sessions-migrate.ts` (direct SSH, shipped) — the CRDT G-Set / R2 background-sync substrate this row originally named has been removed |
| Scheduling | `src/lib/daemon/daemon.ts` (routines scheduler) |
| Task tracking store | `src/lib/cloud/store.ts` (free-text `provider`, reserved `provider_data`) |
| Config schema | `src/lib/types.ts` (`Meta`) + `src/lib/state.ts` (`readMeta`) |
| Config bootstrap on host | `agents repo pull user` (git-backed) + `scripts/sandbox.sh:218-239` |
| Secret injection (on demand) | `src/commands/secrets.ts:1089-1097` (`--to-ssh`, env over ssh stdin) + `SSH_TARGET_RE`/`assertValidSshTarget` (`secrets.ts:189-195`) |
| Selective transcript replication | `src/lib/session/sync/agents.ts` (per-agent mirror layout, per-session not whole tree) |

## Prior art studied

- rush "computers": `rush/cli/internal/computer/` (model/fingerprint),
  `rush/cli/internal/daemon/workspace.go` (warm clone + worktree + env denylist),
  `prix/api/src/computers/relay.ts` (the WebSocket relay we deliberately drop).
- Field survey + citations: see the research links inline above (Codex, Cursor,
  Devin/blockdiff, Factory, Jules, Anthropic Managed Agents, Claude Remote
  Control/Teleport, Tailscale LocalAPI/SSH/tsnet).
