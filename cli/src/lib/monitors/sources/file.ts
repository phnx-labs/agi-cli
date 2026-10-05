
import * as fs from 'fs';
import * as path from 'path';
import { followFile } from '../../log-follow.js';
import type { MonitorSource } from '../config.js';
import type { Observation } from './types.js';

const MAX_CONTENT = 256 * 1024;

export function evaluate(source: MonitorSource): Promise<Observation | null> {
  const filePath = source.path;
  if (!filePath) return Promise.resolve(null);

  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      const entries = fs
        .readdirSync(filePath, { withFileTypes: true })
        .map((e) => {
          try {
            const s = fs.statSync(path.join(filePath, e.name));
            return `${e.name}\t${s.size}\t${Math.round(s.mtimeMs)}`;
          } catch {
            return `${e.name}\t?`;
          }
        })
        .sort();
      return Promise.resolve({
        raw: entries.join('\n'),
        meta: { kind: 'directory', count: entries.length },
      });
    }
    let content = fs.readFileSync(filePath, 'utf-8');
    if (content.length > MAX_CONTENT) content = content.slice(content.length - MAX_CONTENT);
    return Promise.resolve({
      raw: content,
      meta: { kind: 'file', size: stat.size, mtimeMs: Math.round(stat.mtimeMs) },
    });
  } catch (err) {
    return Promise.resolve({ raw: `missing: ${(err as Error).message}`, meta: { kind: 'missing' } });
  }
}

export function subscribe(source: MonitorSource, onObs: (obs: Observation) => void): () => void {
  const filePath = source.path;
  if (!filePath) return () => {};
  return followFile(filePath, (text) => onObs({ raw: text, meta: { kind: 'append' } }), { fromEnd: true });
}
