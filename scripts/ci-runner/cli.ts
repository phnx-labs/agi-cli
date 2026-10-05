#!/usr/bin/env bun
/** Shared untrusted-code executor CLI. Usage: `bun scripts/ci-runner/cli.ts submit <request.json>`
 * or `bench [jobCount]`. */
import { readFileSync } from 'node:fs';
import { runExecutorBenchmark, writeBenchReport } from './src/benchmark';
import { Broker } from './src/broker';
import { ciLayout } from './src/paths';

const [cmd, arg] = process.argv.slice(2);

if (cmd === 'submit') {
  if (!arg) {
    console.error('usage: bun scripts/ci-runner/cli.ts submit <request.json>');
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(arg, 'utf8')) as Record<string, unknown>;
  const record = new Broker({ layout: ciLayout(process.env.CI_ROOT) }).submit(raw);
  console.log(JSON.stringify(record, null, 2));
  process.exit(record.status === 'rejected' ? 1 : 0);
}

if (cmd === 'bench') {
  const n = arg ? Number(arg) : 32;
  const report = runExecutorBenchmark(n);
  const dest = process.env.CI_BENCH_OUT;
  if (dest) writeBenchReport(report, dest);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.withinCiP99_99 ? 0 : 1);
}

console.error('usage: bun scripts/ci-runner/cli.ts <submit|bench> [...]');
process.exit(2);
