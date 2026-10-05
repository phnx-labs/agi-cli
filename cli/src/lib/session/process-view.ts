import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getCacheDir, getTerminalsDir, getDaemonDir } from '../state.js';
import { atomicWriteFileSync, withFileLock } from '../fs-atomic.js';

export interface HostProcessView {
  bootId?: string;
  pidNamespace?: string;
  initStartTicks?: string;
  ownerPid?: number;
  ownerStartTicks?: string;
}

function isInitialPidNamespace(view: HostProcessView): boolean {
  return view.pidNamespace === 'pid:[4026531836]';
}

function sameProcessView(owner: HostProcessView, view: HostProcessView): boolean {
  return owner.bootId === view.bootId && owner.pidNamespace === view.pidNamespace
    && owner.initStartTicks === view.initStartTicks;
}
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
    || ['daemon.pid', 'daemon.lifetime', 'heartbeat.json'].some(file => fs.existsSync(path.join(getDaemonDir(), file)))
    || fs.existsSync(path.join(getCacheDir(), 'helpers', 'browser', 'browser.sock'))
    || ['.active-sessions.json', '.active-session-immutable.json'].some(file => fs.existsSync(path.join(getCacheDir(), file)));
}

export function currentProcessView(): HostProcessView | undefined {
  if (process.platform !== 'linux') return {};
  try {
    if (Number(fs.readFileSync('/proc/self/stat', 'utf8').split(' ', 1)[0]) !== process.pid) return undefined;
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const pidNamespace = fs.readlinkSync('/proc/self/ns/pid');
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

export function hostProcessView(): HostProcessView | undefined {
  const view = currentProcessView();
  if (!view || process.platform !== 'linux') return view;
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(getTerminalsDir(), 'process-view.json'), 'utf8')) as HostProcessView;
    return sameProcessView(owner, view) ? view : undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' && isInitialPidNamespace(view) ? view : undefined;
  }
}

export function writerProcessView(): HostProcessView | undefined {

  const view = currentProcessView();
  if (!view || process.platform !== 'linux') return view;
  const file = path.join(getTerminalsDir(), 'process-view.json');
  try {
    if (fs.existsSync(file)) {
      const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as HostProcessView;
      return sameProcessView(owner, view) ? view : undefined;
    }
    if (hasLegacyState() && !isInitialPidNamespace(view)) return undefined;
    fs.mkdirSync(getTerminalsDir(), { recursive: true });
    return withFileLock(file, () => {
      if (fs.existsSync(file)) {
        const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as HostProcessView;
        return sameProcessView(owner, view) ? view : undefined;
      }
      if (hasLegacyState() && !isInitialPidNamespace(view)) return undefined;
      atomicWriteFileSync(file, JSON.stringify(view), 'utf8');
      return view;
    }, { realpath: false, acquireTimeoutMs: 0 });
  } catch { return undefined; }
}

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
