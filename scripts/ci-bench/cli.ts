#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildReport, formatReport } from './report';
import type { BenchInput, BenchRun } from './types';

function printHelp(): void {
  process.stdout.write(`ci-bench — exact phase percentiles + provider comparison

Usage:
  bun scripts/ci-bench/cli.ts --input <runs.json> [--workflow <tests.yml>] [--json]

Sample-count gates: P99 needs 100, P99.9 needs 1000, P99.99 needs 10000.
Windows must not appear in the required aggregator's needs list.
`);
}

function loadInput(path: string): BenchInput {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as BenchInput | BenchRun[] | BenchRun;
  if (Array.isArray(raw)) return { runs: raw };
  if (raw && typeof raw === 'object' && Array.isArray((raw as BenchInput).runs)) {
    return raw as BenchInput;
  }
  if (raw && typeof raw === 'object' && 'jobs' in (raw as BenchRun)) {
    return { runs: [raw as BenchRun] };
  }
  throw new Error(`unrecognized bench input: ${path}`);
}

function parseArgs(argv: string[]): { input: string; workflow?: string; json: boolean; help: boolean } {
  let input = '';
  let workflow: string | undefined;
  let json = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--json') json = true;
    else if (arg === '--input' || arg === '-i') input = argv[++i] ?? '';
    else if (arg === '--workflow' || arg === '-w') workflow = argv[++i];
    else if (arg.startsWith('--input=')) input = arg.slice('--input='.length);
    else if (arg.startsWith('--workflow=')) workflow = arg.slice('--workflow='.length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { input, workflow, json, help };
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  if (args.help || !args.input) {
    printHelp();
    return args.help ? 0 : 2;
  }
  const input = loadInput(resolve(args.input));
  const workflow = args.workflow ? readFileSync(resolve(args.workflow), 'utf8') : undefined;
  const report = buildReport(input, workflow);
  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else process.stdout.write(formatReport(report));
  return report.pass ? 0 : 2;
}

if (import.meta.main) {
  process.exit(main());
}
