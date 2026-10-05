import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { posixShellPath } from '../platform/exec.js';
import type { AgentManager, AgentProcess, EffortLevel } from './agents.js';
import type { AgentType } from './parsers.js';
import { expandForEach, type ForEachSpec, type ForEachTeammate } from '../workflows.js';

const execFileAsync = promisify(execFile);

export function parseProducedItems(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (trimmed === '') return [];

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((x) => (x == null ? '' : typeof x === 'string' ? x : String(x)))
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      }
    } catch {
    }
  }

  return trimmed
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface ProduceItemsOptions {
  cwd?: string | null;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  resolveItemsRef?: (ref: string) => string[] | undefined;
}

export async function produceItems(
  spec: ForEachSpec,
  opts: ProduceItemsOptions = {},
): Promise<string[]> {
  if (spec.itemsRef && opts.resolveItemsRef) {
    const resolved = opts.resolveItemsRef(spec.itemsRef);
    if (resolved) return resolved;
  }

  if (!spec.produce) {
    if (spec.itemsRef) {
      throw new Error(
        `for_each itemsRef '${spec.itemsRef}' could not be resolved and no produce command is set`,
      );
    }
    throw new Error('for_each has neither a produce command nor a resolvable itemsRef');
  }

  const { stdout } = await execFileAsync(posixShellPath(), ['-c', spec.produce], {
    cwd: opts.cwd ?? undefined,
    env: opts.env ?? process.env,
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf-8',
  });
  return parseProducedItems(stdout);
}

export function evaluateKeepIf(
  votes: boolean[],
  keepIf: 'majority' | 'all' | 'any',
): boolean {
  const total = votes.length;
  if (total === 0) return false;
  const yes = votes.reduce((n, v) => (v ? n + 1 : n), 0);
  switch (keepIf) {
    case 'all':
      return yes === total;
    case 'any':
      return yes >= 1;
    case 'majority':
      return yes * 2 > total;
  }
}

interface ForEachItemVerdict {
  item: string;
  itemIndex: number;
  stageName: string;
  kept: boolean;
  votes: boolean[];
  keepIf?: 'majority' | 'all' | 'any';
}

export function tallyForEach(
  teammates: ForEachTeammate[],
  readVote: (verify: ForEachTeammate) => boolean,
): ForEachItemVerdict[] {
  const stages = teammates.filter((t) => t.role === 'stage');
  const verifiersByStage = new Map<string, ForEachTeammate[]>();
  for (const t of teammates) {
    if (t.role !== 'verify') continue;
    const stageName = t.after[0];
    if (!stageName) continue;
    const list = verifiersByStage.get(stageName) ?? [];
    list.push(t);
    verifiersByStage.set(stageName, list);
  }

  return stages.map((stage) => {
    const panel = verifiersByStage.get(stage.name) ?? [];
    if (panel.length === 0) {
      return {
        item: stage.item,
        itemIndex: stage.itemIndex,
        stageName: stage.name,
        kept: true,
        votes: [],
      };
    }
    const keepIf = panel[0].keep_if ?? 'majority';
    const votes = panel.map((v) => readVote(v));
    return {
      item: stage.item,
      itemIndex: stage.itemIndex,
      stageName: stage.name,
      kept: evaluateKeepIf(votes, keepIf),
      votes,
      keepIf,
    };
  });
}

export interface RunForEachOptions {
  cwd?: string | null;
  producerName?: string;
  effort?: EffortLevel;
  concurrency?: number;
}

export interface RunForEachResult {
  teammates: ForEachTeammate[];
  spawned: AgentProcess[];
  producedCount: number;
  usedCount: number;
  truncated: number;
}

export async function runForEach(
  mgr: AgentManager,
  teamName: string,
  spec: ForEachSpec,
  items: string[],
  opts: RunForEachOptions = {},
): Promise<RunForEachResult> {
  const { teammates, producedCount, usedCount, truncated } = expandForEach(spec, items, {
    producerName: opts.producerName,
  });

  const effort: EffortLevel = opts.effort ?? 'medium';
  const spawned: AgentProcess[] = [];
  for (const t of teammates) {
    const agent = await mgr.spawn(
      teamName,
      t.agentType as AgentType,
      t.prompt,
      opts.cwd ?? null,
      null,
      effort,
      null,
      null,
      null,
      t.name,
      t.after,
    );
    spawned.push(agent);
  }

  return { teammates, spawned, producedCount, usedCount, truncated };
}
