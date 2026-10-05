
import type { DaemonServiceId } from '../daemon-services.js';
import { reapExitedRunningJobs } from './runner.js';
import { reapTerminalRoutineProcesses } from '../routine-process-cleanup.js';
import { BasePeriodicService, type DaemonContext } from './service.js';

const HEARTBEAT_TICK_MS = 60_000;
const HEARTBEAT_DEADLINE_MS = 30_000;

export class HeartbeatService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'daemon-heartbeat';
  readonly intervalMs = HEARTBEAT_TICK_MS;
  readonly deadlineMs = HEARTBEAT_DEADLINE_MS;

  constructor(private readonly publishHeartbeat: () => void) {
    super();
  }

  protected async onStart(_ctx: DaemonContext): Promise<void> {}
  protected async onStop(): Promise<void> {}

  protected async onTick(ctx: DaemonContext): Promise<void> {
    this.publishHeartbeat();
    await reapExitedRunningJobs();
    const reaped = await reapTerminalRoutineProcesses();
    if (reaped.length > 0) {
      ctx.log('WARN', `Reaped ${reaped.length} terminal routine process group(s): ${reaped.join(', ')}`);
    }
  }
}
