/**
 * Diff two {@link SessionTrajectory} models for `agents sessions trace <a> <b>` —
 * the second selector turns the single-session trajectory into a **compare**.
 *
 * Aligns the two sessions' TOOL steps (thinking steps carry no comparable
 * identity) with the `diff` package's `diffArrays` (already a dependency,
 * `lib/diff-text.ts`), comparator-keyed on tool name, in order — cheap,
 * deterministic, and matches how a human reads "where did these two runs
 * diverge": the first point their tool sequence stops lining up.
 *
 * Pure and framework-free, exactly like `trajectory.ts`: takes two already-built
 * `SessionTrajectory` models (never re-parses a transcript) and returns a plain
 * diff object the HTML/text/JSON renderers project.
 */
import { diffArrays } from 'diff';
import type { SessionMeta } from './types.js';
import type { SessionTrajectory, TrajectoryStep } from './trajectory.js';

/** Where two sessions' tool sequences first stop lining up. */
export interface TrajectoryDivergence {
  /** Ordinal of the last step both sessions still agree on (0 if none). */
  afterOrdinalA: number;
  afterOrdinalB: number;
  /** ms into each session's own timeline where the divergence begins. */
  startMsA: number;
  startMsB: number;
  /** One-line description of what differs — the next tool step on each side. */
  detail: string;
}

/** Aggregate numbers for one side of a compare — the summary table row. */
export interface TrajectorySummary {
  session: SessionMeta;
  toolCount: number;
  errorCount: number;
  spanMs: number;
  outputTokens: number;
}

/** The result of diffing two trajectories. */
export interface TrajectoryComparison {
  a: SessionTrajectory;
  b: SessionTrajectory;
  /** Undefined only when the tool sequences are identical (or one/both are empty and equal). */
  divergence?: TrajectoryDivergence;
  /** Tool steps present in `b` with no counterpart in `a`, in `b`'s order. */
  added: TrajectoryStep[];
  /** Tool steps present in `a` with no counterpart in `b`, in `a`'s order. */
  removed: TrajectoryStep[];
  summaryA: TrajectorySummary;
  summaryB: TrajectorySummary;
  /** Tool steps dropped from the diff computation by the `maxDiffSteps` cap, per side. */
  truncatedA: number;
  truncatedB: number;
}

interface DiffTrajectoriesOptions {
  /** Cap on tool steps considered per side (the LCS table is O(n*m)). Default 1000. */
  maxDiffSteps?: number;
}

const DEFAULT_MAX_DIFF_STEPS = 1000;

type EditOp =
  | { type: 'same'; stepA: TrajectoryStep; stepB: TrajectoryStep }
  | { type: 'remove'; stepA: TrajectoryStep }
  | { type: 'add'; stepB: TrajectoryStep };

/**
 * Turn `diffArrays`' run-length change objects into a per-step edit script.
 *
 * `diffArrays(a, b, { comparator })` (Myers' diff under the hood) returns
 * consecutive-run chunks, not individual elements, and — per its own docs —
 * an unchanged chunk's `value` is drawn from `b`, not `a`. Neither shape is
 * what a divergence marker needs (a stepA/stepB PAIR per matched step, with
 * both sides' own ordinals/timestamps), so this walks two cursors over the
 * original arrays in lockstep with the run lengths `diffArrays` reports,
 * recovering the exact `a[i]`/`b[j]` pairing for every `same` step.
 */
function computeEditScript(a: TrajectoryStep[], b: TrajectoryStep[]): EditOp[] {
  const changes = diffArrays(a, b, { comparator: (x, y) => x.tool === y.tool });
  const ops: EditOp[] = [];
  let i = 0;
  let j = 0;
  for (const change of changes) {
    const count = change.count ?? change.value.length;
    if (change.removed) {
      for (let k = 0; k < count; k++) ops.push({ type: 'remove', stepA: a[i++] });
    } else if (change.added) {
      for (let k = 0; k < count; k++) ops.push({ type: 'add', stepB: b[j++] });
    } else {
      for (let k = 0; k < count; k++) ops.push({ type: 'same', stepA: a[i++], stepB: b[j++] });
    }
  }
  return ops;
}

function describeDivergence(op: EditOp): string {
  if (op.type === 'remove') return `${op.stepA.tool ?? op.stepA.kind} — only in the first session`;
  if (op.type === 'add') return `${op.stepB.tool ?? op.stepB.kind} — only in the second session`;
  return '';
}

function summarize(t: SessionTrajectory): TrajectorySummary {
  return {
    session: t.session,
    toolCount: t.stats.toolCount,
    errorCount: t.errorCount,
    spanMs: t.spanMs,
    outputTokens: t.stats.outputTokens,
  };
}

/**
 * Diff two trajectories: align their tool-step sequences, find the first
 * divergence, and collect the steps each session ran that the other never
 * did. Never mutates either input.
 */
export function diffTrajectories(
  a: SessionTrajectory,
  b: SessionTrajectory,
  options: DiffTrajectoriesOptions = {},
): TrajectoryComparison {
  const maxDiffSteps = options.maxDiffSteps ?? DEFAULT_MAX_DIFF_STEPS;

  const allToolStepsA = a.steps.filter((s) => s.kind === 'tool');
  const allToolStepsB = b.steps.filter((s) => s.kind === 'tool');
  const toolStepsA = allToolStepsA.slice(0, maxDiffSteps);
  const toolStepsB = allToolStepsB.slice(0, maxDiffSteps);
  const truncatedA = allToolStepsA.length - toolStepsA.length;
  const truncatedB = allToolStepsB.length - toolStepsB.length;

  const ops = computeEditScript(toolStepsA, toolStepsB);

  const added: TrajectoryStep[] = [];
  const removed: TrajectoryStep[] = [];
  let divergence: TrajectoryDivergence | undefined;
  let lastSameA: TrajectoryStep | undefined;
  let lastSameB: TrajectoryStep | undefined;

  for (const op of ops) {
    if (op.type === 'same') {
      lastSameA = op.stepA;
      lastSameB = op.stepB;
      continue;
    }
    if (op.type === 'remove') removed.push(op.stepA);
    else added.push(op.stepB);
    if (!divergence) {
      divergence = {
        afterOrdinalA: lastSameA?.ordinal ?? 0,
        afterOrdinalB: lastSameB?.ordinal ?? 0,
        startMsA: op.type === 'remove' ? op.stepA.startMs : (lastSameA?.startMs ?? 0),
        startMsB: op.type === 'add' ? op.stepB.startMs : (lastSameB?.startMs ?? 0),
        detail: describeDivergence(op),
      };
    }
  }

  return {
    a,
    b,
    divergence,
    added,
    removed,
    summaryA: summarize(a),
    summaryB: summarize(b),
    truncatedA,
    truncatedB,
  };
}
