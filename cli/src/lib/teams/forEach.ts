/**
 * Runtime wiring for declarative dynamic fan-out (issue #343).
 *
 * The declarative shape (`for_each:` in WORKFLOW.md / routine `run:` blocks) is
 * parsed and expanded by `src/lib/workflows.ts` (`parseForEachBlock`,
 * `expandForEach`). This module is the thin bridge that stages the expanded
 * teammate descriptors into the EXISTING teams substrate — one
 * `AgentManager.spawn` per descriptor, which the DAG supervisor then picks up
 * mid-flight via `rescanFromDisk` / `startReady`
 * (`src/lib/teams/supervisor.ts:98-103`).
 *
 * It deliberately adds NO new orchestration engine: `spawn` with an `--after`
 * chain is the whole mechanism, so cycle detection, wave scheduling, and
 * cross-vendor/rotation dispatch all carry over unchanged.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { posixShellPath } from '../platform/exec.js';
import type { AgentManager, AgentProcess, EffortLevel } from './agents.js';
import type { AgentType } from './parsers.js';
import { expandForEach, type ForEachSpec, type ForEachTeammate } from '../workflows.js';

const execFileAsync = promisify(execFile);

/**
 * Parse a producer's stdout into the item list `expandForEach` fans out over.
 *
 * Two shapes are accepted (issue #343), tried in order:
 *   1. A JSON array — `["a","b","c"]` (each element coerced to a trimmed string).
 *   2. Newline-delimited — one item per line.
 *
 * Empty lines / entries are dropped so a trailing newline or a `[]` never
 * fabricates a phantom teammate. Pure and deterministic — no I/O.
 */
export function parseProducedItems(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (trimmed === '') return [];

  // JSON array form first — only when it actually looks like one, so a plain
  // line that happens to start with '[' doesn't get swallowed by a parse error.
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
      // Not valid JSON — fall through to newline parsing.
    }
  }

  // Newline-delimited form.
  return trimmed
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface ProduceItemsOptions {
  /** Working directory for the producer command. */
  cwd?: string | null;
  /** Environment for the producer command (defaults to the current process env). */
  env?: NodeJS.ProcessEnv;
  /** Kill the producer after this many ms (default 120_000). */
  timeoutMs?: number;
  /**
   * Resolve an `itemsRef` (`${step}`-style reference) to a prior step's produced
   * list. When a spec carries `itemsRef` and this resolver returns a list, the
   * producer command is skipped entirely.
   */
  resolveItemsRef?: (ref: string) => string[] | undefined;
}

/**
 * Resolve a `for_each` spec's item list at runtime (issue #343): either by
 * running its `produce:` shell command and parsing stdout, or by resolving an
 * `itemsRef` to a prior step's list. The resulting items feed `expandForEach` /
 * `runForEach`.
 *
 * `itemsRef` wins when a resolver is supplied and returns a list; otherwise the
 * `produce` command runs. A spec with neither a resolvable ref nor a produce
 * command is a hard error — there is nothing to fan out over.
 */
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

  // The producer is a shell command string (e.g. "rg -l 'x' src/"), so it runs
  // under `sh -c` exactly like a teammate command — resolved portably, because
  // /bin/sh does not exist on Windows (there it's Git's sh.exe from PATH).
  // maxBuffer is raised well above the default 1MB so a producer emitting a
  // large list isn't truncated silently mid-stream.
  const { stdout } = await execFileAsync(posixShellPath(), ['-c', spec.produce], {
    cwd: opts.cwd ?? undefined,
    env: opts.env ?? process.env,
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf-8',
  });
  return parseProducedItems(stdout);
}

/**
 * Evaluate a verify panel's `keep_if` gate against its boolean votes (issue
 * #343). A `true` vote is a skeptic confirming the finding should be kept.
 *
 *   - `all`      — every skeptic must vote keep.
 *   - `any`      — at least one skeptic votes keep.
 *   - `majority` — strictly more than half vote keep (a tie does NOT pass).
 *
 * An empty panel returns false: with no votes there is nothing affirming the
 * item, so the conservative gate drops it.
 */
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

/** Per-item verdict after tallying its verify panel. */
interface ForEachItemVerdict {
  /** The produced item this verdict is for. */
  item: string;
  /** Zero-based index in the (capped) produced list. */
  itemIndex: number;
  /** The stage teammate that handled this item. */
  stageName: string;
  /** Whether the item survives its `keep_if` gate (true when it has no panel). */
  kept: boolean;
  /** The votes that were tallied (empty when the item has no verify panel). */
  votes: boolean[];
  /** The gate applied (undefined when the item has no verify panel). */
  keepIf?: 'majority' | 'all' | 'any';
}

/**
 * Tally the verify panels of an expanded `for_each` and gate each item (issue
 * #343). Groups verify teammates by the stage teammate they depend on, reads a
 * boolean vote per verify teammate via `readVote`, and applies `keep_if`.
 *
 * An item with no verify panel is kept unconditionally (there is no gate).
 * Pure and deterministic: `readVote` is the only place runtime state enters, so
 * this is unit-testable with a synthetic vote reader.
 */
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
  /** Working directory for the spawned teammates. */
  cwd?: string | null;
  /**
   * Name of the producer teammate the stage teammates should depend on. When
   * set, each stage runs `--after` the producer so it can't start before the
   * list is available.
   */
  producerName?: string;
  /** Default effort for spawned teammates (per-item overrides live in the spec). */
  effort?: EffortLevel;
  /** Concurrency cap for the wave; falls back to the spec's `concurrency`. */
  concurrency?: number;
}

export interface RunForEachResult {
  /** The expanded descriptors (stage + verify), in spawn order. */
  teammates: ForEachTeammate[];
  /** The AgentProcess handles returned by `spawn`, aligned to `teammates`. */
  spawned: AgentProcess[];
  /** Items the producer emitted (pre-cap). */
  producedCount: number;
  /** Items actually fanned out (post-cap). */
  usedCount: number;
  /** How many items the runaway guard dropped. */
  truncated: number;
}

/**
 * Expand a `for_each` spec against a producer's output and stage every
 * resulting teammate into the given team via the dynamic-add path.
 *
 * Returns the descriptors and the spawned handles so a caller can drive the
 * supervisor and later gather results (e.g. to evaluate a `verify` panel's
 * `keep_if` gate — that vote-counting lives downstream, not here).
 */
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
      null, // mode: inherit team default
      effort,
      null, // parentSessionId
      null, // workspaceDir
      null, // version
      t.name,
      t.after,
    );
    spawned.push(agent);
  }

  return { teammates, spawned, producedCount, usedCount, truncated };
}
