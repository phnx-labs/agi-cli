/** Shared source-evaluator contract: every source exports `evaluate(source)` (one snapshot, or null
 * when nothing is observable or it is push-only) and, if push-based (ws, file-follow),
 * `subscribe(source, onObs)` returning an unsubscribe fn. */

import type { MonitorSource } from '../config.js';

/** One observation of a source: the raw text plus optional structured metadata. */
export interface Observation {
  raw: string;
  meta?: Record<string, unknown>;
  /** The source flagged this snapshot as an OBSERVATION FAILURE (non-zero exit or
   * transport/auth/rate-limit error), not a value. The engine skips it: no fire, state untouched,
   * counted as a failed check (PHNX-3510). */
  failed?: boolean;
  /** Short human reason for `failed`, surfaced in drought health and `test`. */
  failureReason?: string;
}

/** Poll-model evaluator: return one observation, or null when none is available. */
export type SourceEvaluator = (source: MonitorSource) => Promise<Observation | null>;

/** Push-model subscriber: call onObs on each frame; return an unsubscribe fn. */
export type SourceSubscriber = (
  source: MonitorSource,
  onObs: (obs: Observation) => void,
) => () => void;
