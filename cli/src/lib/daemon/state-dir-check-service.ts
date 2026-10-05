/** State-dir self-terminate guard (RUSH-3193 P3, RUSH-2367): exit if this daemon's state directory
 * was removed (a leaked test-fixture daemon), since nothing else can reach it. Reads the lifetime
 * marker directly, not `ensureDaemonDir()` (recreates it). Registered after handleShutdown exists. */

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
