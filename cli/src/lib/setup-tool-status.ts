import * as fs from 'node:fs';
import * as path from 'node:path';
import { findInPath } from './agent-spec/agents.js';
import { getCacheDir, getDeviceMetaPath, getHelpersDir, getUserAgentsDir } from './state.js';
import { atomicWriteJsonSync, withFileLockAsync } from './fs-atomic.js';
import { probeCapture } from './probe.js';
import { invocation, isStandaloneComputer } from './computer-client.js';
import { isStandaloneBrowser } from './browser-client.js';

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
  if (tool === 'browser') inputs.push(path.join(getHelpersDir(), 'browser', 'browser.sock'));
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
      if (tool === 'browser') return isStandaloneBrowser(candidate);
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
      } catch {  }
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
  } catch {  }
  return null;
}

export function getCachedToolSetup(options: ToolSetupOptions = {}): ToolSetupRow[] {
  // Cached presence is metadata; health changes only on explicit refresh, never a timer.
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
  // Settings UI never unlocks secrets; term PATH presence alone is readiness.
  if (!row.installed || !row.executable) return { ...row, checkedAtMs: Date.now() };
  if (row.tool === 'secrets') return { ...row, checkedAtMs: Date.now(), detail: 'Installed. Secret access is checked when used; this check does not unlock secrets.' };
  if (row.tool === 'term') return { ...row, readiness: 'ready', detail: 'Installed. Spawned on demand by `agents accounts add`/`login`.', checkedAtMs: Date.now() };
  try {
    const { command, prefix } = invocation(row.executable);
    const { stdout } = await probeCapture(command, [...prefix, 'status', '--json'], 8000, { acceptedExitCodes: [0, 1], maxOutputBytes: 256 * 1024 });
    return { ...row, ...toolReadiness(row.tool, JSON.parse(stdout)), checkedAtMs: Date.now() };
  } catch {
    return { ...row, readiness: 'unknown', detail: 'Health check failed or timed out. Check again to retry.', checkedAtMs: Date.now() };
  }
}

export async function refreshToolSetup(tool: SetupTool | 'all' = 'all', options: ToolSetupOptions = {}): Promise<ToolSetupRow[]> {
  // A disk lock coalesces concurrent clients around one explicit probe.
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

export function subscribeToolSetup(listener: (rows: ToolSetupRow[]) => void, options: ToolSetupOptions = {}): () => void {
  // Subscribers watch cache/input files only; they never initiate health probes.
  const dir = toolSetupCacheDir(options);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const paths = new Set([dir, ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)]);
  for (const tool of SETUP_TOOLS) for (const input of setupInputs(tool)) paths.add(path.dirname(input));
  for (const row of getCachedToolSetup(options)) {
    if (row.executable) {
      paths.add(path.dirname(row.executable));
      try { paths.add(path.dirname(fs.realpathSync(row.executable))); } catch {  }
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
    catch {  }
  }
  changed();
  return () => { if (debounce) clearTimeout(debounce); for (const watcher of watchers) watcher.close(); };
}
