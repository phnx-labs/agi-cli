/**
 * System-layer skills and subagents refresh at `agents run` launch time.
 *
 * `agents sync <harness>@all system` rewrites every version home, but nothing
 * runs it when the `.system` mirror moves: the shim's `--launch` path compiles
 * project rules and mirrors project resources only, and the SessionStart
 * autosync fires the umbrella at most once per 4 h. Rules already close that
 * gap per run (`rules/run-sync.ts`); skills and subagents did not, so a merged
 * system-layer skill change left 31 of 33 installed copies on the old text
 * (PHNX-4056). This is the same shape as the rules run-sync: a small per-
 * (agent, version) sentinel of source fingerprints, stat-tier comparison, and
 * a write through the registered writers only when a source file changed.
 *
 * Scope: the system layer's `skills/` and `subagents/` directories. The
 * writers resolve each name through the normal precedence (a user-layer
 * shadow still wins), and the active resource profile filters skill names the
 * same way `syncResourcesToVersion` does. Never blocks a launch: any failure
 * is swallowed, the next run retries.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from './types.js';
import { getCacheDir, getSystemSkillsDir, getSystemSubagentsDir } from './state.js';
import { getWriter } from './staleness/registry.js';
import { fingerprintDir, isDirStale, type Fingerprint } from './staleness/fingerprint.js';
import { filterNamesForActiveResourceProfile } from './resource-profiles.js';

interface KindSentinel { dir: string; files: Fingerprint[] }
interface SystemRunSentinel { skills?: KindSentinel; subagents?: KindSentinel }

/** ~/.agents/.cache/system-run-sync/ — regenerable; a lost sentinel costs one extra write. */
function sentinelPath(agent: AgentId, version: string): string {
  const key = `${agent}@${version}`.replace(/[^a-zA-Z0-9@._-]/g, '_');
  return path.join(getCacheDir(), 'system-run-sync', `${key}.json`);
}

function loadSentinel(agent: AgentId, version: string): SystemRunSentinel {
  try {
    return JSON.parse(fs.readFileSync(sentinelPath(agent, version), 'utf-8')) as SystemRunSentinel;
  } catch {
    return {};
  }
}

function saveSentinel(agent: AgentId, version: string, sentinel: SystemRunSentinel): void {
  const p = sentinelPath(agent, version);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(sentinel));
  } catch {
    // Best-effort — a failed write just means the next run redoes the copy.
  }
}

/** Subdirectories of `dir` that carry `marker` (SKILL.md / AGENT.md). */
function namesWithMarker(dir: string, marker: string): Map<string, string> {
  const out = new Map<string, string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const src = path.join(dir, e.name, marker);
    if (fs.existsSync(src)) out.set(e.name, src);
  }
  return out;
}

export interface SystemRunSyncResult {
  /** Names rewritten per kind; empty when the sentinel matched (skip-fast). */
  skills: string[];
  subagents: string[];
}

/**
 * Refresh the system layer's skills and subagents into the version home when
 * their source directories changed since the last run for (agent, version).
 */
export function applySystemResourcesAtRun(
  agent: AgentId,
  version: string,
  versionHome: string,
): SystemRunSyncResult {
  const result: SystemRunSyncResult = { skills: [], subagents: [] };
  const stored = loadSentinel(agent, version);
  const next: SystemRunSentinel = { ...stored };

  const kinds: Array<{ kind: 'skills' | 'subagents'; dir: string; marker: string }> = [
    { kind: 'skills', dir: getSystemSkillsDir(), marker: 'SKILL.md' },
    { kind: 'subagents', dir: getSystemSubagentsDir(), marker: 'AGENT.md' },
  ];

  for (const { kind, dir, marker } of kinds) {
    if (!fs.existsSync(dir)) continue;
    const prev = stored[kind];
    if (prev && prev.dir === dir && !isDirStale(prev.dir, prev.files, dir)) continue;

    const writer = getWriter(kind, agent);
    if (!writer) continue;
    const sources = namesWithMarker(dir, marker);
    let names = Array.from(sources.keys());
    if (kind === 'skills') {
      names = filterNamesForActiveResourceProfile('skills', names, sources);
    }
    if (names.length === 0) {
      next[kind] = { dir, files: fingerprintDir(dir) };
      continue;
    }
    try {
      const written = writer.write({ version, versionHome, selection: names, cwd: '' });
      result[kind] = written.synced;
    } catch {
      continue; // leave the sentinel stale so the next run retries
    }
    next[kind] = { dir, files: fingerprintDir(dir) };
  }

  if (JSON.stringify(next) !== JSON.stringify(stored)) saveSentinel(agent, version, next);
  return result;
}
