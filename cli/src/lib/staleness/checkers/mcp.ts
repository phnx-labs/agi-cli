
import { fingerprintFile, isFileStale } from '../fingerprint.js';
import { listMcpServerConfigs } from '../../mcp.js';
import type { FileEntry } from '../types.js';
import type { TypedResourceChecker } from './types.js';

function indexByName(cwd: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const cfg of listMcpServerConfigs(cwd)) {
    if (!map.has(cfg.name)) map.set(cfg.name, cfg.path);
  }
  return map;
}

export const mcpChecker: TypedResourceChecker<FileEntry> = {
  type: 'mcp',

  listNames(cwd) {
    return Array.from(indexByName(cwd).keys());
  },

  build(name, cwd) {
    const src = indexByName(cwd).get(name);
    if (!src) return null;
    const fp = fingerprintFile(src);
    return fp ? { source: fp } : null;
  },

  isFresh(name, stored, cwd) {
    const src = indexByName(cwd).get(name);
    if (!src) return false;
    return !isFileStale(stored.source, src);
  },
};
