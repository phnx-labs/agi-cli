
import type { DaemonServiceId } from '../daemon-services.js';
import { getDefaultSocketPath } from '../tmux/paths.js';
import { reapDeadTmuxPanes } from '../tmux/session.js';
import { BasePeriodicService, type DaemonContext } from './service.js';

const TMUX_REAP_TICK_MS = 5 * 60_000;
const TMUX_REAP_DEADLINE_MS = 2 * 60_000;

export class TmuxReapService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'tmux-reap';
  readonly intervalMs = TMUX_REAP_TICK_MS;
  readonly deadlineMs = TMUX_REAP_DEADLINE_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {}
  protected async onStop(): Promise<void> {}

  protected async onTick(ctx: DaemonContext): Promise<void> {
    const result = await reapDeadTmuxPanes(getDefaultSocketPath());
    for (const warning of result.warnings) ctx.log('WARN', `Dead-pane reaper: ${warning}`);
    if (result.processes > 0) {
      ctx.log('INFO', `Dead-pane reaper: terminated ${result.processes} orphaned helper process(es)`);
      for (const detail of result.processDetails) ctx.log('INFO', `  ${detail}`);
    }
    if (result.reaped > 0) {
      ctx.log('INFO', `Dead-pane reaper: reaped ${result.reaped} session(s)`);
      for (const detail of result.details) ctx.log('INFO', `  killed ${detail}`);
    }
  }
}
