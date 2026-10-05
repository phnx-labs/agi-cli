
import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import * as fsp from 'fs/promises';

const STATE_DIR_CHECK_TICK_MS = 60_000;
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
  }

  protected async onStop(): Promise<void> {
  }

  protected async onTick(ctx: DaemonContext): Promise<void> {
    let markerMatches = false;
    try {
      markerMatches = (await fsp.readFile(this.lifetimePath, 'utf-8')) === this.lifetimeToken;
    } catch {
    }
    if (!markerMatches) {
      ctx.log('WARN', `Daemon state dir no longer exists; exiting (self-terminate guard)`);
      this.onMissing();
    }
  }
}
