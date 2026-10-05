/** Budget config resolution (issue #346). The `budget:` block may be in the user agents.yaml and
 * any project-local one up from cwd; project beats user, merged field by field. The single
 * resolver for the pre-flight check, the live watcher and `agents config budget`. */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { AgentId, BudgetConfig } from '../types.js';
import { getUserAgentsDir, readMeta } from '../state.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce a raw `budget:` block into a typed BudgetConfig, dropping wrong-shaped fields. Malformed
 * entries are ignored, not thrown: a typo in one cap must not crash a run (lenient for user-typed
 * config only). */
function coerceBudget(raw: unknown): BudgetConfig {
  if (!isRecord(raw)) return {};
  const out: BudgetConfig = {};
  if (typeof raw.currency === 'string') out.currency = raw.currency;
  if (typeof raw.per_run === 'number' && raw.per_run >= 0) out.per_run = raw.per_run;
  if (typeof raw.per_day === 'number' && raw.per_day >= 0) out.per_day = raw.per_day;
  if (typeof raw.per_project === 'number' && raw.per_project >= 0) out.per_project = raw.per_project;
  if (raw.on_exceed === 'block' || raw.on_exceed === 'warn') out.on_exceed = raw.on_exceed;
  if (typeof raw.require_confirm_over === 'number' && raw.require_confirm_over >= 0) {
    out.require_confirm_over = raw.require_confirm_over;
  }
  if (isRecord(raw.per_agent)) {
    const perAgent: Partial<Record<AgentId, number>> = {};
    for (const [k, v] of Object.entries(raw.per_agent)) {
      if (typeof v === 'number' && v >= 0) perAgent[k as AgentId] = v;
    }
    if (Object.keys(perAgent).length > 0) out.per_agent = perAgent;
  }
  return out;
}

/** Merge a higher-precedence budget over a base. Set fields win; per_agent merges key-by-key. */
function mergeBudget(base: BudgetConfig, over: BudgetConfig): BudgetConfig {
  const merged: BudgetConfig = { ...base, ...stripUndefined(over) };
  if (base.per_agent || over.per_agent) {
    merged.per_agent = { ...(base.per_agent ?? {}), ...(over.per_agent ?? {}) };
  }
  return merged;
}

function stripUndefined(cfg: BudgetConfig): BudgetConfig {
  const out: BudgetConfig = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Read project-local `budget:` blocks from nearest dir upward, nearest LAST (highest precedence). */
function getProjectBudgets(startPath: string): BudgetConfig[] {
  const configs: BudgetConfig[] = [];
  let dir = path.resolve(startPath);
  const userAgentsYaml = path.join(getUserAgentsDir(), 'agents.yaml');

  while (dir !== path.dirname(dir)) {
    const manifestPath = path.join(dir, 'agents.yaml');
    if (manifestPath !== userAgentsYaml && fs.existsSync(manifestPath)) {
      try {
        const parsed = yaml.parse(fs.readFileSync(manifestPath, 'utf-8'));
        if (isRecord(parsed) && parsed.budget !== undefined) {
          configs.push(coerceBudget(parsed.budget));
        }
      } catch {
        // Malformed project config — ignore and keep walking.
      }
    }
    dir = path.dirname(dir);
  }
  // configs[0] is the nearest dir. Reverse so the nearest applies LAST (wins).
  return configs.reverse();
}

/** Effective budget for `cwd`: user base, then each project block from farthest ancestor to
 * nearest, nearest winning. `on_exceed` defaults to `block` (fail-closed). */
export function resolveBudgetConfig(cwd: string = process.cwd()): BudgetConfig {
  const userBudget = coerceBudget(readMeta().budget);
  let merged = userBudget;
  for (const projectBudget of getProjectBudgets(cwd)) {
    merged = mergeBudget(merged, projectBudget);
  }
  if (merged.on_exceed === undefined) merged.on_exceed = 'block';
  return merged;
}

/** True when at least one enforceable cap is set. No caps => budget feature is dormant. */
export function hasAnyCap(cfg: BudgetConfig): boolean {
  return (
    cfg.per_run !== undefined ||
    cfg.per_day !== undefined ||
    cfg.per_project !== undefined ||
    (cfg.per_agent !== undefined && Object.keys(cfg.per_agent).length > 0)
  );
}
