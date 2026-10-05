/** `--watch-pid`: a backgrounded OS process becomes a durable daemon-polled watcher instead of a
 * harness exit hook (PHNX-3023: such a hook never fires when the watch loop never exits). It runs
 * `process.kill(pid, 0)` in the engine's poll (sources/command.ts), outliving the arming CLI. */

import { IS_WINDOWS } from '../platform/index.js';

/** The token a --watch-pid source's condition matches on process exit. */
export const PID_WATCH_EXITED_TOKEN = 'exited';
/** Emitted while the pid is alive. */
export const PID_WATCH_RUNNING_TOKEN = 'running';
/** Emitted when the pid is not alive AND has never been observed alive (the `--force`
 * not-yet-spawned case); distinct from {@link PID_WATCH_EXITED_TOKEN} so it can never match the
 * exit condition. */
export const PID_WATCH_NOT_YET_SPAWNED_TOKEN = 'notyetspawned';

/** The shell command a --watch-pid source polls. It reports "exited" only after FIRST seeing the
 * pid running (a marker file); else a `--force` watch on a not-yet-spawned pid fires at once and
 * silences the real exit. Portable: `/bin/sh -c` and `cmd /c`. */
export function pidLivenessCommand(pid: number, seenRunningMarkerPath: string): string {
  if (IS_WINDOWS) {
    return (
      `tasklist /FI "PID eq ${pid}" 2>NUL | findstr /I "${pid}" >NUL ` +
      `&& (type nul > "${seenRunningMarkerPath}" & echo ${PID_WATCH_RUNNING_TOKEN}) ` +
      `|| (if exist "${seenRunningMarkerPath}" (echo ${PID_WATCH_EXITED_TOKEN}) else (echo ${PID_WATCH_NOT_YET_SPAWNED_TOKEN}))`
    );
  }
  return (
    `kill -0 ${pid} 2>/dev/null ` +
    `&& { mkdir -p "$(dirname "${seenRunningMarkerPath}")" 2>/dev/null; : > "${seenRunningMarkerPath}"; echo ${PID_WATCH_RUNNING_TOKEN}; } ` +
    `|| { [ -e "${seenRunningMarkerPath}" ] && echo ${PID_WATCH_EXITED_TOKEN} || echo ${PID_WATCH_NOT_YET_SPAWNED_TOKEN}; }`
  );
}
