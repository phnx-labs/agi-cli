<!-- guide -->
# SSH transport — one multiplexed engine (design decision)

> Status: **accepted** · Related: [hosts.md](hosts.md), optimizations.md, [concepts.md](concepts.md#devices--hosts)

A design record for *how `agents` talks to remote machines over SSH*. Every
remote surface — `run --device`, `view/usage/cost/doctor/inspect/list/sync --device`,
`sessions -D`, `teams … --device`, remote `secrets`, the browser CDP tunnel — moves
bytes over the system `ssh`. This doc pins down the one transport they all share,
and why it is a set of shared primitives rather than a daemon.

## Context

The fleet is driven from a laptop — frequently an 8 GB MacBook — that fans out to
Macs, Linux boxes, and a Windows mini over Tailscale. The scarce resource is not
the remote machine's CPU. It is **local**: every `ssh` the CLI forks is a process
in the laptop's table, a TCP socket, an ephemeral port, and a full public-key
handshake against the laptop's kernel and CPU. A transport that reopens a
connection per logical operation turns a quiet "watch this run" into thousands of
handshakes an hour on the one machine the user is actually sitting at.

The transport already funnelled through a single hardened choke point,
`sshExec`/`sshStream` in [`src/lib/ssh-exec.ts`](../src/lib/ssh-exec.ts), and
OpenSSH connection multiplexing (`ControlMaster`) was already implemented there.
The problem was that it was **opt-in** and almost nobody opted in.

## Goals / non-goals

**Goals**

- One connection strategy for every remote surface, defined in one place.
- Minimize *local* cost: process spawns, sockets, handshakes, zombie connections.
- No new always-on service, port, or protocol to run on every Mac and Linux box.
- No behavior regressions; multiplexing must never make a reachable host unreachable.

**Non-goals**

- A bespoke agent/relay daemon (see [Alternatives](#alternatives-considered)).
- Parallelizing the multi-host fan-out (it is deliberately serial — one `ssh`
  alive at a time is memory-safe on a small laptop; latency is the accepted cost).
- Changing the detached-dispatch model (`nohup` + offset-tail) that lets a remote
  job survive a dropped connection — that design is orthogonal and stays.

## The problem, with evidence

Multiplexing was gated behind `multiplex: true` and only 3 of ~13 call paths
passed it. The un-multiplexed callers were precisely the hot ones:

| # | Where | Cost before |
|---|---|---|
| P1 | `followHostTask` ([`progress.ts`](../src/lib/hosts/progress.ts)) — the poll behind every `run --device` / `teams … --watch` | **2 un-muxed ssh / 1.5 s ≈ 4,800 process spawns/hour**, per followed job |
| P2 | `ensureHostReady` ([`ready.ts`](../src/lib/hosts/ready.ts)) — runs before every dispatch | **3 sequential connections** (reachable + version + agent listing), 2 un-muxed |
| P3 | `sshExec`/`sshStream` default | multiplexing opt-in; the common paths skipped it |
| P4 | `runRemoteSessions` ([`session/remote/remote.ts`](../src/lib/session/remote/remote.ts)) | a **private copy** of the ssh options with no multiplexing |
| P5 | secrets push, the `-N` tunnel, and other direct `spawn('ssh')` sites | bypass the choke point; some under-specified (no `ConnectTimeout`) |
| P6 | `devices add` / host enrollment ([`lib/hosts/registry.ts`](../src/lib/hosts/registry.ts)) | a duplicate reachability probe |
| P7 | `SSH_OPTS` | no keepalive — a dropped link hangs instead of dying |

## Design

The transport is **two shared primitives, and everything composes from them.**

### 1. One hardened baseline: `SSH_OPTS`

```
StrictHostKeyChecking=accept-new   BatchMode=yes   ConnectTimeout=10
ServerAliveInterval=15   ServerAliveCountMax=3          ← keepalive (P7)
```

Every `ssh` in the codebase composes this list — directly through
`sshExec`/`sshStream`, or as `[...SSH_OPTS, …extra]` in the handful of callers
that need `-L`/`-N`/`ProxyCommand`. The keepalive means a silently-dropped
connection (laptop sleeps, Wi-Fi flips) is detected and the `ssh` process exits
within ~45 s (`15 × 3`) instead of pinning a zombie process + socket on the
laptop. Long-lived `-N` tunnels inherit it by composing the same baseline.

### 2. One multiplex helper: `controlOpts()`, default-on

```
ControlMaster=auto   ControlPath=~/.agents/.cache/ssh/cm-%C   ControlPersist=600s
```

The first connection to a host opens a control socket; every later connection —
even from a *separate* `agents` invocation — rides it, skipping the TCP+auth
handshake. This is now the **default** (`opts.multiplex === false ? [] :
controlOpts()`); a caller opts *out* only for a genuine one-shot where a lingering
master is pure overhead. The persist window is **10 minutes**
(`SSH_CONTROL_PERSIST_SECONDS`), sized to span the gap between repeated ad-hoc
`--device` / fan-out touches of the same box (`sessions --active`, `fleet ping`,
`doctor`, `teams`, a `--device` command run a few times while working), which
arrive in bursts over minutes rather than on a fixed clock — at the old 60 s
window any two more than a minute apart were both cold, so a burst paid a fresh
handshake almost every time (PHNX-2582). It stays bounded at 10 min because a
master reused after a host sleeps costs a ~45 s ServerAlive teardown. The
15-minute `usage-sync` daemon service now uses one serialized, hard-bounded Git
remote exchange for the fleet-synced user-repo mirror and opens no
device-to-device SSH mesh; `auth-sync` opens a fresh, non-multiplexed connection only for
a peer whose shared verdict says the reserved bundle is missing, with an async
20-second operation deadline and hard-kill grace. Flipping this one default is what fixes P1's poll,
P2's probes, and P4's fan-out at once — they already routed through the engine and
simply started reusing sockets. It degrades safely: if the socket can't be opened
ssh falls back to a fresh connection, and on Windows (no `ControlMaster`) the
helper returns `[]`.

### 2b. Host-key pinning: a managed `known_hosts` (RUSH-1767)

`accept-new` in the baseline is trust-on-first-use: it silently accepts whatever
key answers on the first connect and never re-checks it, so a
machine-in-the-middle present in that window is trusted forever. The CLI keeps its
own `known_hosts` store — `~/.agents/.cache/devices/known_hosts` (mode 0600),
separate from `~/.ssh/known_hosts` — so a device's key can be *pinned*
([`known-hosts.ts`](../src/lib/devices/known-hosts.ts)):

```
UserKnownHostsFile=<managed store>   StrictHostKeyChecking=yes   ← once pinned
UserKnownHostsFile=<managed store>   StrictHostKeyChecking=accept-new  ← first connect
```

`agents ssh <device>` learns the key on first connect (`accept-new`, written into
the managed store) and verifies it with `StrictHostKeyChecking=yes` on every
subsequent connect — a later key swap is refused, not re-accepted. Native OAuth
and session credentials never cross this transport: `run --device --copy-creds`
is retained only as a fail-loud deprecated flag. Explicit portable provider
account sync (`agents accounts sync <account> --device <device>`) requires the destination
to already be present in the managed store and uses a fresh, non-multiplexed SSH
connection. A registered device earns its pin by connecting once with
`agents ssh <device>` and verifying the host before syncing an account.
**Remaining:** the broad `accept-new` baseline still governs
non-credential fan-outs (`sessions --device`, the browser driver, `fleet run`),
which still use OpenSSH default `~/.ssh/known_hosts`, not the managed store, so
they neither pin into it nor verify against it. Wiring those call sites onto the
managed store (so they verify strictly too) is follow-up.

### 2c. One resolver: a token → the same target string everywhere (RUSH-1967)

Multiplexing (§2) only reuses a socket when two calls hand `ssh` the **same
target string** — `%C` hashes local-host/remote/port/user, so `mac-mini`,
`muqsit@mac-mini.<tailnet>.ts.net`, and a stale `~/.ssh/config` LAN IP for the
same box each hash to a different `cm-%C` socket and never share the master. A
`--device` token therefore has to resolve to one canonical target no
matter which subcommand typed it.

It used to resolve through **two** disagreeing chains: a local-provider-first
`resolveHost` (`run --device`, the generic passthrough, teams placement, doctor,
funnel, remote secrets) and a devices-only `resolveSshTarget` (`sessions --device`,
session bundles, `agents ssh`). They emitted different strings for the same
machine — `resolveHost` let an ssh-config stanza win and dialed its bare name,
while the devices chain dialed the Tailscale `user@dnsName` — so the two never
shared a `%C` socket and could even dial two different boxes.

Both are now one core, [`matchHost`](../src/lib/hosts/registry.ts). It merges the
directories **per-field** instead of letting one provider shadow the other:

| Field | Source of truth |
|---|---|
| address, OS, presence, dispatchable | the live **devices** registry |
| capability tags, OS hint (when the device platform is unknown) | the agents.yaml **overlay** |
| a host Tailscale never saw | **ssh_config** (dial the bare name; ssh applies the stanza) |

One grammar for every caller — `name`, `user@name`, a tailnet FQDN, an ssh_config
alias, and a literal `user@host` all resolve identically. `resolveHost` (dispatch),
`resolveExplicitTargets` (fan-out), and `resolveDeviceTarget` (`agents ssh`) are
thin wrappers that differ only in the shape they return and which literal
fallbacks they permit. Because the address always comes from the live registry,
`agents devices sync` takes effect without re-enrolling, and a password-auth
device can't be made dispatchable by shadowing it with an inline entry.

### 2d. Interactive login mirrors the caller's project directory (RUSH-2412)

`agents ssh <device>` with **no command** lands you in the same home-relative
directory you launched from, when that checkout exists on the target — the same
portable-cwd rule `agents run --device` already applies. From
`~/src/app` on the laptop, `agents ssh yosemite-s0` starts the remote login shell
in `~/src/app` on yosemite-s0; when that path is absent it falls back to the
remote home, and the login always succeeds.

There is **one** resolver behind both surfaces. The caller cwd becomes a portable
`~/…` path with [`deriveMirroredCwd`](../src/lib/project-root.ts) (only a path
under the local home has a meaningful remote analogue; anything else mirrors
nothing and keeps the remote home). For POSIX targets the interactive-login
builder [`buildInteractiveShellCommand`](../src/lib/devices/connect.ts) reuses the
same best-effort [`remoteCdPrefix`](../src/lib/project-root.ts) mirror `--device`
runs use — `{ cd "$HOME"/<dir> || cd "$HOME"; } &&` — then `exec "$SHELL" -l` so
prompt, startup files, and login behavior match a plain `ssh <host>`.
`"$HOME"` stays unquoted so the *remote* shell expands it (the target home may
differ, `/home/<me>` vs `/Users/<me>`), and the remainder is shell-quoted, so a
path with spaces or metacharacters is literal and injection-safe. PowerShell
targets get a profile-loading interactive shell (`-NoExit`) that `Set-Location`s
into the mirrored dir when `Test-Path` confirms it, with the path carried through
`-EncodedCommand`. The `-tt` forced tty that makes an interactive login work is
allocated whether or not a mirror command is injected.

An **explicit** `agents ssh <device> <cmd…>` is unchanged: the command keeps the
remote home and its cwd is never silently rewritten — mirroring is interactive-
login-only.

### 2e. Exact argv delivery: `--argv` (PHNX-3999)

`wrapRemoteCommand` joins the command tokens with a space, and that is deliberate
for the ordinary path: `agents ssh box 'bash -lc "cd x && make"'` arrives as ONE
token whose pipeline, globs and redirections the peer's login shell must expand.
Quoting it would ship the whole line as a single literal argument and break every
caller that relies on that.

But a caller holding a real argv **array** needs the opposite guarantee, and the
raw join destroys it: `['--title', 'two words']` arrives as three arguments, and
`'a & b'` arrives as a backgrounded command. So exact delivery is opt-in at the
call site that knows which shape it has:

```bash
agents ssh box --argv '["agents","feed","post","--title","two words","a & b"]'
```

- Each array element is delivered as **exactly one token** on the peer.
- Mutually exclusive with the positional form — passing both is an error rather
  than a silent precedence rule, because the two are different delivery contracts.
- Malformed JSON, a non-array, and a non-string element each fail loud naming the
  problem, so a typo cannot quietly downgrade to shell-string semantics.

Quoting reuses the existing helpers: `shellQuote` for POSIX, and `pwshQuote` for
PowerShell, whose single-quote doubling is total over every byte (including `$`,
backtick and newline) before `encodePwshBase64` encodes the script. **On PowerShell
the script is led by the call operator `&`** — without it, pwsh evaluates a quoted
program name as a string expression and echoes it instead of running anything.

**Provenance is a prelude, never part of the argv.** `fleetRemotePrelude` emits the
`AGENTS_FLEET_REMOTE` marker plus the caller's actor as ready shell syntax — a
POSIX `K=V` pair is already `shellQuote`d and a PowerShell assignment is a complete
statement. Those tokens are composed around the quoted argv rather than mixed into
it: quoting them a second time turns `'AGENTS_ACTOR=Some Name'` into escaped
garbage and turns a pwsh assignment into an inert string literal. `markFleetRemote`
(the array-prefixing form the `--device` passthrough uses) shares that one prelude
definition, so the two paths cannot drift.

### 3. The follow loop: one persistent stream (P1)

The original loop made two calls per cycle — `tail -c +offset` for new log bytes,
then `cat .exit`. PR #551 first rewrote that to a single round-trip:

```
tail -c +<offset> <log>;  printf '<sentinel>';  cat <exit>
```

`splitProgressBytes` splits the response on the **last** occurrence of a
per-task sentinel (`@@AGENTS_HOST_EXIT_<taskId>@@`), so the log tail, an end
marker, and the exit code come back together and are separated without ever
miscounting the byte offset (the marker and exit bytes come from `printf`/`cat`,
never the log). Splitting on the *last* marker means even if the agent's own
output echoed the token, the real trailing sentinel still wins. The sentinel's
`printf` format is derived from the same `exitMarker()` the parser uses, so the
two can never desync. That helper remains for non-interactive consumers that need
a bounded poll.

The interactive follow path now uses one long-lived stream:

```
tail -c +<offset> -f <log>        # stdout: raw log bytes
watch <exit>; printf <sentinel>; cat <exit> >&2
```

Stdout is pure log data, so the local follower can echo and mirror chunks as soon
as they arrive. The terminal frame rides stderr after the remote watcher sees a
non-empty `.exit`; the local parser extracts the exit code from that frame. If
the ssh stream drops before the frame, the follower reconnects from the byte
offset already flushed locally. A local timeout aborts the ssh process; the
remote shell traps exit/HUP/TERM and kills its background `tail`.

### 4. Readiness: three round-trips to one (P2)

`readyProbe` replaces the reachable → version → agent-listing sequence with one
compound `bash -lc` script. Reachability keys off the returned sentinel, not the
exit code — so a command that *ran but failed* is never misread as a dead
connection, and only ssh's own connection-layer failure (no sentinel) reads as
unreachable.

## Alternatives considered

**A bespoke daemon / relay on every host.** Rejected. It would add a socket
server, a port or tunnel, a custom wire protocol, and its own auth to every Mac
and Linux box — for no capability SSH doesn't already give us. SSH is more
*reliable* (battle-tested, no long-lived process to crash or double-run, host-key
trust + auth + encryption for free) and, with multiplexing, just as *fast* for
repeated calls. Reliability for long jobs already comes from detached `nohup`
dispatch, which survives a dropped connection without any daemon. The scheduling
daemon stays scoped to scheduling.

**Parallel multi-host fan-out.** Rejected as a default. On a small laptop, N
concurrent `ssh` processes trade the one resource we are protecting (local
memory/process pressure) for latency we can tolerate. The serial loop keeps at
most one `ssh` alive; multiplexing already removes the repeat-handshake cost.

**A persistent `tail -f` stream for follow.** Accepted for interactive follows
after the PR #551 combined-round-trip change proved the protocol boundary. The
extra complexity is contained in `progress.ts`: stdout is raw log bytes, stderr
carries only the terminal frame, and reconnects resume from the saved byte
offset.

## Results

Measured against a live Tailscale-relayed host (`scripts/bench-ssh.mjs`), stable
across runs. Each number is wall-clock on the laptop:

| Path | Before | After | Win |
|---|---|---|---|
| P3 · repeated `--device` (per call) | ~444 ms | **~75 ms** | **~6–7×** |
| P2 · readiness per dispatch | 1.5–1.8 s | **~0.8 s** | **~2×** |
| P1 · follow loop (per cycle) | ~706 ms | **~33 ms**, then **1 ssh per follow** | **~21–23×** for bounded polls; persistent follow removes per-cycle spawns |

The P1 figure is the first-step headline: an old cycle paid two fresh handshakes
(~706 ms on a relayed link); the combined poll rides the reused socket (~33 ms).
Interactive follow goes further and holds one socket open for the whole run, so a
quiet hour-long follow no longer creates one local ssh process per poll cycle.

Reproduce: `bun run build && node scripts/bench-ssh.mjs <host>`.

## Trade-offs and risks

- **A 10-minute master lingers after each call.** `ControlPersist=600s`
  (`SSH_CONTROL_PERSIST_SECONDS`) keeps an idle master alive so later commands —
  the rest of a multi-minute burst of `--device`/fan-out touches of the same box —
  reuse it instead
  of re-handshaking. The cost is bounded (one idle unix socket + a small ssh
  master process per recently-touched host, reaped after 10 minutes) and is the
  entire point. The window is capped at 10 minutes rather than longer because a
  master reused after a host has slept costs a ~45 s ServerAlive teardown on the
  first touch, and a wider window only widens the chance of hitting that; fan-outs
  stay bounded regardless by their own per-peer `timeoutMs`. An interactive
  one-shot that must not leave a master can pass `multiplex: false`.
- **Keepalive terminates a live-but-silent connection after ~45 s.** Intended: a
  genuinely idle-but-healthy link is re-established on the next call for near-zero
  cost via the control socket; a dead one no longer hangs.
- **Sentinel-based framing** assumes the remote login shell runs (a `bash -lc`
  assumption shared by every remote call in the codebase). A bash-less remote
  reads as unreachable — the same failure the old code produced, with a clearer
  message.
- **Streaming follow has up to one remote poll interval of finish latency.** The
  remote watcher checks `.exit` once per second, then gives `tail -f` one more
  interval to flush final bytes before emitting the terminal frame. That buys
  deterministic final-output capture while still removing local per-cycle ssh
  churn.

## Rollout and future work

Shipped as one PR: the engine change plus every consumer, unit tests, an A/B
benchmark harness, and this doc. Behavior-preserving — the only observable change
is that remote commands are faster and dead connections self-terminate.

Follow-ups (non-blocking):

- Remove the now-unused `sshReachable` export.
- Keep specialized direct-`ssh` sites (for example `-L`/`-N` tunnels,
  `ProxyCommand` relays, and browser CDP) composed from
  `sshConnectOpts(...)` so they inherit the shared baseline while preserving
  their required extra flags.
- Consider moving cloud task streaming from bounded polling to the same
  persistent follow protocol once its async event generator can share the
  terminal-frame plumbing.
