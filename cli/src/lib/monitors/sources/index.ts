/** Source-evaluator registry: source.type to evaluator. The engine calls the poll-model `evaluate`;
 * push sources (ws, webhook) return null and deliver through `subscribe`. */

import type { MonitorSourceType, MonitorSource } from '../config.js';
import type { Observation, SourceEvaluator } from './types.js';
import * as command from './command.js';
import * as poll from './poll.js';
import * as http from './http.js';
import * as file from './file.js';
import * as device from './device.js';
import * as ws from './ws.js';
import * as webhook from './webhook.js';

export type { Observation, SourceEvaluator, SourceSubscriber } from './types.js';

/** Poll-model evaluator per source type. */
export const SOURCE_EVALUATORS: Record<MonitorSourceType, SourceEvaluator> = {
  command: command.evaluate,
  poll: poll.evaluate,
  'poll-http': http.evaluate,
  file: file.evaluate,
  device: device.evaluate,
  ws: ws.evaluate,
  webhook: webhook.evaluate,
};

/** Evaluate one source snapshot. Returns null when the source is push-only or has nothing new. */
export function evaluateSource(source: MonitorSource): Promise<Observation | null> {
  const evaluator = SOURCE_EVALUATORS[source.type];
  if (!evaluator) return Promise.resolve(null);
  return evaluator(source);
}
