import * as fs from "fs";
import * as path from "path";
import { getUserAgentsDir } from "../state.js";
import { parseRunResult, validateRunId } from "./schema.js";
import type { BenchRunResult } from "./types.js";
function benchHistoryDir(): string {
  return path.join(getUserAgentsDir(), ".history", "bench");
}
export function saveRun(
  result: BenchRunResult,
  root = benchHistoryDir(),
): string {
  parseRunResult(result);
  validateRunId(result.run_id);
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, `${result.run_id}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, target);
  return target;
}
export function loadRun(
  runId: string,
  root = benchHistoryDir(),
): BenchRunResult {
  validateRunId(runId);
  return parseRunResult(
    JSON.parse(fs.readFileSync(path.join(root, `${runId}.json`), "utf8")),
  );
}
export function listRuns(root = benchHistoryDir()): BenchRunResult[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => name.endsWith(".json"))
    .map((name) =>
      parseRunResult(
        JSON.parse(fs.readFileSync(path.join(root, name), "utf8")),
      ),
    )
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
}
