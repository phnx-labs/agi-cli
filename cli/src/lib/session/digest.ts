/**
 * Catch-up digest extractors.
 *
 * Pure functions that turn a session's events into the signals a developer needs
 * to reload a task fast when switching between many agents: which files changed
 * and how (created / modified / deleted), which tools dominated the work, and the
 * last test/build result. Consumed by the single-session view and the picker
 * preview. No I/O — fully unit-testable.
 */

import type { SessionEvent } from './types.js';
import { bucketKey, classifyBashCommand } from './bash-command.js';

export type FileOp = 'created' | 'modified' | 'deleted';
export interface FileChange {
  path: string;
  op: FileOp;
}

// Tool vocab mirrors parse.ts / render.ts so classification matches what those
// modules already recognize across Claude/Codex/others.
const READ_TOOLS = new Set(['Read', 'read_file', 'view_file', 'cat_file', 'get_file']);
export const WRITE_TOOLS = new Set(['Write', 'write_file', 'create_file', 'Create']);
export const EDIT_TOOLS = new Set(['Edit', 'edit_file', 'replace', 'patch', 'MultiEdit', 'apply_patch']);

/**
 * Path-shaped noise that must never surface as a session "change": shell
 * redirect tokens (`2>&1`), unexpanded env-var prefixes (`$WT/...`), dependency
 * dirs (`node_modules`), and agents-cli's internal `.system` marker. Filtered at
 * the source so every consumer (summary, picker, digest counts) agrees.
 */
export function isNoisePath(p: string): boolean {
  if (!p) return true;
  if (/^\d+>[&/]?/.test(p)) return true;                       // 2>&1, 1>&2, 2>/dev/null
  if (p.includes('>&')) return true;
  if (p.startsWith('$') || p.startsWith('"$') || p.startsWith("'$")) return true; // unexpanded $VAR
  if (/(^|\/)node_modules(\/|$)/.test(p)) return true;
  if (/(^|\/)\.system$/.test(p)) return true;
  if (p.includes('/.agents/.history/')) return true;           // agents-cli internal archives
  return false;
}

/** Extract file paths deleted by a shell command (rm / git rm / unlink). Conservative. */
export function extractDeletedPaths(command: string): string[] {
  const out: string[] = [];
  // Split on && ; | to inspect each simple command separately.
  for (const seg of command.split(/&&|\|\||;|\|/)) {
    const m = seg.trim().match(/^(?:sudo\s+)?(?:git\s+rm|rm|unlink)\s+(.+)$/);
    if (!m) continue;
    for (const tok of m[1].split(/\s+/)) {
      if (tok.startsWith('-')) continue;          // flags (-r, -f, --force)
      if (/[*?{}]/.test(tok)) continue;           // globs — too imprecise to attribute
      const p = tok.replace(/^['"]|['"]$/g, '');   // unquote
      if (isNoisePath(p)) continue;
      out.push(p);
    }
  }
  return out;
}

/**
 * Classify every touched file as created / modified / deleted from the event
 * stream. Heuristics: a Write to a path never previously Read and not seen
 * before is a *creation*; an Edit (or a Write to a known/read path) is a
 * *modification*; a path in an `rm`/`git rm` command is a *deletion* (and wins
 * over create/modify — a created-then-deleted file nets to gone). Plan files
 * (`.claude/plans/*.md`) are excluded; they're surfaced by detectPlan.
 */
export function classifyFileChanges(events: SessionEvent[]): FileChange[] {
  const readBefore = new Set<string>();
  const created = new Set<string>();
  const modified = new Set<string>();
  const deleted = new Set<string>();
  const seen = new Set<string>();

  for (const e of events) {
    if (e.type !== 'tool_use' || e._local) continue;
    if (e.command) for (const d of extractDeletedPaths(e.command)) deleted.add(d);

    const tool = e.tool || '';
    const args = e.args || {};
    const p = e.path || args.file_path || args.path || '';
    if (!p) continue;
    if (p.includes('.claude/plans/') && p.endsWith('.md')) continue;
    if (isNoisePath(p)) continue;

    if (READ_TOOLS.has(tool)) {
      readBefore.add(p);
    } else if (WRITE_TOOLS.has(tool)) {
      if (!seen.has(p) && !readBefore.has(p)) created.add(p);
      else modified.add(p);
      seen.add(p);
      deleted.delete(p); // a write after a delete recreates the file
    } else if (EDIT_TOOLS.has(tool)) {
      if (args.patch_op === 'Add') created.add(p);
      else if (args.patch_op === 'Delete') deleted.add(p);
      else modified.add(p);
      seen.add(p);
      if (args.patch_op !== 'Delete') deleted.delete(p);
    }
  }

  const out: FileChange[] = [];
  for (const p of created) if (!deleted.has(p)) out.push({ path: p, op: 'created' });
  for (const p of modified) if (!created.has(p) && !deleted.has(p)) out.push({ path: p, op: 'modified' });
  for (const p of deleted) out.push({ path: p, op: 'deleted' });
  return out;
}

/** Net change summary: counts per op. */
export function changeCounts(changes: FileChange[]): { created: number; modified: number; deleted: number } {
  const c = { created: 0, modified: 0, deleted: 0 };
  for (const ch of changes) c[ch.op]++;
  return c;
}

/** Tool histogram sorted highest-first, capped to `top` entries. */
export function toolHistogram(toolCounts: Record<string, number>, top = 8): Array<{ tool: string; count: number }> {
  return Object.entries(toolCounts)
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
    .slice(0, top);
}

/**
 * Aggregate recognized external tools invoked via Bash across a session.
 * Unknown one-off commands are bucketed as `other` so the ranking surface
 * only surfaces repeatable tools.
 */
export function bashToolCounts(events: SessionEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) {
    if (e.type !== 'tool_use' || e._local) continue;
    if (e.tool !== 'Bash' || !e.command) continue;
    const info = classifyBashCommand(e.command);
    const key = info.category === 'other' ? 'other' : bucketKey(e.command);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

interface TestResult {
  runner: string;
  passed?: number;
  failed?: number;
  /** True when we could parse a pass/fail verdict. */
  ok: boolean;
  ts: number;
}

/**
 * Recognized test/build runners → the label we show.
 *
 * These match a *real invocation* of a runner, not any command that merely
 * contains a runner token. In particular we must NOT fire on npm-script
 * sub-targets like `bun test:setup`, `npm run test:watch`, or `pnpm test:ci` —
 * those are setup/watch/CI-orchestration scripts, not a test run whose output we
 * can scrape for a pass/fail verdict. A `test` token followed by `:something` is
 * a distinct script name and is excluded via the `(?![:\w-])` guard.
 */
const TEST_RUNNERS: Array<{ re: RegExp; label: string }> = [
  // Package-manager `test` script: `bun test`, `npm test`, `npm run test`,
  // `yarn test`, `pnpm test`. The negative lookahead `(?![:\w-])` rejects
  // `test:watch` / `test-ci` / `testfoo` — only the bare `test` target counts.
  { re: /\b(?:bun|npm|yarn|pnpm)\s+(?:run\s+)?test(?![:\w-])/, label: 'tests' },
  // Direct binaries — `vitest`, `jest`, `mocha` (optionally via a runner). These
  // are real invocations; a trailing subcommand like `vitest run` is fine.
  { re: /\b(?:vitest|jest|mocha)(?![:\w-])/, label: 'tests' },
  { re: /\bpytest(?![:\w-])/, label: 'pytest' },
  { re: /\bgo\s+test(?![:\w-])/, label: 'go test' },
  { re: /\bcargo\s+test(?![:\w-])/, label: 'cargo test' },
  { re: /\btsc(?:\s+--noEmit)?(?![:\w-])/, label: 'tsc' },
];

/**
 * Anchored summary-line extractors, per runner family. Each returns a pass/fail
 * verdict ONLY when it matches that runner's authoritative summary construct —
 * never an arbitrary `\d+ pass`-shaped substring elsewhere in stdout. This is
 * what stops `442 passwords generated`, `442 files`, or `442 passes/sec` from
 * being reported as `442 pass`.
 */
function parseSummaryLine(output: string): { passed?: number; failed?: number } | undefined {
  const lines = output.split(/\r?\n/);

  // vitest: ` Tests  1 failed | 2 passed (3)` (mixed) or ` Tests  2 passed (2)`
  // (all green). Leading indent + the `Tests` / `Test Files` label + double
  // space is the summary row. Prefer the ` Tests ` row (test count) over the
  // ` Test Files ` row (file count).
  for (const label of ['Tests', 'Test Files']) {
    for (const line of lines) {
      const row = new RegExp(`^\\s*${label}\\s{2,}(.+)$`).exec(line);
      if (!row) continue;
      const seg = row[1];
      const passed = /(\d+)\s+passed/.exec(seg);
      const failed = /(\d+)\s+failed/.exec(seg);
      // Only accept a vitest row that actually reports a pass/fail count.
      if (passed || failed) {
        return {
          passed: passed ? +passed[1] : undefined,
          failed: failed ? +failed[1] : 0,
        };
      }
    }
  }

  // jest: `Tests:       1 failed, 2 passed, 3 total`. The `Tests:` label anchors
  // it; order of failed/passed varies.
  for (const line of lines) {
    const row = /^\s*Tests:\s+(.+)$/.exec(line);
    if (!row) continue;
    const seg = row[1];
    const passed = /(\d+)\s+passed/.exec(seg);
    const failed = /(\d+)\s+failed/.exec(seg);
    if (passed || failed) {
      return { passed: passed ? +passed[1] : undefined, failed: failed ? +failed[1] : 0 };
    }
  }

  // pytest: the summary rule line `==== 3 passed, 1 failed in 0.12s ====`. The
  // surrounding `=` rule and the ` in <dur>s` tail anchor it to the real footer,
  // not a stray `N passed` in captured stdout.
  for (const line of lines) {
    if (!/={3,}.*\bin\s+[\d.]+s\b.*={3,}/.test(line) && !/^={3,}.*={3,}$/.test(line)) continue;
    if (!/\bin\s+[\d.]+m?s\b/.test(line)) continue;
    const passed = /(\d+)\s+passed/.exec(line);
    const failed = /(\d+)\s+failed/.exec(line);
    const errors = /(\d+)\s+error/.exec(line);
    if (passed || failed || errors) {
      const failCount = (failed ? +failed[1] : 0) + (errors ? +errors[1] : 0);
      return { passed: passed ? +passed[1] : undefined, failed: failed || errors ? failCount : 0 };
    }
  }

  // bun test: a summary block of ` N pass` / ` N fail` lines (each its own line,
  // leading-indented), closed by `Ran N tests across M files.`. Require the
  // `Ran … tests` sentinel to be present so we only read bun's real summary
  // block — bun also prints inline `(pass)`/`(fail)` per-test lines we ignore.
  if (/^Ran\s+\d+\s+tests?\b/m.test(output)) {
    let passed: number | undefined;
    let failed: number | undefined;
    for (const line of lines) {
      const p = /^\s*(\d+)\s+pass$/.exec(line);
      const f = /^\s*(\d+)\s+fail$/.exec(line);
      if (p) passed = +p[1];
      if (f) failed = +f[1];
    }
    if (passed !== undefined || failed !== undefined) {
      return { passed, failed: failed ?? 0 };
    }
  }

  // mocha: ` 2 passing` / ` 1 failing` (leading-indented, own line). The
  // `passing`/`failing` gerund is mocha-specific and won't match `442 passwords`.
  {
    let passed: number | undefined;
    let failed: number | undefined;
    for (const line of lines) {
      const p = /^\s*(\d+)\s+passing\b/.exec(line);
      const f = /^\s*(\d+)\s+failing\b/.exec(line);
      if (p) passed = +p[1];
      if (f) failed = +f[1];
    }
    if (passed !== undefined || failed !== undefined) {
      return { passed, failed: failed ?? 0 };
    }
  }

  return undefined;
}

/** Parse pass/fail counts from common runner output. */
function parseTestOutput(runner: string, output: string): { passed?: number; failed?: number; ok: boolean } {
  // Anchor to a recognized runner summary construct (vitest ` Tests `, jest
  // `Tests:`, pytest `=== N passed in Xs ===`, bun's `N pass`/`N fail` block,
  // mocha `N passing`) — never a blanket `\d+ pass`-shaped scrape over stdout.
  // That blanket scrape used to report `442 passwords`, `442 files passed
  // validation`, or a `442 passes/sec` benchmark as `442 pass`.
  const summary = parseSummaryLine(output);
  if (summary) {
    return { ...summary, ok: true };
  }
  // tsc: no news is good news; "error TSxxxx" means failure.
  if (runner === 'tsc') {
    const errs = output.match(/error\s+TS\d+/gi);
    return { failed: errs ? errs.length : 0, ok: true };
  }
  // go test: no pass/fail counts — uses `--- PASS/FAIL:` lines and an ok/FAIL
  // summary. Count the per-test markers; fall back to the summary verdict.
  if (runner === 'go test') {
    const passCount = (output.match(/---\s+PASS/gi) || []).length;
    const failCount = (output.match(/---\s+FAIL/gi) || []).length;
    const sawFail = failCount > 0 || /(^|\s)FAIL($|\s)/.test(output);
    const sawOk = /(^|\s)(ok|PASS)($|\s)/.test(output);
    if (sawFail || sawOk) {
      return { passed: passCount || undefined, failed: sawFail ? failCount || 1 : 0, ok: true };
    }
  }
  return { ok: false };
}

/**
 * The most recent test/build run and its verdict. Correlates a runner command
 * (tool_use) with the next tool_result's output. Returns undefined if none ran.
 */
export function detectTestResult(events: SessionEvent[]): TestResult | undefined {
  let pending: { runner: string; ts: number } | null = null;
  let last: TestResult | undefined;

  for (const e of events) {
    const ts = new Date(e.timestamp).getTime() || 0;
    if (e.type === 'tool_use' && e.command) {
      const hit = TEST_RUNNERS.find(r => r.re.test(e.command!));
      pending = hit ? { runner: hit.label, ts } : pending;
    } else if (e.type === 'tool_result' && pending) {
      const parsed = parseTestOutput(pending.runner, e.output || '');
      last = { runner: pending.runner, ts: pending.ts, ...parsed };
      pending = null;
    } else if (e.type === 'error' && pending) {
      last = { runner: pending.runner, ts: pending.ts, ok: true, failed: 1 };
      pending = null;
    }
  }
  return last;
}
