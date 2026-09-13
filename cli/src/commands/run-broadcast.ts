/**
 * `agents run --broadcast` — run the same task/prompt across an agent × model
 * matrix (formerly `agents bench`).
 *
 * Task definitions live under cli/bench/tasks/<id>/task.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { detectSignedInRuntimes } from '../lib/crabbox/runtimes.js';
import {
  listRuns,
  loadRun,
  loadTask,
  runCells,
  saveRun,
  type BenchCell,
  type BenchRunResult,
} from '../lib/bench/index.js';

const TASKS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../bench/tasks',
);

function csv(value: string | undefined): string[] {
  return (
    value
      ?.split(',')
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}

function taskIds(root = TASKS_ROOT): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(path.join(root, entry.name, 'task.json')),
    )
    .map((entry) => entry.name)
    .sort();
}

function renderResult(result: BenchRunResult): void {
  console.log(
    `Run ${result.run_id}${result.task_id ? ` · ${result.task_id}` : ''}`,
  );
  for (const cell of result.cells)
    console.log(
      `${cell.status === 'passed' ? 'PASS' : 'FAIL'}  ${cell.agent}${cell.model ? `/${cell.model}` : ''}  ${cell.wall_ms} ms  exit ${cell.exit ?? 'spawn-error'}`,
    );
}

interface BroadcastOpts {
  listTasks?: boolean;
  results?: string | true;
  task?: string;
  model?: string;
  concurrency?: string;
  json?: boolean;
  /** Comma-separated agents from the run [agent] positional when broadcasting. */
  agentsCsv?: string;
  prompt?: string;
  /** When true, run the matrix (not just list/results). */
  requireRun?: boolean;
}

/** Handle --broadcast / --list-tasks / --results on `agents run`. Always completes the path. */
export async function handleBroadcast(opts: BroadcastOpts): Promise<void> {
  if (opts.listTasks) {
    const tasks = taskIds();
    if (opts.json) console.log(JSON.stringify(tasks, null, 2));
    else if (tasks.length === 0) console.log('No broadcast tasks installed.');
    else tasks.forEach((id) => console.log(id));
    return;
  }

  if (opts.results !== undefined) {
    const runId = opts.results === true ? undefined : opts.results;
    const value = runId ? loadRun(runId) : listRuns();
    if (opts.json) console.log(JSON.stringify(value, null, 2));
    else if (Array.isArray(value)) {
      if (value.length === 0) console.log('No broadcast results yet.');
      else value.forEach(renderResult);
    } else renderResult(value);
    return;
  }

  if (!opts.requireRun) {
    throw new Error('Pass --broadcast with a prompt or --task <id>, or use --list-tasks / --results.');
  }

  if (!!opts.task === !!opts.prompt) {
    throw new Error('Pass exactly one of --task <id> or a prompt with --broadcast.');
  }

  const task = opts.task ? loadTask(opts.task, TASKS_ROOT) : undefined;
  const prompt = opts.prompt ?? task!.prompt;
  let agents = csv(opts.agentsCsv);
  if (agents.length === 0) {
    agents = (await detectSignedInRuntimes())
      .filter((runtime) => runtime.signedIn)
      .map((runtime) => runtime.id);
  }
  if (agents.length === 0) {
    throw new Error(
      'No signed-in native agents found. Pass comma-separated agents: agents run --broadcast claude,codex "…"',
    );
  }
  const models = csv(opts.model);
  const cells: BenchCell[] = agents.flatMap((agent) =>
    models.length > 0 ? models.map((model) => ({ agent, model })) : [{ agent }],
  );
  const concurrency = Number(opts.concurrency ?? '3');
  const result = await runCells({ task, prompt, cells, concurrency });
  saveRun(result);
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else renderResult(result);
  if (result.cells.some((cell) => cell.status === 'failed')) process.exitCode = 1;
}
