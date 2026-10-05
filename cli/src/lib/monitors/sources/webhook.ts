
import type { MonitorSource } from '../config.js';
import type { Observation } from './types.js';

export function evaluate(_source: MonitorSource): Promise<Observation | null> {
  return Promise.resolve(null);
}
