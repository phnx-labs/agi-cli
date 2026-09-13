/**
 * Run-name index: the join between a `agents run --name <slug>` handle and the
 * session id of the run it named.
 *
 * `agents run` records `<sessionId>.json` here at launch whenever both a name
 * and a session id are known up front (Claude pre-mints its id — see spawnAgent;
 * a teams teammate's Claude session id is its agent id). The session-discovery
 * pass reads these sidecars and SEEDS the session label by id (via
 * seedLabelsFromNames) — the launch handle becomes the label, refined later by an
 * agent-generated title. Idempotent and re-applied every scan, so seeds survive
 * transcript rescans without being parsed out of the transcript itself.
 *
 * Mirrors the host-task sidecar convention (`~/.agents/.cache/hosts/<id>.json`),
 * one small JSON per run under `~/.agents/.cache/run-names/`.
 */

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

/**
 * Record a run's `--name` handle keyed by its session id. Best-effort: a failed
 * write must never break the run itself. No-op without both a name and id.
 */
export function recordRunName(rec: Omit<RunNameRecord, 'ts'>): void {
  if (!rec.sessionId || !rec.name) return;
  try {
    fs.mkdirSync(runNamesDir(), { recursive: true });
    fs.writeFileSync(recordFile(rec.sessionId), JSON.stringify({ ...rec, ts: Date.now() }, null, 2));
  } catch {
    /* the run is already launching; the name is a convenience, not load-bearing */
  }
}

/**
 * Build the sessionId → name map from every run-name sidecar, for
 * seedLabelsFromNames to apply onto the index as label seeds. Returns an empty
 * map when the dir doesn't exist yet.
 */
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
