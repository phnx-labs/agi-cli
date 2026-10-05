
import * as fs from 'fs';
import * as path from 'path';
import { getTmuxDir } from '../state.js';

export function getDefaultSocketPath(): string {
  return path.join(getTmuxDir(), 'server.sock');
}

export function getSessionMetaPath(name: string): string {
  return path.join(getTmuxDir(), `${name}.json`);
}

export function ensureTmuxDir(): string {
  const dir = getTmuxDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}
