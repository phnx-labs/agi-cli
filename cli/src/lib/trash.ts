import * as fs from 'fs';
import * as path from 'path';
import { getTrashDir, getTrashFilesDir } from './state.js';

// Depth below each category at which one trashed item sits, mirroring its writer
// (softDeleteVersionDir, the hook/command/skill/subagent removers, removeWorkflow,
// the account-home migration).
// Any other top-level child (a dedupe batch, a loose dir) is one item itself.
const ITEM_DEPTH: Record<string, number> = {
  versions: 3,
  homes: 3,
  hooks: 4,
  commands: 3,
  skills: 3,
  subagents: 3,
  plugins: 1,
  workflows: 1,
  files: 1,
};

export interface TrashItem {
  path: string;
  trashedAtMs: number;
}

function childrenAtDepth(dir: string, depth: number): string[] {
  if (depth === 0) return [dir];
  let names: string[];
  try {
    if (!fs.statSync(dir).isDirectory()) return [];
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => childrenAtDepth(path.join(dir, name), depth - 1));
}

// A move into the trash changes the item's inode, so ctime is when it was trashed.
export function listTrashItems(root = getTrashDir()): TrashItem[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names
    .flatMap((name) => childrenAtDepth(path.join(root, name), ITEM_DEPTH[name] ?? 0))
    .map((item) => ({ path: item, trashedAtMs: fs.lstatSync(item).ctimeMs }));
}

function removeEmptyParents(item: string, root: string): void {
  for (let dir = path.dirname(item); dir !== root && dir.startsWith(root); dir = path.dirname(dir)) {
    try {
      if (fs.readdirSync(dir).length > 0) return;
      fs.rmdirSync(dir);
    } catch {
      return;
    }
  }
}

export function emptyTrash(
  opts: { olderThanMs?: number; now?: number; root?: string } = {},
): { removed: TrashItem[]; kept: number } {
  const root = opts.root ?? getTrashDir();
  const now = opts.now ?? Date.now();
  const items = listTrashItems(root);
  const removed: TrashItem[] = [];
  for (const item of items) {
    if (opts.olderThanMs !== undefined && now - item.trashedAtMs < opts.olderThanMs) continue;
    fs.rmSync(item.path, { recursive: true, force: true });
    removeEmptyParents(item.path, root);
    removed.push(item);
  }
  return { removed, kept: items.length - removed.length };
}

export function moveFileToTrash(file: string): string {
  const dir = getTrashFilesDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ext = path.extname(file);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `${path.basename(file, ext)}-${stamp}${ext}`);
  fs.renameSync(file, dest);
  return dest;
}
