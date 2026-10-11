import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TerminalBackend, LaunchSpec, SplitDirection, EngineContext, SurfaceMeta } from '../types.js';

const EXTENSION_AUTHORITY = 'swarmify.swarm-ext';

export interface EditorVariant {
  cli: string;
  scheme: string;
  app: string;
  label: string;
  // Folder under ~/Library/Application Support holding the editor's user data.
  dataDir?: string;
}

export const EDITOR_VARIANTS: EditorVariant[] = [
  { cli: 'codium', scheme: 'vscodium', app: '/Applications/VSCodium.app', label: 'VSCodium', dataDir: 'VSCodium' },
  { cli: 'cursor', scheme: 'cursor', app: '/Applications/Cursor.app', label: 'Cursor', dataDir: 'Cursor' },
  { cli: 'code', scheme: 'vscode', app: '/Applications/Visual Studio Code.app', label: 'VS Code', dataDir: 'Code' },
];

function uriPath(uri: unknown): string | undefined {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return undefined;
  try {
    return decodeURIComponent(new URL(uri).pathname).replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function within(folder: string, root: string): boolean {
  return folder === root || folder.startsWith(root.endsWith('/') ? root : `${root}/`);
}

function workspaceFolders(configPath: string): string[] {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return (Array.isArray(config?.folders) ? config.folders : [])
      .map((f: { path?: unknown; uri?: unknown }) =>
        typeof f?.path === 'string' ? path.resolve(path.dirname(configPath), f.path) : uriPath(f?.uri))
      .filter((f: string | undefined): f is string => !!f);
  } catch {
    return [];
  }
}

// The editor keeps its open windows in globalStorage/storage.json (windowsState):
// each is a folder, or a workspace file whose roots are listed inside it.
function openEditorRoots(storageJson: string | undefined): { target: string; root: string }[] {
  let state: any;
  try {
    state = storageJson ? JSON.parse(fs.readFileSync(storageJson, 'utf8'))?.windowsState : undefined;
  } catch {
    return [];
  }
  const windows: any[] = [...(state?.openedWindows ?? []), ...(state?.lastActiveWindow ? [state.lastActiveWindow] : [])];
  const roots: { target: string; root: string }[] = [];
  for (const w of windows) {
    const single = uriPath(w?.folder);
    if (single) roots.push({ target: single, root: single });
    const config = uriPath(w?.workspaceIdentifier?.configURIPath ?? w?.workspace?.configPath);
    if (config) for (const root of workspaceFolders(config)) roots.push({ target: config, root });
  }
  return roots;
}

// What to pass to `codium` so the window already holding `folder` comes forward.
// A folder that is one root of a multi-root workspace window only matches that
// window through its workspace file; `codium <folder>` would open a new window.
export function editorWindowFor(folder: string, storageJson: string | undefined): string {
  let best: { target: string; root: string } | undefined;
  for (const r of openEditorRoots(storageJson)) {
    if (within(folder, r.root) && (!best || r.root.length > best.root.length)) best = r;
  }
  return best?.target ?? folder;
}

// An open window root named `project` — the only local trace of a peer session
// whose resolver row carries a project name but no path.
export function editorFolderNamed(project: string, storageJson: string | undefined): string | undefined {
  const roots = new Set(openEditorRoots(storageJson).map((r) => r.root).filter((r) => path.basename(r) === project));
  return roots.size === 1 ? [...roots][0] : undefined;
}

// A portable editor (VSCODE_PORTABLE, which the editor CLI also honours) keeps its
// user data inside that folder instead of ~/Library/Application Support.
export function storageJsonFor(variant: EditorVariant, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const userData = env.VSCODE_PORTABLE
    ? path.join(env.VSCODE_PORTABLE, 'user-data')
    : variant.dataDir ? path.join(os.homedir(), 'Library', 'Application Support', variant.dataDir) : undefined;
  return userData ? path.join(userData, 'User', 'globalStorage', 'storage.json') : undefined;
}

function appExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export function spawnUri(
  scheme: string,
  cwd: string,
  command: string[],
  direction?: SplitDirection,
  meta?: SurfaceMeta,
): string {

  const payload: {
    command: string;
    cwd: string;
    split?: SplitDirection;
    agent?: string;
    sessionId?: string;
    title?: string;
    nonce?: string;
    project?: string;
  } = {
    command: command.join(' '),
    cwd,
  };
  if (direction) payload.split = direction;
  if (meta?.agent) payload.agent = meta.agent;
  if (meta?.sessionId) payload.sessionId = meta.sessionId;
  if (meta?.title) payload.title = meta.title;
  if (meta?.nonce) payload.nonce = meta.nonce;
  if (meta?.project) payload.project = meta.project;
  const p = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${scheme}://${EXTENSION_AUTHORITY}/spawn?p=${p}`;
}

export function editorVariantForHost(host: string | undefined): EditorVariant | undefined {
  return host ? EDITOR_VARIANTS.find((v) => v.cli === host) : undefined;
}

export function focusUri(scheme: string, terminalId: string): string {
  return `${scheme}://${EXTENSION_AUTHORITY}/focus?terminalId=${encodeURIComponent(terminalId)}`;
}

// An --open-url lands in the last-focused window, so raise the folder's window first.
function inFolderWindowSpecs(variant: EditorVariant, folder: string, url: string): LaunchSpec[] {
  const bundled = `${variant.app}/Contents/Resources/app/bin/${variant.cli}`;
  const cli = appExists(bundled) ? bundled : variant.cli;
  return [
    { argv: [cli, folder] },
    { argv: [cli, '--open-url', url] },
  ];
}

export function focusTabSpecs(variant: EditorVariant, folder: string, terminalId: string): LaunchSpec[] {
  return inFolderWindowSpecs(variant, folder, focusUri(variant.scheme, terminalId));
}

export function makeVscodiumAgentBackend(variant: EditorVariant): TerminalBackend {
  return {
    id: 'vscodium-agent',
    label: `${variant.label} agent`,
    isAvailable(ctx: EngineContext): boolean {
      return ctx.platform === 'darwin' && appExists(variant.app);
    },
    buildTab(cwd: string, command: string[], meta?): LaunchSpec[] {
      const window = editorWindowFor(meta?.project ?? cwd, storageJsonFor(variant));
      return inFolderWindowSpecs(variant, window, spawnUri(variant.scheme, cwd, command, undefined, meta));
    },
    buildSplit(cwd: string, command: string[], direction: SplitDirection, meta?): LaunchSpec[] {
      const window = editorWindowFor(meta?.project ?? cwd, storageJsonFor(variant));
      return inFolderWindowSpecs(variant, window, spawnUri(variant.scheme, cwd, command, direction, meta));
    },
  };
}

export const vscodiumAgentBackend: TerminalBackend = makeVscodiumAgentBackend(EDITOR_VARIANTS[0]);

// The extension's answer to a /spawn carrying `nonce`: it writes
// ~/.swarmify/agents/spawn-acks/<nonce>.json once it opened the tab, focused the one
// already showing that session, or refused because the project is not its window's.
// Contract shared with agi-ext `SpawnAck` (src/core/spawn.ts); both sides test the
// same fixture, mirrored at testdata/spawn-ack.json.
export type SpawnAckStatus = 'opened' | 'focused-existing' | 'wrong-window' | 'failed';

export interface SpawnAck {
  nonce: string;
  status: SpawnAckStatus;
  windowFolders: string[];
  workspaceName?: string;
  terminalId?: string;
  title?: string;
  sessionId?: string;
  pid?: number;
  // Why a failed / wrong-window ack happened, in the extension's words.
  reason?: string;
  at: number;
}

const ACK_STATUSES: readonly SpawnAckStatus[] = ['opened', 'focused-existing', 'wrong-window', 'failed'];

// Longer than the extension's own wait for the tab's process (10 s), so a `failed`
// ack is read rather than reported as silence.
export const SPAWN_ACK_TIMEOUT_MS = 15_000;
const SPAWN_ACK_POLL_MS = 200;

export function spawnAckRelPath(nonce: string): string {
  return `.swarmify/agents/spawn-acks/${nonce}.json`;
}

export function localSpawnAckPath(nonce: string): string {
  return path.join(os.homedir(), spawnAckRelPath(nonce));
}

export function parseSpawnAck(raw: string, nonce: string): SpawnAck | undefined {
  let v: any;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!v || v.nonce !== nonce || !ACK_STATUSES.includes(v.status)) return undefined;
  const str = (x: unknown): string | undefined => (typeof x === 'string' && x ? x : undefined);
  return {
    nonce,
    status: v.status,
    windowFolders: Array.isArray(v.windowFolders) ? v.windowFolders.filter((f: unknown): f is string => typeof f === 'string') : [],
    workspaceName: str(v.workspaceName),
    terminalId: str(v.terminalId),
    title: str(v.title),
    sessionId: str(v.sessionId),
    pid: typeof v.pid === 'number' ? v.pid : undefined,
    reason: str(v.reason),
    at: typeof v.at === 'number' ? v.at : 0,
  };
}

export async function awaitSpawnAck(
  nonce: string,
  read: () => string | undefined,
  timeoutMs: number = SPAWN_ACK_TIMEOUT_MS,
): Promise<SpawnAck | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const raw = read();
    const ack = raw === undefined ? undefined : parseSpawnAck(raw, nonce);
    if (ack) return ack;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, SPAWN_ACK_POLL_MS));
  }
}

export function ackLandedIn(ack: SpawnAck, project: string | undefined): boolean {
  if (ack.status === 'wrong-window' || ack.status === 'failed') return false;
  if (!project) return true;
  return ack.windowFolders.some((f) => within(project, f));
}
