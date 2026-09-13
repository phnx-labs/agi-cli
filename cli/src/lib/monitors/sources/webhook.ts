/**
 * Webhook source evaluator.
 *
 * Webhooks are push-based (an inbound signed HTTP delivery), so the poll-model
 * `evaluate` returns null.
 */

import type { MonitorSource } from '../config.js';
import type { Observation } from './types.js';

/** Push-only: nothing to snapshot on a poll tick. */
export function evaluate(_source: MonitorSource): Promise<Observation | null> {
  return Promise.resolve(null);
}
