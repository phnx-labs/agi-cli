import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { AgentId } from '../../src/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SCENARIO_RAW_DIR = path.join(HERE, '..', 'reports', '.scenarios');

export interface ScenarioRecord {
  iteration: number;
  truth: string | null;
  detected: string | null;
  matched: boolean;
  latencyMs: number;
  method: string | null;
  cwd: string;
  pid: number | undefined;
}

export interface ScenarioRaw {
  name: string;
  agent: AgentId;
  skipped?: boolean;
  skipReason?: string;
  records: ScenarioRecord[];
}

export class ScenarioRecorder {
  private records: ScenarioRecord[] = [];

  constructor(
    public readonly name: string,
    public readonly agent: AgentId,
  ) {}

  add(r: ScenarioRecord): void {
    this.records.push(r);
  }

  get all(): readonly ScenarioRecord[] {
    return this.records;
  }

  async flush(meta?: { skipped?: boolean; skipReason?: string }): Promise<void> {
    await fs.mkdir(SCENARIO_RAW_DIR, { recursive: true });
    const payload: ScenarioRaw = {
      name: this.name,
      agent: this.agent,
      ...(meta?.skipped ? { skipped: true, skipReason: meta.skipReason } : {}),
      records: this.records,
    };
    await fs.writeFile(
      path.join(SCENARIO_RAW_DIR, `${this.name}.json`),
      JSON.stringify(payload, null, 2),
      'utf8',
    );
  }
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
