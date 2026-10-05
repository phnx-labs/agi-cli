#!/usr/bin/env bun
/** Time the impact planner on a representative leaf change (RUSH-2666); does not run the full CLI
 * suite. Quote the printed JSON as evidence. */
import { selectImpact, commandsForPlan, IMPACT_BUDGET_SEC, repoRootFrom } from './ci-scope';

const repoRoot = repoRootFrom();
const leaf = process.argv[2] ?? 'cli/src/lib/artifact-actions.ts';
const t0 = performance.now();
const plan = selectImpact({ files: [leaf], repoRoot });
const planMs = Math.round(performance.now() - t0);
const cmds = commandsForPlan(plan, repoRoot);
const report = {
  leaf,
  plan_ms: planMs,
  selected_tests: plan.tests.length,
  checks: plan.checks,
  suite: plan.suite,
  unmapped: plan.unmapped,
  budget_sec: plan.budget_sec ?? IMPACT_BUDGET_SEC,
  vitest_files: cmds
    .filter((c) => c.cmd.some((part) => part.includes('vitest.mjs')))
    .flatMap((c) => {
      const i = c.cmd.indexOf('--');
      return i >= 0 ? c.cmd.slice(i + 1) : [];
    }),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (plan.unmapped.length) process.exit(1);
if (plan.suite === 'selected' && plan.tests.length === 0 && plan.checks.length === 0) {
  process.stderr.write('leaf selected nothing\n');
  process.exit(1);
}
