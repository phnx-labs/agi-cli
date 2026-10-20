import * as fs from 'node:fs';
import * as path from 'node:path';
import { getUserAgentsDir } from '../state.js';
import { ipcEndpoint } from '../platform/ipc.js';
import { isSafeProjectName } from '../projects.js';

const MAX_SOCKET_PATH = 100;

export function leadRoot(): string {
  return path.join(getUserAgentsDir(), 'lead');
}

export function ensureLeadRoot(): string {
  const root = leadRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const ignore = path.join(root, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  return root;
}

export function assertLeadProject(project: string): void {
  if (!isSafeProjectName(project)) {
    throw new Error(`Invalid project name '${project}'. Use the name from 'agents projects list'.`);
  }
}

export interface LeadPaths {
  dir: string;
  session: string;
  memory: string;
  history: string;
  host: string;
  log: string;
  out: string;
  lock: string;
  settings: string;
  bin: string;
  runs: string;
  socket: string;
  endpoint: string;
}

export function leadPaths(project: string): LeadPaths {
  assertLeadProject(project);
  const dir = path.join(leadRoot(), project);
  const socket = path.join(dir, 'host.sock');
  if (process.platform !== 'win32' && socket.length > MAX_SOCKET_PATH) {
    throw new Error(`Lead socket path is ${socket.length} characters, over the ${MAX_SOCKET_PATH}-character unix socket limit: ${socket}`);
  }
  return {
    dir,
    session: path.join(dir, 'session.json'),
    memory: path.join(dir, 'memory.md'),
    history: path.join(dir, 'history.ndjson'),
    host: path.join(dir, 'host.json'),
    log: path.join(dir, 'host.log'),
    out: path.join(dir, 'host.out'),
    lock: path.join(dir, 'host.lock'),
    settings: path.join(dir, 'lead-settings.json'),
    bin: path.join(dir, 'bin'),
    runs: path.join(dir, 'runs'),
    socket,
    endpoint: ipcEndpoint(socket),
  };
}

export function ensureLeadDir(project: string): LeadPaths {
  ensureLeadRoot();
  const paths = leadPaths(project);
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  return paths;
}

export function confirmsDir(): string {
  return path.join(leadRoot(), 'confirms');
}

export function listLeadProjects(): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(leadRoot());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter((name) => name !== 'confirms' && name !== 'drafts' && isSafeProjectName(name))
    .filter((name) => fs.statSync(path.join(leadRoot(), name)).isDirectory())
    .sort();
}
