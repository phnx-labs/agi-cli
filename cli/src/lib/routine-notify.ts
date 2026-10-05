/** Routine lifecycle desktop notifications (RUSH-2030) via the MenubarHelper. Agent/workflow
 * routines notify on start AND finish; command routines (housekeeping) only on FAILURE. Notable
 * output folds into the single finish notification. Pure builders return `null` when suppressed. */

import * as fs from 'fs';
import * as path from 'path';
import type { JobConfig, RunMeta } from './scheduling/routines.js';
import { getRunDir } from './scheduling/routines.js';
import { notifyDesktop, type DesktopNotification } from './menubar/notify-desktop.js';

type RoutineKind = 'agent' | 'workflow' | 'command';

/** Which flavor of routine a config/meta describes — drives the notify threshold. */
export function routineKind(r: Pick<JobConfig, 'agent' | 'workflow' | 'command'>): RoutineKind {
  if (r.command) return 'command';
  if (r.workflow) return 'workflow';
  return 'agent';
}

/** The harness a routine runs on, for the notification avatar, or undefined. Command routines have
 * none; agent routines name theirs; workflow routines have no `agent` field and run via `agents run
 * <workflow>`, which delegates to claude, so they get the Claude mark (as `effectiveAgent`). */
export function routineAgent(r: Pick<JobConfig, 'agent' | 'workflow' | 'command'>): string | undefined {
  const kind = routineKind(r);
  if (kind === 'command') return undefined;
  if (kind === 'workflow') return 'claude';
  return r.agent?.trim() || undefined;
}

/** Human label for the routine body ("agent claude", "workflow deploy", "command"). */
function routineLabel(r: Pick<JobConfig, 'agent' | 'workflow' | 'command'>): string {
  if (r.command) return 'command';
  if (r.workflow) return `workflow ${r.workflow}`;
  return `agent ${r.agent ?? 'unknown'}`;
}

/** "1m 20s" / "45s" / "2h 3m" from a millisecond duration, or null when unknown. */
export function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
}

/** First non-empty line of a run report trimmed to a notification-sized snippet, the "notable
 * output" on a successful finish; null for an empty report so the caller falls back to a plain
 * "Completed" body. */
export function notableSnippet(report: string | null | undefined, maxLen = 140): string | null {
  if (!report) return null;
  const firstLine = report
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;
  return firstLine.length > maxLen ? `${firstLine.slice(0, maxLen - 1).trimEnd()}…` : firstLine;
}

/** Encode a click action that opens a file (report/log) in the default app. */
function openAction(filePath: string | null | undefined): string | undefined {
  return filePath ? `open:${filePath}` : undefined;
}

/** Notification for a routine START, or null when the threshold suppresses it (command-mode
 * housekeeping); clicking opens the runs folder (~/.agents/.history/runs). */
export function routineStartNotification(
  config: Pick<JobConfig, 'name' | 'agent' | 'workflow' | 'command'>,
): DesktopNotification | null {
  if (routineKind(config) === 'command') return null;
  return {
    title: 'Routine started',
    subtitle: config.name,
    body: `Running ${routineLabel(config)}`,
    action: 'routines:list',
    agent: routineAgent(config),
  };
}

/** Notification for a routine that failed to even START (`executeJobDetached` threw before spawn, so
 * no run record or finish exists). Closes the "exactly one start + one finish" invariant
 * (RUSH-2030). Never suppressed; clicking opens the runs folder. */
export function routineStartFailedNotification(
  config: Pick<JobConfig, 'name' | 'agent' | 'workflow' | 'command'>,
  error: string,
): DesktopNotification {
  return {
    title: 'Routine failed',
    subtitle: config.name,
    body: `Failed to start: ${error}`,
    action: 'routines:list',
    agent: routineAgent(config),
  };
}

/** Notification for a routine FINISH, or null when the threshold suppresses it (a successful
 * command-mode run). Success carries the report's first line, failure the reason; clicking opens
 * the run report/log if available, else the runs folder (~/.agents/.history/runs). */
export function routineFinishNotification(
  meta: Pick<RunMeta, 'jobName' | 'status' | 'exitCode' | 'errorMessage' | 'duration' | 'agent' | 'workflow' | 'command'>,
  opts: { report?: string | null; artifactPath?: string | null } = {},
): DesktopNotification | null {
  const kind = routineKind(meta);
  const ok = meta.status === 'completed';
  if (kind === 'command' && ok) return null; // green housekeeping is noise

  const action = openAction(opts.artifactPath) ?? 'routines:list';

  if (ok) {
    const snippet = notableSnippet(opts.report);
    const dur = formatDuration(meta.duration);
    return {
      title: 'Routine finished',
      subtitle: meta.jobName,
      body: snippet ?? (dur ? `Completed in ${dur}` : 'Completed'),
      action,
      agent: routineAgent(meta),
    };
  }

  // failed | timeout
  const reason =
    meta.status === 'timeout'
      ? 'Timed out'
      : meta.errorMessage
        ? meta.errorMessage
        : `Exited with code ${meta.exitCode ?? '?'}`;
  return {
    title: 'Routine failed',
    subtitle: meta.jobName,
    body: reason,
    action,
    agent: routineAgent(meta),
  };
}

/** Read a finished run's report text + the best artifact to open on click. */
function loadRunArtifacts(meta: Pick<RunMeta, 'jobName' | 'runId'>): {
  report: string | null;
  artifactPath: string | null;
} {
  try {
    const runDir = getRunDir(meta.jobName, meta.runId);
    const reportPath = path.join(runDir, 'report.md');
    const stdoutPath = path.join(runDir, 'stdout.log');
    let report: string | null = null;
    let artifactPath: string | null = null;
    if (fs.existsSync(reportPath)) {
      report = fs.readFileSync(reportPath, 'utf-8');
      artifactPath = reportPath;
    } else if (fs.existsSync(stdoutPath)) {
      artifactPath = stdoutPath;
    }
    return { report, artifactPath };
  } catch {
    return { report: null, artifactPath: null };
  }
}

/** Daemon glue: fire the START notification for a triggered routine. Best-effort. */
export function notifyRoutineStart(config: JobConfig): void {
  const n = routineStartNotification(config);
  if (n) notifyDesktop(n);
}

/** Daemon glue: fire the "failed to start" notification when a trigger threw before spawning a
 * child, so the unconditional START ping never leaves an orphaned "Routine started". Best-effort. */
export function notifyRoutineStartFailed(config: JobConfig, error: string): void {
  notifyDesktop(routineStartFailedNotification(config, error));
}

/** Daemon glue: fire the FINISH notification for a completed run. Best-effort. */
export function notifyRoutineFinish(meta: RunMeta): void {
  const { report, artifactPath } = loadRunArtifacts(meta);
  const n = routineFinishNotification(meta, { report, artifactPath });
  if (n) notifyDesktop(n);
}
