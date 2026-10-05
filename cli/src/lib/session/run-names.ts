/** Run-name index: joins an `agents run --name <slug>` handle to its session id via
 * `<sessionId>.json` sidecars in `~/.agents/.cache/run-names/`. Discovery seeds the label by id
 * (seedLabelsFromNames); idempotent each scan. */

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

/** Record a run's `--name` handle keyed by session id. Best-effort: a failed write must never
 * break the run. No-op without both a name and id. */
export function recordRunName(rec: Omit<RunNameRecord, 'ts'>): void {
  if (!rec.sessionId || !rec.name) return;
  try {
    fs.mkdirSync(runNamesDir(), { recursive: true });
    fs.writeFileSync(recordFile(rec.sessionId), JSON.stringify({ ...rec, ts: Date.now() }, null, 2));
  } catch {
    /* the run is already launching; the name is a convenience, not load-bearing */
  }
}

/** Build the sessionId -> name map from every run-name sidecar, for seedLabelsFromNames. Empty
 * map if the dir does not exist yet. */
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
      /* skip a corrupt sidecar */
    }
  }
  return map;
}
