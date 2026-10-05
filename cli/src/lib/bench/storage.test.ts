import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { listRuns, loadRun, saveRun } from "./storage.js";
import type { BenchRunResult } from "./types.js";
function result(run_id: string, started_at: string): BenchRunResult {
  return {
    schema_version: 1,
    run_id,
    prompt: "test",
    started_at,
    finished_at: started_at,
    cells: [],
  };
}
describe("bench result storage", () => {
  it("atomically saves, loads, and sorts durable JSON results", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bench-storage-"));
    saveRun(result("older", "2026-08-05T01:00:00.000Z"), root);
    const target = saveRun(result("newer", "2026-08-05T02:00:00.000Z"), root);
    if (process.platform !== "win32") {
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    }
    expect(loadRun("newer", root).run_id).toBe("newer");
    expect(listRuns(root).map((run) => run.run_id)).toEqual(["newer", "older"]);
  });
  it("does not allow a run id to escape the result directory", () => {
    expect(() => loadRun("../outside", "/tmp/nope")).toThrow("Invalid run id");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bench-storage-"));
    expect(() =>
      saveRun(result("../outside", "2026-08-05T01:00:00.000Z"), root),
    ).toThrow("Invalid run id");
  });
});
