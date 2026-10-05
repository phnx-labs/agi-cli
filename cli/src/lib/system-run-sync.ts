import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from './types.js';
import { getCacheDir, getSystemSkillsDir, getSystemSubagentsDir } from './state.js';
import { getWriter } from './staleness/registry.js';
import { fingerprintDir, isDirStale, type Fingerprint } from './staleness/fingerprint.js';
import { filterNamesForActiveResourceProfile } from './resource-profiles.js';

interface KindSentinel { dir: string; files: Fingerprint[] }
interface SystemRunSentinel { skills?: KindSentinel; subagents?: KindSentinel }

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

interface SystemRunSyncResult {
  skills: string[];
  subagents: string[];
}

export function applySystemResourcesAtRun(
  agent: AgentId,
  version: string,
  versionHome: string,
): SystemRunSyncResult {
  // Refresh only system skills/subagents under normal precedence; failures never block launch and leave the sentinel stale for retry.
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
    const names = filterNamesForActiveResourceProfile(kind, Array.from(sources.keys()), sources);
    if (names.length === 0) {
      next[kind] = { dir, files: fingerprintDir(dir) };
      continue;
    }
    let written;
    try {
      written = writer.write({ version, versionHome, selection: names, cwd: '' });
    } catch {
      continue;
    }
    result[kind] = written.synced;
    if (written.errors?.length) continue;
    next[kind] = { dir, files: fingerprintDir(dir) };
  }

  if (JSON.stringify(next) !== JSON.stringify(stored)) saveSentinel(agent, version, next);
  return result;
}
