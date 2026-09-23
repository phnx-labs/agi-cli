/**
 * Real-process-state "is this installation busy right now?" check (PHNX-3940).
 *
 * A leaf module deliberately kept free of `update.js`/`update-runtime.js`
 * imports so both can depend on it without an import cycle: `update.ts` needs
 * it for the pre-commit re-check (narrowing the launch/update race), and
 * `update-runtime.ts` (which itself calls into `update.ts`) needs it for the
 * plan-time deferral decision.
 *
 * Two independent signals, either one is enough to defer:
 *   - A live OS process whose command line names this installation's own
 *     version-dir path — a real process-table scan, not this box's session
 *     registry, so a harness launched by a bare generated shim with no
 *     session bookkeeping still defers correctly.
 *   - A live launch lease (`shims.ts`) — catches a launch that started after
 *     the process-table scan ran but hasn't hit the process table yet, e.g.
 *     mid-staging of a long npm install. See `shims.ts`'s docblock for what
 *     this does and does not close (it narrows the race, not eliminates it).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { getVersionDir } from './store.js';
import { hasLiveLaunchLease } from './shims.js';
import type { Installation } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Raw process-table snapshot, one command line per entry. Injectable so tests
 * can drive real string matching without shelling out or requiring a live
 * agent process on the test box.
 */
export interface ProcessSnapshot {
  listCommandLines(): Promise<string[]>;
  /** Optional richer listing (pid, elapsed, tty) for naming a blocking process. */
  listProcessRows?(): Promise<ProcessRow[]>;
}

export interface ProcessRow {
  pid?: number;
  elapsed?: string;
  tty?: string;
  args: string;
}

async function listProcessRowsPosix(): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,etime=,tty=,args='], {
    timeout: 5_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), elapsed: m[2], tty: m[3], args: m[4] }] : [];
  });
}

async function listCommandLinesPosix(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-Ao', 'args'], {
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.split('\n');
  } catch {
    // A ps failure must not silently mean "nothing is running" — that would let
    // an update proceed against a harness this pass simply failed to observe.
    // Callers treat a thrown scan as "assume active", the safe default.
    throw new Error('could not read the process table (ps failed)');
  }
}

async function listCommandLinesWindows(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"],
      { timeout: 5_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    );
    return stdout.split(/\r?\n/);
  } catch {
    throw new Error('could not read the process table (PowerShell CIM query failed)');
  }
}

export const realProcessSnapshot: ProcessSnapshot = {
  listCommandLines: () => (process.platform === 'win32' ? listCommandLinesWindows() : listCommandLinesPosix()),
  listProcessRows: async () => (process.platform === 'win32'
    ? (await listCommandLinesWindows()).map((args) => ({ args }))
    : listProcessRowsPosix()),
};

/**
 * Does any live process reference this installation's own directory? Matches
 * on the absolute version-dir path rather than the bare CLI command name, so
 * it distinguishes between installations of the same agent (two Claude
 * installs are two different directories) and catches every way the binary
 * ends up running under that path: an `agents run` session, a bare generated
 * PATH/`.cmd` shim exec'd directly with no session bookkeeping at all, or a
 * routine/teammate process — all of them carry the resolved absolute binary
 * path in their command line, since none of the launch surfaces exec a bare
 * relative name.
 */
export function installationLooksActive(installation: Pick<Installation, 'agent' | 'label'>, commandLines: string[]): boolean {
  const versionDir = getVersionDir(installation.agent, installation.label);
  return commandLines.some((line) => line.includes(versionDir));
}

/**
 * Whether this installation appears to be busy right now: a live launch
 * lease, or a live process naming its directory per a fresh OS process-table
 * scan. On a scan failure, defers (returns true) rather than risking an
 * update to a harness this check simply failed to observe.
 */
export async function isInstallationLikelyActive(
  installation: Pick<Installation, 'agent' | 'label'>,
  snapshot: ProcessSnapshot = realProcessSnapshot,
): Promise<boolean> {
  if (hasLiveLaunchLease(installation.agent, installation.label)) return true;
  try {
    const lines = await snapshot.listCommandLines();
    return installationLooksActive(installation, lines);
  } catch {
    return true;
  }
}

export interface InstallationActivity {
  active: boolean;
  /** A launch lease is held (a launch is starting and may not be in the process table yet). */
  lease: boolean;
  /** Live processes naming this installation's directory, one line each. */
  processes: string[];
  /** The process scan failed; `active` is the fail-closed default. */
  scanError?: string;
}

/** `ps` prints `?` (Linux), `??` (macOS) or `-` for a process with no controlling terminal. */
const NO_TTY_MARKERS = new Set(['?', '??', '-']);

function shortenArgs(args: string, versionDir: string): string {
  // Strip the long install path so the line reads as the command the user ran.
  const trimmed = args.replace(versionDir, '…').replace(/\/node_modules\/\.bin\//, '/');
  return trimmed.length > 110 ? `${trimmed.slice(0, 107)}...` : trimmed;
}

/**
 * Same verdict as {@link isInstallationLikelyActive}, plus WHAT is holding the
 * installation, so a refused update can name the session to finish instead of
 * "in use; retry later" (PHNX-4116 follow-up: an operator on yosemite-s0 had a
 * one-hour-old resumed session on another tty and no way to see it from the
 * refusal).
 */
export async function describeInstallationActivity(
  installation: Pick<Installation, 'agent' | 'label'>,
  snapshot: ProcessSnapshot = realProcessSnapshot,
): Promise<InstallationActivity> {
  const lease = hasLiveLaunchLease(installation.agent, installation.label);
  const versionDir = getVersionDir(installation.agent, installation.label);
  try {
    const rows: ProcessRow[] = snapshot.listProcessRows
      ? await snapshot.listProcessRows()
      : (await snapshot.listCommandLines()).map((args) => ({ args }));
    const processes = rows
      .filter((row) => row.args.includes(versionDir))
      .map((row) => {
        const meta = [row.pid !== undefined ? `pid ${row.pid}` : null, row.elapsed ? `up ${row.elapsed}` : null, row.tty && !NO_TTY_MARKERS.has(row.tty) ? row.tty : null]
          .filter((part): part is string => part !== null)
          .join(', ');
        return meta ? `${meta}: ${shortenArgs(row.args, versionDir)}` : shortenArgs(row.args, versionDir);
      });
    return { active: lease || processes.length > 0, lease, processes };
  } catch (err) {
    return { active: true, lease, processes: [], scanError: err instanceof Error ? err.message : String(err) };
  }
}

/** The one-line refusal an update prints for a busy installation. */
export function formatInUseDeferral(name: string, activity: InstallationActivity): string {
  if (activity.scanError) return `${name}: could not confirm nothing is running (${activity.scanError}); not updating.`;
  if (activity.processes.length > 0) {
    const list = activity.processes.length === 1
      ? activity.processes[0]
      : activity.processes.map((p) => `\n    ${p}`).join('');
    return `${name} is in use by ${activity.processes.length === 1 ? 'a running process' : `${activity.processes.length} running processes`} — ${list}. `
      + 'Finish that session (agents sessions stop <id> for an agents session), then retry.';
  }
  return `${name} has a launch in flight; retry once it has started or exited.`;
}
