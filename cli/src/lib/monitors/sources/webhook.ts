/**
 * Webhook source evaluator.
 *
 * Webhooks are push-based (an inbound signed HTTP delivery), so the poll-model
 * `evaluate` returns null. When a delivery arrives, the receiver matches it
 * against monitors with `matchWebhook`, which reuses the github/linear matchers
 * from lib/triggers/webhook.ts by projecting the monitor's webhook filters onto a
 * synthesized JobConfig-shaped trigger.
 */

import { jobMatchesWebhook, type IncomingWebhook } from '../../triggers/webhook.js';
import type { JobConfig, JobTrigger } from '../../scheduling/routines.js';
import type { MonitorSource, MonitorConfig } from '../config.js';
import type { Observation } from './types.js';

/** Push-only: nothing to snapshot on a poll tick. */
export function evaluate(_source: MonitorSource): Promise<Observation | null> {
  return Promise.resolve(null);
}
