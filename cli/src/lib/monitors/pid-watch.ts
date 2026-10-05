
import { IS_WINDOWS } from '../platform/index.js';

export const PID_WATCH_EXITED_TOKEN = 'exited';
export const PID_WATCH_RUNNING_TOKEN = 'running';
export const PID_WATCH_NOT_YET_SPAWNED_TOKEN = 'notyetspawned';

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
