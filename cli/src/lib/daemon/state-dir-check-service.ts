/**
 * State-dir self-terminate guard as a `PeriodicService` (RUSH-3193 P3).
 *
 * RUSH-2367: self-terminate if this daemon's own state directory has been
 * removed out from under it — the shape of a leaked test-fixture daemon whose
 * /tmp HOME was deleted by its test's own cleanup while the process itself
 * somehow survived. Nothing else can reach a daemon in that state: a
 * different HOME resolves a different `ensureDaemonDir()` and therefore a
 * different instance registry — without this it runs forever. Reads the
 * lifetime marker directly, never the local `ensureDaemonDir()` wrapper,
 * which recreates the directory as a side effect and would defeat the check.
 * Heartbeat/status paths may recreate the directory and pid file after a
 * deletion; they never recreate this per-lifetime token.
 *
 * `lifetimePath`/`lifetimeToken` are per-boot constants computed once at
 * `runDaemon()` start and passed in via the constructor, along with the
 * shutdown callback. Registering (and starting) this service happens AFTER
 * `runDaemon()` defines its `handleShutdown` — unlike the other four migrated
 * services, which register before `supervisor.startAll()` — because the
 * supervisor fires an immediate first tick on start, and calling an
 * as-yet-undefined `handleShutdown` const at that point would throw. See the
 * registration site in daemon.ts for the deferred `supervisor.register()` +
 * `supervisor.start()` pairing this requires.
 */

import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import * as fsp from 'fs/promises';

/** Matches the historical inline interval (daemon.ts STATE_DIR_CHECK_TICK_MS), overridable for tests. */
const STATE_DIR_CHECK_TICK_MS = 60_000;
/** Hard cap per tick — a single async file read, far above what it could ever need. */
const STATE_DIR_CHECK_DEADLINE_MS = 5_000;

interface StateDirCheckServiceOptions {
  lifetimePath: string;
  lifetimeToken: string;
  onMissing: () => void;
}

export class StateDirCheckService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'state-dir-check';
  readonly intervalMs = Number(process.env.AGENTS_DAEMON_STATE_DIR_CHECK_MS) || STATE_DIR_CHECK_TICK_MS;
  readonly deadlineMs = STATE_DIR_CHECK_DEADLINE_MS;

  private readonly lifetimePath: string;
  private readonly lifetimeToken: string;
  private readonly onMissing: () => void;

  constructor(opts: StateDirCheckServiceOptions) {
    super();
    this.lifetimePath = opts.lifetimePath;
    this.lifetimeToken = opts.lifetimeToken;
    this.onMissing = opts.onMissing;
  }

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    // No connections/handles to open — each tick re-reads the lifetime marker.
  }

  protected async onStop(): Promise<void> {
    // Nothing to release — the supervisor's timer teardown is the only cleanup needed.
  }

  protected async onTick(ctx: DaemonContext): Promise<void> {
    let markerMatches = false;
    try {
      markerMatches = (await fsp.readFile(this.lifetimePath, 'utf-8')) === this.lifetimeToken;
    } catch {
      // A missing state dir or marker is the condition this guard detects.
    }
    if (!markerMatches) {
      ctx.log('WARN', `Daemon state dir no longer exists; exiting (self-terminate guard)`);
      this.onMissing();
    }
  }
}
