# Daemon module

The background process behind `agents __daemon-run` — the interval-driven
services that keep sessions, watchdog checks, device probes, monitors,
self-heal, and reapers running on each machine without a human polling them.

## Current architecture

**N independent per-device daemons, no daemon-to-daemon bus.** Every device
that runs agents-cli runs its own daemon process (`agents __daemon-run` →
`runDaemon()`, `daemon.ts:850`). No daemon opens a persistent connection to
another daemon. Cross-device state either rides per-device files in the existing
fleet-synced user repo (`fleet-shared-state.ts`, used by usage/auth sync) or an
on-demand `ssh` invocation of a peer CLI verb — e.g.
`watchFleetFeed` spawns `ssh <peer> agents feed watch --local`
(`cli/src/lib/feed/watch.ts:151`) and `watchFleetSessions` does the same for
sessions (`cli/src/lib/session/remote/watch.ts:245`). There is no shared daemon
protocol and no routine device-to-device usage/auth probe mesh.

**Start, claim, and stop are one serialized lifecycle.** All three mutate the
shared pid/heartbeat/socket inventory behind `<daemonDir>/daemon.lock`.
`stopDaemon()` holds that lock from target resolution through its postcondition,
accepts a pid only when the live process command ends in `__daemon-run`, and
removes a pid or POSIX socket only while it still matches the owner/inode captured
under the lock. A failed process-command inspection is an unverified live owner,
never permission to signal it, erase its files, or launch a duplicate.
`reapStrayDaemons()` applies the same identity gate, waits for SIGTERM death, then
escalates and waits again; it removes a registry marker only after death is
observed, so a wedged duplicate cannot survive while becoming invisible.

**Two runtime models coexist today (RUSH-3193 plus PHNX-3265/PHNX-3608/PHNX-3695 migrated 20 of 21
declared services; 1 declared service remains inline).** `cli/src/lib/daemon-services.ts`
defines `DaemonServiceId` (21 ids:
`secrets-broker`, `scheduler`, `catchup`, `monitors`, `browser-ipc`,
`webhook-receiver`, `self-heal`, `self-update`, `keychain-reap`, `account-state`, `account-auth`,
`watchdog`, `device-probe`, `state-dir-check`, `session-index`, `auth-sync`,
`daemon-heartbeat`, `tmux-reap`, `browser-task-reap`, `session-state`,
`usage-sync`) — the
catalog every id in `runDaemon()` is expected to register under, whichever
model it uses.

- **Supervised (`ServiceSupervisor`, `supervisor.ts`), 20 services:**
  `secrets-broker` (`secrets-broker-service.ts`), `browser-ipc`
  (`browser-ipc-service.ts`), `account-state` + `account-auth`
  (`account-state-daemon-service.ts` — PHNX-3608 split the old single
  account-state service into `AccountUsageService` and `AccountAuthService`, two
  periodic services with INDEPENDENT circuit breakers so a run of usage-refresh
  failures parks only usage and never starves the slower auth refresh), `catchup`
  (`catchup-service.ts`, PHNX-3608 — the scheduler's missed-fire recovery pass,
  self-gated on the scheduler being booted), `session-index`
  (`session-index-service.ts`), `monitors` (`monitor-engine-service.ts`)
  (all P1/P2), and — since P3 — `watchdog` (`watchdog-service.ts`),
  `device-probe` (`device-probe-service.ts`), `self-heal`
  (`self-heal-service.ts`), `keychain-reap` (`keychain-reap-service.ts`), and
  `state-dir-check` (`state-dir-check-service.ts`), `session-state`
  (`session-state-service.ts`), and `webhook-receiver`
  (`webhook-receiver-service.ts`), `daemon-heartbeat`
  (`heartbeat-service.ts`), `tmux-reap` (`tmux-reap-service.ts`), and
  `browser-task-reap` (`browser-task-reap-service.ts`), and `auth-sync`
  (`auth-sync-service.ts`), `usage-sync` (`usage-sync-service.ts`), and — since
  PHNX-3695 — `self-update` (`self-update-service.ts`: checks npm for a newer
  agents-cli roughly every 75 minutes, installs + byte-verifies it with the
  same primitives `agents upgrade` uses, best-effort pulls the `.system`
  companion repo and reconciles with `agents sync --local`, then
  `process.exit(0)`s so the OS supervisor — launchd `KeepAlive` / systemd
  `Restart=always` — relaunches the daemon onto the new code; fails CLOSED on
  any step — a failed install/verify leaves the running daemon untouched and
  retries next tick, never exits into unverified code. No-ops on a dev build or
  a shadowed install. Also reachable on demand via the `request-self-update`
  browser-IPC action, which a version-skewed client now sends instead of just
  printing `agents daemon restart` — `browser/ipc.ts`'s `reconcileDaemonVersion`).
  Each implements the
  `DaemonService` contract (`service.ts`) — `id`,
  `start`/`stop`/`restart`/`health()`, plus `intervalMs`/`deadlineMs`/`tick()`
  for the periodic ones — and is `supervisor.register()`ed in `runDaemon()`
  only when `isDaemonServiceEnabled(id)` is true at boot. Every P3 service
  registers alongside the P1/P2 batch before `supervisor.startAll()` except
  `state-dir-check`, which registers (and starts) separately, right after
  `handleShutdown` is declared later in `runDaemon()` — the supervisor fires
  an immediate first tick on registration, and `state-dir-check`'s tick calls
  `handleShutdown` on a marker mismatch, so registering it before that const
  exists would reference it in its temporal dead zone. The supervisor gives
  each periodic service a per-tick deadline race, a per-service try/catch that never
  escapes to the process-wide crash handler, and a park/backoff circuit
  breaker (`parkAfterFailures`, default 3) that retries independently of
  every sibling service. A deadline is detection, not cancellation: the service
  parks immediately, retains its in-flight ownership until the real promise
  settles, and cannot be stopped or restarted live underneath that work.
  SIGHUP control transitions queue on `awaitIdle()` rather than polling, so a
  requested toggle applies after real settlement without another timer owner.
  `getServiceSupervisorHealth()` (`daemon.ts:60`)
  exposes the live in-process `supervisor.health()` map for a future
  same-process reader; a cross-process reader (`agents daemon services`, a
  separate CLI invocation) instead reads the persisted mirror below.
- **Inline declared service, 1 service:** `scheduler` (the routine
  `JobScheduler`) remains outside the supervisor.
  `scheduler` is croner-driven (fires at each job's own cron schedule, not a
  fixed interval) and already has its own live-reload path
  (`schedulerGateTransition`, `bootScheduler`/`stopScheduler`) predating the
  supervisor; folding it in without regressing that reload semantics is
  future work. It has no per-service circuit breaker or state persisted to
  `health.json`; `agents daemon services` infers a coarse `running`/`stopped`
  label from the enable toggle plus whether the daemon process is up.

`runDaemon()` has no bare fixed-cadence maintenance timer left. Its only direct
`setInterval` is scheduler catch-up, which is part of the one remaining inline
declared service and shares that service's live boot/stop/reload lifecycle.
Resource-local timers may still live inside lower-level socket implementations
(for example TTL eviction inside the hosted secrets broker); those own the
resource they maintain and are closed by the surrounding service lifecycle.

Enabled/disabled state lives separately in a `DaemonServicesConfig`, read
and written via `isDaemonServiceEnabled` (`daemon-services.ts`),
`setDaemonServiceEnabled` (`daemon-services.ts`), and
`listDaemonServiceStates` (`daemon-services.ts`) — one `services.yaml` under
`getDaemonConfigDir()`, unioned across both runtime models above.

**Cross-process health is file-backed, keyed by the same `DaemonServiceId`
strings the two models above use.** `cli/src/lib/daemon-health.ts` is the
one health mirror both the daemon (writer) and `agents daemon` /
`agents daemon services` (a separate reader process) use —
`recordSubsystemOk`/`recordSubsystemError` (ok/error streak + last
error/timestamp) and, since RUSH-3193 P4, `recordSubsystemState` (the
supervisor's `idle`/`running`/`parked`/`stopped` lifecycle state, written on
every transition in `supervisor.ts`'s `startOne`/`stopOne`/`park`/
`attemptRestart`). Only supervised services call
`recordSubsystemState`, so a `SubsystemHealth` record's `state` field being
present is itself the signal `agents daemon services` uses to render
"measured" vs "inferred" (`commands/daemon.ts`'s `buildServiceRows`).
Every update holds a cross-process `proper-lockfile` lease across the entire
read-modify-write and publishes `health.json` by atomic rename. Readers therefore
see complete JSON, and concurrent daemon/foreground writers preserve every
failure-streak increment used by the auto-start circuit breaker.

**Crash model: any uncaught error in the process kills and restarts the
whole daemon, not just the failing service — except for supervised
services above, which the supervisor's own try/catch + deadline race now
isolate.** A throw that escapes an INLINE service's local try/catch is still
uncaught at the process level. `cli/src/index.ts:96-102` installs the
top-level handlers:

```ts
process.on('uncaughtException', crash('uncaughtException'));
process.on('unhandledRejection', crash('unhandledRejection'));
```

`crash()` logs and then calls `process.exit(1)` (`index.ts:100`), relying on
the OS supervisor (launchd `KeepAlive` on macOS, `systemd Restart=always` on
Linux) to relaunch the whole process — every INLINE service restarts
together, not just the one that threw. The inline scheduler still has no
independent measured health signal.

Two library/callback boundaries are explicitly contained before that terminal
policy. Direct `proper-lockfile` leases use
`logAndContinueOnLockCompromised` because lock refresh happens on the library's
own timer, outside the owning service promise; a lost advisory lease is logged
without throwing from that timer. The process-level `SIGHUP` registration wraps
`handleReload` with `guardSignalHandler`, so a synchronous reload failure is
logged and leaves the daemon and its other services alive.

**Live enable/disable/restart (RUSH-3193 P4).** `agents daemon services
enable|disable|restart <id>` persists the toggle (or, for `restart`, queues
a one-shot restart request via `queueDaemonServiceRestart` —
`daemon-services.ts`) and then signals the running daemon over the same
`SIGHUP` `agents daemon reload` already used (`signalDaemonReload`) — there
is no separate control socket. The daemon's `handleReload` diffs the reloaded
`services.yaml` against the config it booted with and, for any registered
supervised id, calls `supervisor.start(id)` / `supervisor.stop(id)` live — no
daemon restart. It also drains any queued restart via
`supervisor.restartOne(id)`. Most services disabled at boot are not registered
and therefore still require an operator restart to enable. `browser-ipc` is the
deliberate exception: it is always registered, with a stopped initial state
when disabled, so `agents browser` can enable/reload the browser service without
ever taking ownership of the shared daemon lifecycle. The inline scheduler is
re-evaluated directly by `handleReload`; `agents routines start|stop` toggles
that service and sends SIGHUP while the daemon stays up (PHNX-3605).
`agents daemon services` (no subcommand) reads
`readAllSubsystemHealth()` plus `listDaemonServiceStates()` and renders one
row per registered id — state, enabled, consecutive failures, last error —
additively alongside the pre-existing `secretsBroker`/`browserIpc` hosted-
socket fields in `--json` (`commands/daemon.ts`'s `runServices`). An
interactive TTY browser (reusing `dynamicPicker`, `lib/picker.ts`) is
intentionally out of scope for this PR — see the linked follow-up ticket.

**Four cross-device distribution patterns already exist, each hand-rolled
independently — there is no shared abstraction between them:**

- **fanout** (per-peer watch, local process per remote): `watchFleetFeed`
  (`cli/src/lib/feed/watch.ts:133`) and `watchFleetSessions`
  (`cli/src/lib/session/remote/watch.ts:223`) each spawn one `ssh` child per
  peer device and merge their streamed output into one local view.
- **mirror** (every device publishes its own row, readers union all rows):
  `publishLocalFleetStatus` (`cli/src/lib/fleet-status.ts:151`) and
  `writeAuthHealthEntries` (`cli/src/lib/auth-health.ts:373`, called at
  `auth-health.ts:603`) each write a local file that other devices read and
  merge — no single device owns the aggregate. `fleet-shared-state.ts` applies
  the same pattern to a conflict-free tracked per-device file: headed usage
  publishers write rows that workers union newest-wins, while auth writes only
  a safe readiness verdict and elects one ready source for an exceptional,
  async, deadline-bounded secret provision. `fleet-shared-repo-sync.ts`
  automatically commits only the owning device's file and exchanges the user
  repo under one cross-process lock; its async git process tree has a 45-second
  hard deadline, so both daemon services share transport without racing or
  depending on a human `agents repo sync user`.
- **elected-singleton** (first-come binds, others detect and back off):
  the secrets broker binds a local socket in `startHostedBroker`
  (`cli/src/lib/secrets/agent.ts:915`, bind call at `:925`); daemon-side
  takeover logic is `shouldTakeOverBroker`
  (`cli/src/lib/daemon/daemon.ts:182`):

  ```ts
  export function shouldTakeOverBroker(isHosting: boolean, brokerReachable: boolean): boolean {
    return !isHosting && !brokerReachable;
  }
  ```

**Caching is mostly ad-hoc — the bounded primitive is underused.**
`createMemoryCache` (`cli/src/lib/memory-cache.ts:21-23`) is a bounded
LRU+TTL cache (`max` and `ttlMs` are required, with optional
`fetchMethod` coalescing):

```ts
export function createMemoryCache<K extends {}, V extends {}>(options: MemoryCacheOptions<K, V>): LRUCache<K, V>
```

Only 3 call sites actually use it: `cli/src/lib/session/session-cache.ts:78`
and `cli/src/commands/sessions-picker.ts:142` / `:160`. Roughly 28 other
files implement their own ad-hoc TTL constants plus disk-mirror files with
little or no eviction (`fleet-status.ts`, `auth-health.ts`, `mailbox.ts`,
`linear-cache.ts`, `devices/stats-cache.ts`, `session/presence.ts`,
`secrets/vault.ts`, and others) — so roughly 3 of ~31 cache-like constructs
in this area route through the shared bounded cache. State this as it is:
most daemon-adjacent caching has no shared eviction policy today.

## Service ownership status

**Shipped:** the `DaemonService`/`PeriodicService` contract and
`ServiceSupervisor` (P1); the first 5 services migrated onto it — secrets-broker,
browser-ipc, account-state, session-index, monitors (P2); the operator
surface — `agents daemon services` reporting every registered service's
health plus live `enable`/`disable`/`restart` for the supervised set over the
existing SIGHUP reload path (P4); and the remaining 5 interval-driven
services — `watchdog`, `device-probe`, `self-heal`, `keychain-reap`,
`state-dir-check` — migrated onto the supervisor too (P3), bringing the
supervised total to 10. PHNX-3265 moved live-session publishing and webhook
ingress plus every fixed-cadence maintenance loop onto the same supervisor,
and fixed manual periodic restarts so they
replace, rather than duplicate, the timer. PHNX-3695 added `self-update` as a
new periodic supervised service — the daemon previously ran with
`AGENTS_CLI_DISABLE_AUTO_UPDATE=1` forced on (`bootstrap.ts`), so R5 ("the
installed CLI auto-updates") held for the interactive CLI but silently did NOT
hold for the one process that runs unattended for days. `agents daemon
services` now reports measured health for 20 of 21 declared services and
infers only `scheduler`.
This doc's Current architecture section
above is the source of truth for all of it.

**Still open:**

- **`scheduler` supervision.** `scheduler` is
  croner-driven (fires on each job's own cron schedule, not a fixed
  interval) and already has its own live-reload path
  (`schedulerGateTransition`) that predates the supervisor — folding it in
  needs a `DaemonService` shape that isn't just `PeriodicService`, or a
  dedicated adapter, without regressing that reload semantics.
- **Interactive `agents daemon services` browser** (RUSH-3210) — a TTY-only view reusing
  `dynamicPicker` (`lib/picker.ts`), one row per service with a live-updating
  preview pane (log tail, last error, config) and inline
  enable/disable/restart keybindings, mirroring the `agents sessions`
  browser (`commands/sessions-browser.ts`). Deferred out of the P4 PR.
- **Cross-device distribution patterns** (fanout / mirror / elected-singleton,
  described above) formalized as declared `placement` (`every-device` |
  `singleton`) and `distribution` (`fanout` | `mirror` | `local`) fields
  resolved by shared helpers, instead of independent implementations. Usage and
  reserved-auth readiness now share one versioned per-device mirror envelope,
  but the other distribution sites remain independently implemented.
- **Caching** routed through `createMemoryCache` under a declared `cache`
  policy instead of the ~28 files of ad-hoc TTL constants + disk-mirror files
  described above.

## Audit rule: what belongs in a daemon service

Move work behind `DaemonService` when it is autonomous after the initiating
command exits, repeats on a cadence or event edge, owns a long-lived socket or
child, or must expose independent health and restart semantics. By that rule,
the next high-value moves are:

1. **Routine scheduler + catch-up** — the only declared service still inline.
   It needs a lifecycle adapter that preserves croner reload and catch-up claim
   semantics; do not flatten cron into a fake fixed interval.
2. **Fleet feed/session watch coordination** — `watchFleetFeed` and
   `watchFleetSessions` each create an O(devices) SSH fanout per consumer. A
   daemon-hosted coordinator is justified only with one multiplexed local
   subscription surface, bounded buffers/backpressure, and explicit peer
   unavailable envelopes; moving the same fanout unchanged merely relocates it.
3. **Cross-device orphan/session ownership** — the local `session-state` service
   now owns metadata publication, but a peer still must classify its own pane
   and publish that fact. The launching device must not infer peer liveness from
   absent local signals.

Do not turn synchronous launch-time invariants into background services. Host,
cloud, fork, and local session registration currently duplicate metadata
assembly; that belongs in one pure canonical registration API invoked inside
the launch transaction, with the daemon as reconciler/repairer after crashes.
Foreground-only timers (TTY spinners, log tailing, interactive login polling,
one command's progress display) stay with their foreground command because they
have no useful lifetime once that caller exits.

See [PHNX-3193](https://linear.app/getrush/issue/PHNX-3193) for the original design,
[PHNX-3265](https://linear.app/getrush/issue/PHNX-3265) for the composed hardening audit,
and [RUSH-2654](https://linear.app/getrush/issue/RUSH-2654) for the
originating context. Do not describe P3/distribution/caching work as shipped
until the corresponding code lands.
