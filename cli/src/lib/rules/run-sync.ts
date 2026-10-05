/** Re-apply the active rules preset at `agents run` launch. `agents rules switch` recompiles only
 * at switch time, so a later subrule change left the harness on stale rules. Idempotent and
 * skip-fast: an mtime+size sentinel per (agent, version) costs one JSON read and a few `stat()`s. */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from '../types.js';
import { AGENTS } from '../agents.js';
import { getActiveRulesPreset, getCacheDir } from '../state.js';
import { getWriter } from '../staleness/registry.js';
import { buildRules, isRulesStale } from '../staleness/checkers/rules.js';
import type { RulesEntry } from '../staleness/types.js';

/** Sentinel shape. It carries the preset NAME because `isRulesStale` alone misses a preset flip:
 * user/extra layers auto-append unnamed subrules, so two presets can resolve to the IDENTICAL
 * source set. The name catches that; the fingerprint catches in-place edits. */
interface RunSyncSentinel {
  preset: string;
  entry: RulesEntry;
}

function sentinelPath(agent: AgentId, version: string): string {
  const key = `${agent}@${version}`.replace(/[^a-zA-Z0-9@._-]/g, '_');
  return path.join(getCacheDir(), 'rules-run-sync', `${key}.json`);
}

function loadSentinel(agent: AgentId, version: string): RunSyncSentinel | null {
  try {
    return JSON.parse(fs.readFileSync(sentinelPath(agent, version), 'utf-8')) as RunSyncSentinel;
  } catch {
    return null;
  }
}

function saveSentinel(agent: AgentId, version: string, sentinel: RunSyncSentinel): void {
  const p = sentinelPath(agent, version);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(sentinel));
  } catch {
  }
}

/** Re-apply the active rules preset into the version home when the composed sources drifted; true
 * when written. The fingerprint is no-cwd on purpose: the home file excludes the project layer,
 * which would cause pointless rewrites. Silent on failure: a bad preset must never block a launch. */
export function applyActiveRulesPresetAtRun(
  agent: AgentId,
  version: string,
  versionHome: string,
): boolean {
  // Version-home sync excludes cwd so project rules never contaminate every run of a version.
  const cap = AGENTS[agent].capabilities.rules;
  if (cap === false) return false;
  const rulesWriter = getWriter('rules', agent);
  if (!rulesWriter) return false;

  const preset = getActiveRulesPreset(agent, version);
  const current = buildRules(agent, version, '');

  // Preset identity is part of freshness even when two presets fingerprint the same files.
  const stored = loadSentinel(agent, version);
  if (stored && stored.preset === preset && !isRulesStale(stored.entry, agent, version, '')) {
    return false;
  }

  try {
    rulesWriter.write({ version, versionHome, selection: { preset }, cwd: '' });
  } catch {
    // Launch must remain available when optional rule synchronization cannot be written.
    return false;
  }

  saveSentinel(agent, version, { preset, entry: current });
  return true;
}
