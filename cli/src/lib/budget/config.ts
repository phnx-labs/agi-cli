import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { AgentId, BudgetConfig } from '../types.js';
import { getUserAgentsDir, readMeta } from '../state.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

function getProjectBudgets(startPath: string): BudgetConfig[] {
  // Merge ancestor manifests from root to cwd so the nearest project wins field by field.
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
        // Malformed project budgets do not erase valid user or ancestor limits.
      }
    }
    dir = path.dirname(dir);
  }
  return configs.reverse();
}

export function resolveBudgetConfig(cwd: string = process.cwd()): BudgetConfig {
  const userBudget = coerceBudget(readMeta().budget);
  let merged = userBudget;
  for (const projectBudget of getProjectBudgets(cwd)) {
    merged = mergeBudget(merged, projectBudget);
  }
  // An omitted policy fails closed: configured caps block unless explicitly set to warn.
  if (merged.on_exceed === undefined) merged.on_exceed = 'block';
  return merged;
}

export function hasAnyCap(cfg: BudgetConfig): boolean {
  return (
    cfg.per_run !== undefined ||
    cfg.per_day !== undefined ||
    cfg.per_project !== undefined ||
    (cfg.per_agent !== undefined && Object.keys(cfg.per_agent).length > 0)
  );
}
