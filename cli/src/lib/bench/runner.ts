import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getCliLaunch } from "../cli-entry.js";
import type {
  BenchCell,
  BenchCellResult,
  BenchRunResult,
  BenchTask,
} from "./types.js";
export interface CellExecutionRequest extends BenchCell {
  prompt: string;
  cwd: string;
}
type CellExecutor = (
  request: CellExecutionRequest,
) => Promise<Omit<BenchCellResult, keyof BenchCell | "wall_ms" | "status">>;
export function extractTokenCount(
  stdout: string,
  stderr: string,
): number | undefined {
  const matches = [
    ...`${stdout}\n${stderr}`.matchAll(
      /(?:tokens used|total tokens|token usage)\s*[:=]?\s*([\d,]+)/gi,
    ),
  ];
  const raw = matches.at(-1)?.[1];
  if (!raw) return undefined;
  const tokens = Number(raw.replaceAll(",", ""));
  return Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : undefined;
}
async function executeCellViaAgentsRun(
  request: CellExecutionRequest,
): ReturnType<CellExecutor> {
  const args = [
    "run",
    request.agent,
    request.prompt,
    "--cwd",
    request.cwd,
    "--headless",
    "--no-tmux",
  ];
  if (request.model) args.push("--model", request.model);
  const launch = getCliLaunch(args);
  return await new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: request.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        exit: code,
        stdout,
        stderr,
        tokens: extractTokenCount(stdout, stderr),
      }),
    );
  });
}
function copyFixture(
  task: BenchTask,
  cellIndex: number,
  runRoot: string,
): string {
  const cwd = path.join(runRoot, `cell-${cellIndex}`);
  fs.mkdirSync(cwd, { recursive: true });
  if (fs.existsSync(task.fixtureDir))
    fs.cpSync(task.fixtureDir, cwd, { recursive: true });
  return cwd;
}
export async function runCells(options: {
  task?: BenchTask;
  prompt: string;
  cells: BenchCell[];
  concurrency: number;
  execute?: CellExecutor;
  tempRoot?: string;
}): Promise<BenchRunResult> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1)
    throw new Error("concurrency must be a positive integer");
  if (options.cells.length === 0)
    throw new Error("at least one bench cell is required");
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${process.pid}`;
  const startedAt = new Date();
  const runRoot = fs.mkdtempSync(
    path.join(options.tempRoot ?? os.tmpdir(), `agents-bench-${runId}-`),
  );
  const results = new Array<BenchCellResult>(options.cells.length);
  const execute = options.execute ?? executeCellViaAgentsRun;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= options.cells.length) return;
      const cell = options.cells[index];
      const cwd = options.task
        ? copyFixture(options.task, index, runRoot)
        : path.join(runRoot, `cell-${index}`);
      fs.mkdirSync(cwd, { recursive: true });
      const started = performance.now();
      try {
        const output = await execute({ ...cell, prompt: options.prompt, cwd });
        results[index] = {
          ...cell,
          ...output,
          wall_ms: Math.round(performance.now() - started),
          status: output.exit === 0 ? "passed" : "failed",
        };
      } catch (error) {
        results[index] = {
          ...cell,
          exit: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          wall_ms: Math.round(performance.now() - started),
          status: "failed",
        };
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency, options.cells.length) },
      worker,
    ),
  );
  return {
    schema_version: 1,
    run_id: runId,
    ...(options.task ? { task_id: options.task.id } : {}),
    prompt: options.prompt,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    cells: results,
  };
}
