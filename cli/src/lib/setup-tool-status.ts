import * as fs from 'node:fs';
import * as path from 'node:path';
import { findInPath } from './agent-spec/agents.js';
import { getCacheDir, getDeviceMetaPath, getHelpersDir, getUserAgentsDir } from './state.js';
import { atomicWriteJsonSync, withFileLockAsync } from './fs-atomic.js';
import { probeCapture } from './probe.js';
import { invocation, isStandaloneComputer } from './computer-client.js';
import { getSocketPath as browserSocketPath } from './browser/ipc.js';

export const SETUP_TOOLS = ['browser', 'computer', 'secrets', 'term'] as const;
export type SetupTool = typeof SETUP_TOOLS[number];
export interface ToolSetupRow {
  tool: SetupTool;
  installed: boolean | null;
  executable?: string;
  version?: string;
  readiness: 'ready' | 'needs-setup' | 'permission-required' | 'stopped' | 'unsupported' | 'unknown';
  detail: string;
  checkedAtMs: number | null;
}
interface CachedTool { v: 1; fingerprint: string; row: ToolSetupRow }
export interface ToolSetupOptions { cacheDir?: string }

export function toolSetupCacheDir(options: ToolSetupOptions = {}): string {
  return path.join(options.cacheDir ?? getCacheDir(), 'setup-tools');
}
function cachePath(tool: SetupTool, options: ToolSetupOptions): string {
  return path.join(toolSetupCacheDir(options), `${tool}.json`);
}

function setupInputs(tool: SetupTool): string[] {
  const inputs = [path.join(getUserAgentsDir(), 'agents.yaml'), getDeviceMetaPath()];
  if (tool === 'browser') inputs.push(browserSocketPath());
  if (tool === 'computer') inputs.push(process.env.COMPUTER_HELPER_SOCKET || path.join(getHelpersDir(), 'computer.sock'));
  return inputs;
}

function inputStamp(tool: SetupTool): string {
  return setupInputs(tool).map((file) => {
    try { const stat = fs.statSync(file); return `${file}:${stat.ino}:${stat.mtimeMs}:${stat.size}`; }
    catch { return `${file}:missing`; }
  }).join('|');
}

function binaryMetadata(tool: SetupTool): { row: ToolSetupRow; fingerprint: string } {
  const empty: ToolSetupRow = { tool, installed: false, readiness: 'needs-setup', detail: 'CLI is not installed.', checkedAtMs: null };
  try {
    const explicit = process.env[`${tool.toUpperCase()}_BIN`]?.trim();
    const accept = (candidate: string): boolean => {
      if (tool === 'computer') return isStandaloneComputer(candidate);
      if (tool === 'browser') {
        try { return !fs.realpathSync(candidate).endsWith(path.join('dist', 'browser.js')); } catch { return false; }
      }
      return true;
    };
    let executable = explicit ? (accept(explicit) ? explicit : null) : findInPath(tool, { accept });
    if (!executable) return { row: empty, fingerprint: 'missing' };
    if (/\.(cmd|ps1)$/i.test(executable)) {
      const packageDir = path.join(path.dirname(executable), 'node_modules', '@phnx-labs', `${tool}-cli`);
      const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
      const entry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[tool];
      if (pkg.name !== `@phnx-labs/${tool}-cli` || typeof entry !== 'string') throw new Error('unrecognized npm launcher');
      const resolved = path.resolve(packageDir, entry);
      if (!resolved.startsWith(`${path.resolve(packageDir)}${path.sep}`)) throw new Error('invalid npm entrypoint');
      executable = resolved;
    }
    fs.accessSync(executable, process.platform === 'win32' || /\.[cm]?js$/i.test(executable) ? fs.constants.R_OK : fs.constants.X_OK);
    const real = fs.realpathSync(executable);
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw new Error('not a file');
    let version: string | undefined;
    let dir = path.dirname(real);
    for (let depth = 0; depth < 5; depth++) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        if (pkg.name === `@phnx-labs/${tool}-cli` && typeof pkg.version === 'string') { version = pkg.version; break; }
      } catch { /* Executables need not be npm packages. */ }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return {
      fingerprint: `${real}:${stat.size}:${stat.mtimeMs}:${version ?? ''}|${inputStamp(tool)}`,
      row: { tool, installed: true, executable, version, readiness: 'unknown', detail: 'Installed. Health has not been checked.', checkedAtMs: null },
    };
  } catch {
    return { fingerprint: 'unavailable', row: { ...empty, installed: null, readiness: 'unknown', detail: 'Executable could not be inspected.' } };
  }
}

function readCache(tool: SetupTool, options: ToolSetupOptions): CachedTool | null {
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath(tool, options), 'utf8')) as CachedTool;
    if (cached.v === 1 && cached.row?.tool === tool && typeof cached.fingerprint === 'string') return cached;
  } catch { /* No health result yet. */ }
  return null;
}

/** Presence is metadata; health is the last explicit check, never a timer probe. */
export function getCachedToolSetup(options: ToolSetupOptions = {}): ToolSetupRow[] {
  return SETUP_TOOLS.map((tool) => {
    const { row, fingerprint } = binaryMetadata(tool);
    const cached = readCache(tool, options);
    return cached?.fingerprint === fingerprint ? { ...cached.row, executable: row.executable, version: row.version } : row;
  });
}

export function toolReadiness(tool: SetupTool, status: unknown): Pick<ToolSetupRow, 'readiness' | 'detail'> {
  if (!status || typeof status !== 'object') return { readiness: 'unknown', detail: 'The CLI returned an unreadable health result.' };
  const value = status as Record<string, unknown>;
  if (tool === 'computer') {
    if (value.installed === false) return { readiness: 'needs-setup', detail: 'CLI installed; computer helper needs setup.' };
    if (value.running === true && value.trusted === true) return { readiness: 'ready', detail: 'Helper is running and Accessibility is granted. Screen Recording is checked when capturing.' };
    if (value.running === true && value.trusted === false) return { readiness: 'permission-required', detail: 'Grant Accessibility to Agents Computer in System Settings.' };
    if (value.running === false) return { readiness: 'stopped', detail: 'Computer helper is stopped or unreachable.' };
  }
  if (tool === 'browser') {
    if (value.running === true) return { readiness: 'ready', detail: 'Browser service is running.' };
    if (value.running === false) return { readiness: 'stopped', detail: 'Browser service is stopped.' };
  }
  return { readiness: 'unknown', detail: typeof value.error === 'string' && value.error.trim() ? value.error.slice(0, 500) : 'The CLI did not report a recognized health state.' };
}

async function checkTool(row: ToolSetupRow): Promise<ToolSetupRow> {
  if (!row.installed || !row.executable) return { ...row, checkedAtMs: Date.now() };
  // The standalone has no non-interactive health JSON. Do not list bundles or
  // unlock the broker merely to paint a settings row.
  if (row.tool === 'secrets') return { ...row, checkedAtMs: Date.now(), detail: 'Installed. Secret access is checked when used; this check does not unlock secrets.' };
  // term is a headless PTY engine with no `status --json` health surface; it is
  // spawned on demand by the setup-token mint (`agents accounts add`/`login`,
  // via auth-mint.ts → term-driver.ts, the sole term-client consumers).
  // Presence on PATH is the whole readiness signal — do not probe it.
  if (row.tool === 'term') return { ...row, readiness: 'ready', detail: 'Installed. Spawned on demand by `agents accounts add`/`login`.', checkedAtMs: Date.now() };
  try {
    const { command, prefix } = invocation(row.executable);
    const { stdout } = await probeCapture(command, [...prefix, 'status', '--json'], 8000, { acceptedExitCodes: [0, 1], maxOutputBytes: 256 * 1024 });
    return { ...row, ...toolReadiness(row.tool, JSON.parse(stdout)), checkedAtMs: Date.now() };
  } catch {
    return { ...row, readiness: 'unknown', detail: 'Health check failed or timed out. Check again to retry.', checkedAtMs: Date.now() };
  }
}

/** A shared disk lock coalesces overlapping requests from separate CLI clients. */
export async function refreshToolSetup(tool: SetupTool | 'all' = 'all', options: ToolSetupOptions = {}): Promise<ToolSetupRow[]> {
  const requestedAt = Date.now();
  const dir = toolSetupCacheDir(options);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const selected of tool === 'all' ? SETUP_TOOLS : [tool]) {
    const file = cachePath(selected, options);
    await withFileLockAsync(file, async () => {
      const metadata = binaryMetadata(selected);
      const cached = readCache(selected, options);
      if (cached?.fingerprint === metadata.fingerprint && (cached.row.checkedAtMs ?? 0) >= requestedAt) return;
      const row = await checkTool(metadata.row);
      atomicWriteJsonSync(file, { v: 1, fingerprint: metadata.fingerprint, row } satisfies CachedTool);
    }, { realpath: false, acquireTimeoutMs: 20_000 });
  }
  return getCachedToolSetup(options).filter((row) => tool === 'all' || row.tool === tool);
}

/** File notifications are shared by the daemon collector; no background probes. */
export function subscribeToolSetup(listener: (rows: ToolSetupRow[]) => void, options: ToolSetupOptions = {}): () => void {
  const dir = toolSetupCacheDir(options);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const paths = new Set([dir, ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)]);
  for (const tool of SETUP_TOOLS) for (const input of setupInputs(tool)) paths.add(path.dirname(input));
  for (const row of getCachedToolSetup(options)) {
    if (row.executable) {
      paths.add(path.dirname(row.executable));
      try { paths.add(path.dirname(fs.realpathSync(row.executable))); } catch { /* Removed since discovery. */ }
    }
  }
  let previous = JSON.stringify(getCachedToolSetup(options));
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = undefined;
      const rows = getCachedToolSetup(options);
      const next = JSON.stringify(rows);
      if (next !== previous) { previous = next; listener(rows); }
    }, 150);
    debounce.unref();
  };
  const watchers: fs.FSWatcher[] = [];
  for (const target of paths) {
    try { const watcher = fs.watch(target, { persistent: false }, changed); watcher.on('error', changed); watchers.push(watcher); }
    catch { /* Absent PATH entries have no executable to report. */ }
  }
  changed();
  return () => { if (debounce) clearTimeout(debounce); for (const watcher of watchers) watcher.close(); };
}
