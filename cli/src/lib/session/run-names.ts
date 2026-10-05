
import * as fs from 'fs';
import * as path from 'path';
import { getCacheDir } from '../state.js';

interface RunNameRecord {
  sessionId: string;
  name: string;
  agent: string;
  cwd?: string;
  ts: number;
}

export function runNamesDir(): string {
  return path.join(getCacheDir(), 'run-names');
}

function recordFile(sessionId: string): string {
  return path.join(runNamesDir(), `${sessionId}.json`);
}

export function recordRunName(rec: Omit<RunNameRecord, 'ts'>): void {
  if (!rec.sessionId || !rec.name) return;
  try {
    fs.mkdirSync(runNamesDir(), { recursive: true });
    fs.writeFileSync(recordFile(rec.sessionId), JSON.stringify({ ...rec, ts: Date.now() }, null, 2));
  } catch {
  }
}

export function buildRunNameMap(): Map<string, string | null> {
  const map = new Map<string, string | null>();
  let files: string[];
  try {
    files = fs.readdirSync(runNamesDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return map;
  }
  for (const f of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(runNamesDir(), f), 'utf-8')) as RunNameRecord;
      if (rec.sessionId && rec.name) map.set(rec.sessionId, rec.name);
    } catch {
    }
  }
  return map;
}
