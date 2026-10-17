
import type { DaemonServiceId } from '../daemon-services.js';
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

  protected async onTick(_ctx: DaemonContext): Promise<void> {
    this.publishHeartbeat();
  }
}
