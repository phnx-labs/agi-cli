<!-- guide -->
# Secrets-agent process model (design decision)

> **SUPERSEDED (PHNX-3989 Track D, OWN-1).** The in-repo secrets-agent broker
> this document is about (`src/lib/secrets/agent.ts`) is deleted. The
> standalone [`@phnx-labs/secrets-cli`](https://github.com/phnx-labs/secrets-cli)
> engine now owns its broker's process lifecycle **exclusively** — the
> agents-cli daemon documented below no longer hosts it, self-heals it, or
> takes it over under any condition; `agents daemon status`/`services` only
> probes its reachability. The daemon-hosting design this record accepted is
> reversed. Kept as a historical record of the incidents (stale-daemon reads,
> cold-start starvation, duplicate daemons) that motivated hosting it in a
> long-running process at all — that reasoning still explains why the
> standalone runs its own persistent broker today.

> Status: **accepted** (superseded, see above) · Supersedes nothing · Related: [secrets.md](secrets.md), [routines.md](routines.md)

> **Implementation (#416, steps 1 & 2 — landed):** the daemon hosts the broker
> socket-first. `runDaemon()` calls `startHostedBroker()` before the scheduler
> and the heavy browser services, so `agents secrets` resolves
> within ms of daemon start; it only hosts when no broker is already reachable,
> so a live standalone broker is never orphaned.
>
> Step 2 retires the standalone `com.phnx-labs.agents-secrets-agent` service:
> `ensureAgentRunning()` no longer installs it — it retires any leftover plist
> (`retireLegacySecretsAgentService()`) and then relies on the daemon (Path 0),
> with a one-off detached broker as the only fallback. The upgrade migration
> (`scripts/postinstall.js` → `healLongRunningProcesses`) boots out the legacy
> service first, then (re)starts the daemon so it takes over the socket. `secrets
> start` is now a thin alias that brings the daemon up; `secrets stop` locks all
> bundles and retires any leftover legacy service, leaving the always-on daemon
> running. **Still to do (#417):** spawn the heavy services as bounded children.

A design record for *where the secrets-agent broker should live as a process* —
its own service, or folded into the routines daemon. Written after a stretch of
production incidents (stale daemon reading the keychain, broker cold-start
starvation, duplicate daemons) made the process model worth pinning down.

## Context

The **secrets-agent broker** (`src/lib/secrets/agent.ts`) is a persistent
process that holds unlocked bundles in memory behind a `0700` Unix socket, so
concurrent agents stop re-prompting Touch ID per process. It currently runs as
its own launchd user service, `com.phnx-labs.agents-secrets-agent`.

The **routines daemon** (`src/lib/daemon/daemon.ts`, `com.phnx-labs.agents-daemon`)
already hosts a socket IPC service of the same shape — `BrowserIPCServer` — which
prompted the question: *isn't the broker a second daemon we don't need? Fold it
into the routines daemon.*

## What the routines daemon actually is today

`runDaemon()` runs, **in-process**:

- the cron **scheduler** (`JobScheduler`),
- `BrowserService` + `BrowserIPCServer` (a socket server),
- overdue-job detection + native notification on startup,
- orphan-process reaping,
- a 60s monitor interval.

It persists via launchd **or** a detached fallback. Install and upgrade
(`scripts/postinstall.js` → `healLongRunningProcesses` on darwin/linux) start
the supervised daemon when `daemon.enabled` is not false so KeepAlive/Restart=always
apply without waiting for `routines add`. First-run / `--force` `agents setup`
also calls `startDaemon()` after the system repo is ready. Background-adjacent
callers still use `ensureDaemonStarted()` (honoring `daemon.enabled` and the
auto-start circuit breaker).

Observed failure modes this cycle: heavy/slow startup, stale pid file
(`launchctl … PID: null`), duplicate daemon processes, and cold-start
starvation under high load (a fresh node process couldn't finish booting at load
~310).

## Why the broker has different requirements than the scheduler

| | Secrets broker | Routines scheduler |
|---|---|---|
| Blast radius of being down | **Loud** — every secret read pops Touch ID | Quiet — a cron job just runs late |
| Footprint | Tiny (socket + `Map`) | Heavy (browser, sync, scheduler) |
| Who needs it | Anyone using `agents secrets` | Only users with routines |
| Cold-start budget | Must be ~instant | Tolerant of slow start |

A reliability/security primitive that *everything* depends on should have the
**fewest dependencies and the lightest footprint**, and must not inherit the
failure modes of unrelated subsystems.

A note on an argument we explicitly **reject**: "the daemon is flaky, so keep the
broker out of it." A daemon is *defined* by being the supervised, always-on,
bounce-back backbone — robustness is its job. The PID-null / duplicate /
cold-start incidents are **bugs to fix in the daemon**, not properties to design
around. Routing a critical service *around* the daemon to dodge its bugs is
backwards; the fix is to make the daemon worthy of hosting critical services.
And the reliability isolation a separate broker seems to buy is largely illusory:
both a standalone broker and the daemon recover the same way — launchd
`KeepAlive` — so splitting them adds a second thing to supervise without adding
real resilience.

## Options

1. **Fold into the daemon, and harden the daemon.** Host the broker in the
   daemon next to `BrowserIPCServer`; make the daemon the always-on,
   single-instance, self-healing backbone it is meant to be.
   - One supervised backbone for all background services; one lifecycle; one
     self-heal path; the broker inherits the daemon's robustness.
   - Requires real work: the daemon must (a) be **always-on**, not gated on
     having routines; (b) enforce **single-instance** (no duplicates); (c) start
     the **broker socket first/fast** so secrets availability never waits on
     browser/sync init; (d) keep heavy/risky work (browser automation, job runs)
     in **spawned children** so a crash there can't take the backbone down.
2. **Keep the broker as its own minimal service.** Fault-isolated, but two
   services on two lifecycle mechanisms, and the "isolation" is mostly illusory
   (both rely on `KeepAlive`). Rejected — it treats daemon bugs as permanent.

## Decision

**Fold the broker into the daemon — and harden the daemon into the robust,
always-on, self-healing backbone (Option 1).** A daemon is the right home for a
persistent, critical background service precisely *because* it is supposed to be
the most reliable, supervised component. The broker's reliability should come
*from* a reliable daemon, not from avoiding it.

The guiding principle (corrected): **make the host (the daemon) reliable enough
to carry the critical service — don't route the critical service around the
host.**

This makes the daemon the single backbone that hosts the scheduler, browser IPC,
and the secrets broker, with heavy/optional work spawned as children to bound
blast radius.

## Consequences

- The standalone `com.phnx-labs.agents-secrets-agent` launchd service is retired;
  the broker becomes a service hosted inside `com.phnx-labs.agents-daemon`. The
  `secrets start/stop` surface either goes away or becomes thin aliases for
  daemon lifecycle.
- The daemon must become **always-on** (start for any background need, not only
  `routines add`) and **single-instance** (the PID-null/duplicate bugs are
  fixed, not tolerated).
- In `runDaemon()`, **bind the broker socket before** the browser
  setup, so secrets resolution is available within milliseconds of daemon start
  even while the heavier services initialize.
- Heavy/crash-prone work stays in child processes so a failure there can't take
  down the broker; the daemon core stays light enough to be trustworthy.
- Self-heal (heal-on-upgrade + version-skew restart, PR #413) applies to the one
  daemon, covering the broker for free.
- Migration: on upgrade, `bootout` the old secrets-agent service and let the
  daemon take over the socket.

### Single-instance is enforced by two independent signals

"Only one broker owns the socket" is the invariant the whole model rests on, and
it was enforced by one signal that could lie:

- `stopDaemon()` sent SIGTERM, scheduled its escalation on a `setTimeout`, and
  cleared the daemon pid file **immediately**. In a short-lived caller (the npm
  postinstall) that timer never fired, and the cleared pid file made
  `isDaemonRunning()` report false while the old daemon was still running — so
  `startDaemon()` launched a second one.
- `bindBrokerSocket()` then treated a single missed `agentPing` as proof the
  socket owner was dead. The broker is single-threaded, so a large read or the
  startup rehydrate can outlast one 700ms ping while the process is healthy.

Together they produced an orphan: the reclaiming broker unlinked the live socket
and rebound, and the original kept running with every unlocked bundle in RAM,
unreachable to every client. On a machine with two installs (nvm + homebrew) this
recurred on every upgrade — `lsof` showed two processes on one socket path at two
different kernel socket addresses.

Both signals are now required before a socket is reclaimed:

1. **Liveness is observed, not assumed.** `stopDaemon` waits for the process to
   stop serving before clearing the pid file (`waitForExit` in `daemon.ts`), and
   escalates to a tree-kill only when it genuinely did not exit. A **zombie counts
   as exited** — it holds no socket — so a daemon that is the caller's own child
   is never hard-killed after it has already gone. Start/claim/stop serialize on
   `daemon.lock`; stop accepts only a live process whose command ends in
   `__daemon-run`, then compare-deletes the captured pid/socket ownership so it
   cannot erase a successor that appeared during teardown.
2. **A live socket owner is never evicted.** Whichever broker wins the bind records
   its pid in `agent.owner` at the moment it is the confirmed owner (the same
   instant it mints the capability token), and releases it on close.
   `bindBrokerSocket` probes an in-use socket several times and, even then, refuses
   to reclaim it while `brokerPidAlive()` reports a live owner.

   `agent.owner` is deliberately a **separate file from `agent.pid`**. `agent.pid`
   is the standalone service's O_EXCL single-instance claim, held by a standalone
   that lost the socket race and stays alive and quiescent so launchd's KeepAlive
   does not restart-loop it, ready to take over if the hosted broker stops.
   Overloading it as the ownership record made that standalone see a live holder
   and exit immediately — the very restart loop the guard exists to prevent. The
   two files answer different questions: *who may run* versus *who is serving the
   socket right now*. Both broker flavours write `agent.owner`, so the signal is
   present for the daemon-hosted broker, which is the primary configuration.

3. **Every teardown waits before unlinking.** `ensureAgentRunning`'s one-off
   fallback and `teardownStaleBroker` used to SIGTERM a possibly-live broker and
   immediately unlink its socket and pid files. That both orphaned a slow-exiting
   broker and destroyed the ownership record the check above depends on, so the
   successor saw an ownerless socket and reclaimed it regardless. Both now wait
   for the process to stop serving first.

4. **A version-skewed client never evicts a daemon-hosted broker.** The
   version-skew teardown (`shouldTeardownVersionSkewedBroker`) exists for
   churning dev installs where no daemon owns the broker. But when the always-on
   daemon hosts it, `teardownStaleBroker` recognizes only the standalone
   broker's `pidPath()` claim — the daemon writes `ownerPath()`, not `pidPath()` —
   so eviction unlinks the daemon's socket *without* stopping the daemon, which
   then keeps `hostedBroker != null` and `shouldTakeOverBroker` refuses to
   re-host (point 3's asymmetry), orphaning the broker until the daemon restarts
   while every reader cold-starts a one-off broker and re-prompts Touch ID.
   `ensureAgentRunning` now gates the teardown on `shouldClientEvictSkewedBroker`,
   which defers to a live daemon (`isDaemonRunning()`): a daemon-hosted broker is
   never client-evicted. Daemon code-version upgrades are handled by the
   `postinstall.js` daemon restart, and `agentPing()` already gates reachability
   on `PROTOCOL_VERSION`, so a code-skewed daemon broker stays wire-compatible —
   deferring to it is safe.
