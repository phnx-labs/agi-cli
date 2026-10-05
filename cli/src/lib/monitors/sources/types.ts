
import type { MonitorSource } from '../config.js';

export interface Observation {
  raw: string;
  meta?: Record<string, unknown>;
  failed?: boolean;
  failureReason?: string;
}

export type SourceEvaluator = (source: MonitorSource) => Promise<Observation | null>;

export type SourceSubscriber = (
  source: MonitorSource,
  onObs: (obs: Observation) => void,
) => () => void;
