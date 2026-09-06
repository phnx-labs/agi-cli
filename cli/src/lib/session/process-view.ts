import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getCacheDir, getTerminalsDir, getDaemonDir } from '../state.js';
import { atomicWriteFileSync, withFileLock } from '../fs-atomic.js';

export interface HostProcessView {
  bootId?: string;
  pidNamespace?: string;
  /** Namespace inodes can be reused within one boot; its init identifies the incarnation. */
  initStartTicks?: string;
  ownerPid?: number;
  ownerStartTicks?: string;
}

// Linux UAPI PID_NS_INIT_INO (include/uapi/linux/nsfs.h; previously
// PROC_PID_INIT_INO in include/linux/proc_ns.h). This is a kernel-defined
// namespace identity, independent of PID 1's executable or command name.
function isInitialPidNamespace(view: HostProcessView): boolean {
  return view.pidNamespace === 'pid:[4026531836]';
}

function sameProcessView(owner: HostProcessView, view: HostProcessView): boolean {
  return owner.bootId === view.bootId && owner.pidNamespace === view.pidNamespace
    && owner.initStartTicks === view.initStartTicks;
}
/** Authenticate the legacy singleton with kernel socket credentials. A host
 * daemon invisible in a nested namespace has peer PID 0, never a colliding PID.
 * No socket/PID/command-name guess grants migration authority. */
function verifiedLegacyDaemon(): boolean {
  try {
    execFileSync('python3', ['-c', `import os,socket,struct,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(0.2)
s.connect(sys.argv[1])
pid,uid,gid=struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
assert pid>0 and uid==os.getuid()
assert pid==int(open(sys.argv[2]).read().strip())
assert os.readlink('/proc/%d/ns/pid'%pid)==os.readlink('/proc/self/ns/pid')
`, path.join(getCacheDir(), 'helpers', 'browser', 'browser.sock'), path.join(getDaemonDir(), 'daemon.pid')], {
      stdio: 'ignore', timeout: 1000,
    });
    return true;
  } catch { return false; }
}

function hasLegacyState(): boolean {
  return [path.join(getTerminalsDir(), 'by-pid'), path.join(getCacheDir(), 'state', 'sessions')]
    .some(dir => fs.existsSync(dir) && fs.readdirSync(dir).length > 0)
    // Health/log output records attempted starts, not ownership. The ordinary
    // start path writes health.json BEFORE spawning its first daemon.
    || ['daemon.pid', 'daemon.lifetime', 'heartbeat.json'].some(file => fs.existsSync(path.join(getDaemonDir(), file)))
    || fs.existsSync(path.join(getCacheDir(), 'helpers', 'browser', 'browser.sock'))
    || ['.active-sessions.json', '.active-session-immutable.json'].some(file => fs.existsSync(path.join(getCacheDir(), file)));
}

/** Measure the calling process, never infer authority from a process name. */
export function currentProcessView(): HostProcessView | undefined {
  if (process.platform !== 'linux') return {};
  try {
    if (Number(fs.readFileSync('/proc/self/stat', 'utf8').split(' ', 1)[0]) !== process.pid) return undefined;
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const pidNamespace = fs.readlinkSync('/proc/self/ns/pid');
    // NSpid is relative to the procfs mount. Multiple coordinates mean this
    // mount exposes an ancestor namespace, even if numeric PIDs happen to match.
    const procPids = fs.readFileSync('/proc/self/status', 'utf8').match(/^NSpid:\s+([^\n]+)$/m)?.[1].trim().split(/\s+/);
    if (procPids?.length !== 1 || Number(procPids[0]) !== process.pid) return undefined;
    const initStat = fs.readFileSync('/proc/1/stat', 'utf8');
    const initStartTicks = initStat.slice(initStat.lastIndexOf(')') + 2).split(' ')[19];
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    const ownerStartTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return bootId && pidNamespace && /^\d+$/.test(initStartTicks) && /^\d+$/.test(ownerStartTicks)
      ? { bootId, pidNamespace, initStartTicks, ownerPid: process.pid, ownerStartTicks } : undefined;
  } catch {
    return undefined;
  }
}

/** Read-only ownership check. Observing a HOME never claims or migrates it. */
export function hostProcessView(): HostProcessView | undefined {
  const view = currentProcessView();
  if (!view || process.platform !== 'linux') return view;
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(getTerminalsDir(), 'process-view.json'), 'utf8')) as HostProcessView;
    return sameProcessView(owner, view) ? view : undefined;
  } catch (error) {
    // The initial kernel namespace is authoritative before any daemon has
    // enrolled this HOME. This observation itself must remain read-only.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' && isInitialPidNamespace(view) ? view : undefined;
  }
}

/** Explicit writers may enroll a fresh HOME in their measured namespace.
 * Foreign ownership remains protected even when the prior writer is invisible.
 * The initial host may enroll legacy state before daemon startup. */
export function writerProcessView(): HostProcessView | undefined {
  const view = currentProcessView();
  if (!view || process.platform !== 'linux') return view;
  const file = path.join(getTerminalsDir(), 'process-view.json');
  try {
    if (fs.existsSync(file)) {
      const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as HostProcessView;
      return sameProcessView(owner, view) ? view : undefined;
    }
    // A foreign observer of legacy state must not even create a directory or
    // claim lock. Repeat this preflight under the lock before enrollment.
    if (hasLegacyState() && !isInitialPidNamespace(view)) return undefined;
    fs.mkdirSync(getTerminalsDir(), { recursive: true });
    return withFileLock(file, () => {
      if (fs.existsSync(file)) {
        const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as HostProcessView;
        return sameProcessView(owner, view) ? view : undefined;
      }
      // Unowned nonempty registry is not evidence this caller owns the host.
      if (hasLegacyState() && !isInitialPidNamespace(view)) return undefined;
      atomicWriteFileSync(file, JSON.stringify(view), 'utf8');
      return view;
    }, { realpath: false, acquireTimeoutMs: 0 });
  } catch { return undefined; }
}

/** Preflight BEFORE even the PID-keyed legacy lifecycle lock is inspected.
 * The same decision is repeated under that lock before daemon state changes. */
export function daemonProcessViewAllowed(): boolean {
  const view = currentProcessView();
  if (!view) return false;
  if (process.platform !== 'linux') return true;
  try {
    const file = path.join(getTerminalsDir(), 'process-view.json');
    if (!fs.existsSync(file)) return !hasLegacyState() || isInitialPidNamespace(view) || verifiedLegacyDaemon();
    const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as HostProcessView;
    if (sameProcessView(owner, view)) return true;
    return typeof owner.bootId === 'string' && !!owner.bootId && owner.bootId !== view.bootId
      && (isInitialPidNamespace(view) || verifiedLegacyDaemon());
  } catch { return false; }
}

/** Called by the canonical daemon writer before lifecycle mutation.
 * This is a writer statement, not an observer's guess about a numeric PID.
 * Existing same-boot ownership cannot be taken over from another namespace. */
export function recordDaemonProcessView(): void {
  const view = currentProcessView();
  if (!view) throw new Error('Cannot record daemon ownership from an incoherent process namespace');
  if (process.platform !== 'linux') return;
  const file = path.join(getTerminalsDir(), 'process-view.json');
  fs.mkdirSync(getTerminalsDir(), { recursive: true });
  withFileLock(file, () => {
    if (fs.existsSync(file)) {
      const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as HostProcessView;
      if (sameProcessView(owner, view)) return;
      if (typeof owner.bootId !== 'string' || !owner.bootId || owner.bootId === view.bootId || (!isInitialPidNamespace(view) && !verifiedLegacyDaemon())) {
        throw new Error('Another or unverified process namespace owns host session state; automatic reuse of a private-container HOME across namespaces is unsupported. Run in the owning namespace or use a fresh HOME.');
      }
    } else if (hasLegacyState() && !isInitialPidNamespace(view) && !verifiedLegacyDaemon()) {
      throw new Error('Legacy session state requires a verified live canonical daemon before namespace migration');
    }
    atomicWriteFileSync(file, JSON.stringify(view), 'utf8');
  }, { realpath: false, acquireTimeoutMs: 0 });
}

export function requireHostProcessView(): void {
  if (!hostProcessView()) throw new Error('Host session state is unavailable in this process namespace; read the host daemon snapshot or run sessions on the host.');
}

export function requireWriterProcessView(): void {
  if (!writerProcessView()) throw new Error('Host session state is unavailable in this process namespace; run the writer in its owning namespace or use a fresh HOME. Automatic reuse of a private-container HOME across namespaces is unsupported.');
}
