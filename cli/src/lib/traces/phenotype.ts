
import type { SessionDetail } from './sync.js';


export type FailurePhenotype =
  | 'false-termination'
  | 'premature-completion'
  | 'out-of-order'
  | 'failure-to-act';

type TraceOutcome =
  | 'merged'
  | 'tests-green'
  | 'partial'
  | 'abandoned'
  | 'human-takeover'
  | 'invalid-env';

interface PhenotypeResult {
  phenotype: FailurePhenotype | null;
  reason: string;
}

interface OutcomeResult {
  outcome: TraceOutcome;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}


const READ_PLAN_TOOLS = new Set([
  'Read',
  'read_file',
  'grep',
  'list_dir',
  'search',
  'codebase_search',
  'ToolSearch',
  'web_search',
  'web_fetch',
  'WebSearch',
  'FetchURL',
  'TaskCreate',
  'todo_write',
]);

const WRITE_EDIT_TOOLS = new Set([
  'Edit',
  'Write',
  'search_replace',
  'write',
  'notebookedit',
  'multiedit',
]);

const HUMAN_FACING_TOOLS = new Set(['AskUserQuestion', 'SendMessage', 'wait']);

const SHELL_TOOLS = new Set([
  'Bash',
  'run_terminal_command',
  'exec_command',
  'exec',
  'shell',
  'Execute',
]);

type OutcomeSignalType = 'merge' | 'test' | 'env' | 'revert';

interface OutcomeSignal {
  type: OutcomeSignalType;
  pattern: RegExp;
}

const OUTCOME_SIGNALS: OutcomeSignal[] = [
  { type: 'merge', pattern: /\bgh pr merge\b|\bmerged?\b.*\b(PR|pull request|branch)\b|\brebase-?merge\b/i },
  { type: 'merge', pattern: /\bmerge\b.*\bsucceeded\b|\bsuccessfully\s+merged\b/i },
  { type: 'test', pattern: /\b(bun test|npm test|yarn test|pnpm test|pytest|jest|vitest|cargo test|go test)\b/i },
  { type: 'test', pattern: /\btsc\s+--noEmit\b|\blint\b|\btest\.sh\b/i },
  { type: 'env', pattern: /\bbun install\b|\bnpm install\b|\byarn install\b|\bpnpm install\b|\bpip install\b/i },
  { type: 'env', pattern: /\bnode_modules\b|\bmissing\b|\bnot found\b|\bpermission denied\b|\bcommand not found\b/i },
  { type: 'env', pattern: /\bssh.*key\b|\bclone\b.*\bfailed\b/i },
  { type: 'revert', pattern: /\brevert\b|\bgit checkout\b|\breset\s+--hard\b/i },
];


function isToolStep(step: SessionDetail['steps'][number]): boolean {
  return step.kind === 'tool';
}

function substantiveSteps(session: Pick<SessionDetail, 'steps'>): SessionDetail['steps'] {
  return session.steps.filter((s) => isToolStep(s) && !HUMAN_FACING_TOOLS.has(s.tool ?? s.lane));
}

function firstStepOrdinalOf(
  session: SessionDetail,
  predicate: (step: SessionDetail['steps'][number]) => boolean,
): number | undefined {
  for (const step of session.steps) {
    if (predicate(step)) return step.ordinal;
  }
  return undefined;
}

function lastStepOrdinalOf(
  session: Pick<SessionDetail, 'steps'>,
  predicate: (step: SessionDetail['steps'][number]) => boolean,
): number | undefined {
  let last: number | undefined;
  for (const step of session.steps) {
    if (predicate(step)) last = step.ordinal;
  }
  return last;
}

function stepText(step: SessionDetail['steps'][number]): string {
  return `${step.label ?? ''} ${step.detail ?? ''}`.trim().toLowerCase();
}

function isShellStep(step: SessionDetail['steps'][number]): boolean {
  return SHELL_TOOLS.has(step.tool ?? step.lane);
}

function hasSignal(
  session: SessionDetail,
  type: OutcomeSignalType,
  toolFilter?: Set<string>,
): boolean {
  for (const step of session.steps) {
    if (toolFilter && !toolFilter.has(step.tool ?? step.lane)) continue;
    const text = stepText(step);
    for (const signal of OUTCOME_SIGNALS) {
      if (signal.type === type && signal.pattern.test(text)) return true;
    }
  }
  return false;
}

function signalCounts(session: SessionDetail): Record<OutcomeSignalType, number> {
  const counts: Record<OutcomeSignalType, number> = { merge: 0, test: 0, env: 0, revert: 0 };
  for (const step of session.steps) {
    const text = stepText(step);
    for (const signal of OUTCOME_SIGNALS) {
      if ((signal.type === 'merge' || signal.type === 'test') && !isShellStep(step)) continue;
      if (signal.pattern.test(text)) counts[signal.type]++;
    }
  }
  return counts;
}


function isFailureToAct(session: SessionDetail): boolean {
  if (session.meta.tools === 0 && session.meta.turns <= 2) return true;
  const substantive = substantiveSteps(session);
  return substantive.length === 0;
}

function reasonFailureToAct(session: SessionDetail): string {
  if (session.meta.tools === 0 && session.meta.turns <= 2) {
    return `no tool use (${session.meta.tools} tools, ${session.meta.turns} turns)`;
  }
  return 'no substantive tool steps';
}

function isOutOfOrder(session: SessionDetail): boolean {
  const firstWrite = firstStepOrdinalOf(session, (s) => WRITE_EDIT_TOOLS.has(s.tool ?? s.lane));
  if (firstWrite === undefined) return false;
  const firstReadPlan = firstStepOrdinalOf(session, (s) => READ_PLAN_TOOLS.has(s.tool ?? s.lane));
  if (firstReadPlan === undefined) return true;
  return firstWrite < firstReadPlan;
}

function reasonOutOfOrder(session: SessionDetail): string {
  const tool = session.steps.find((s) => WRITE_EDIT_TOOLS.has(s.tool ?? s.lane));
  return `write/edit step ${tool?.tool ?? tool?.lane ?? ''} preceded any read/plan`;
}

function workSignature(step: SessionDetail['steps'][number]): string {

  const tool = step.tool ?? step.lane;
  if (SHELL_TOOLS.has(tool) && step.program) return `${tool}:${step.program}`;
  return tool;
}

export function recoveredAfterErrors(session: Pick<SessionDetail, 'steps'>): boolean {

  const substantive = substantiveSteps(session);
  if (substantive.length === 0) return false;
  const last = substantive[substantive.length - 1];
  if (last.outcome === 'error') return false;
  const lastErrorOrdinal = lastStepOrdinalOf(session, (s) => s.outcome === 'error');
  if (lastErrorOrdinal === undefined) return true;
  const failedSignatures = new Set<string>();
  for (const s of session.steps) {
    if (s.outcome === 'error') failedSignatures.add(workSignature(s));
  }
  return substantive.some(
    (s) =>
      s.ordinal > lastErrorOrdinal &&
      s.outcome === 'ok' &&
      !HUMAN_FACING_TOOLS.has(s.tool ?? s.lane) &&
      failedSignatures.has(workSignature(s)),
  );
}

function isFalseTermination(session: SessionDetail): boolean {
  if (session.meta.outcome !== 'errored') return false;
  if (session.meta.errorCount === 0) return false;
  return !recoveredAfterErrors(session);
}

function reasonFalseTermination(session: SessionDetail): string {
  const substantive = substantiveSteps(session);
  if (substantive.length === 0) return 'errored with no substantive steps';
  const last = substantive[substantive.length - 1];
  if (last.outcome === 'error') {
    return `last substantive step ${last.tool ?? last.lane} ended in error`;
  }
  return 'errored with no successful recovery after the last error';
}

function isPrematureCompletion(session: SessionDetail): boolean {
  if (session.meta.outcome !== 'completed') return false;
  const didWriteEdit = session.steps.some((s) => WRITE_EDIT_TOOLS.has(s.tool ?? s.lane));
  if (!didWriteEdit) return false;
  const verified = session.steps.some((s) => {
    if (!SHELL_TOOLS.has(s.tool ?? s.lane)) return false;
    const text = stepText(s);
    return /\b(bun test|npm test|yarn test|pnpm test|pytest|jest|vitest|cargo test|go test|tsc\s+--noEmit|lint|build|verify)\b/.test(text);
  });
  return !verified;
}

function reasonPrematureCompletion(_session: SessionDetail): string {
  return 'engineering work completed without a test/build/lint verification step';
}


interface PhenotypeRule {
  key: FailurePhenotype;
  score: (session: SessionDetail) => boolean;
  reason: (session: SessionDetail) => string;
}

const PHENOTYPE_RULES: PhenotypeRule[] = [
  { key: 'failure-to-act', score: isFailureToAct, reason: reasonFailureToAct },
  { key: 'out-of-order', score: isOutOfOrder, reason: reasonOutOfOrder },
  { key: 'false-termination', score: isFalseTermination, reason: reasonFalseTermination },
  { key: 'premature-completion', score: isPrematureCompletion, reason: reasonPrematureCompletion },
];


function isMerged(session: SessionDetail): boolean {
  return session.meta.outcome === 'completed' && hasSignal(session, 'merge', SHELL_TOOLS);
}

function mergedReason(session: SessionDetail): string {
  return 'explicit merge signal present and session completed';
}

function isTestsGreen(session: SessionDetail): boolean {
  if (session.meta.outcome !== 'completed') return false;
  const testSteps = session.steps.filter((s) => {
    if (!isShellStep(s)) return false;
    const text = stepText(s);
    return OUTCOME_SIGNALS.some((sig) => sig.type === 'test' && sig.pattern.test(text));
  });
  if (testSteps.length === 0) return false;
  const lastTest = testSteps[testSteps.length - 1];
  if (lastTest.outcome === 'ok') return true;
  return session.meta.errorCount === 0;
}

function testsGreenConfidence(session: SessionDetail): OutcomeResult['confidence'] {
  const testSteps = session.steps.filter((s) => {
    if (!isShellStep(s)) return false;
    const text = stepText(s);
    return OUTCOME_SIGNALS.some((sig) => sig.type === 'test' && sig.pattern.test(text));
  });
  const lastTest = testSteps[testSteps.length - 1];
  return lastTest?.outcome === 'ok' ? 'high' : 'medium';
}

function testsGreenReason(session: SessionDetail): string {
  const confidence = testsGreenConfidence(session);
  return confidence === 'high'
    ? 'last test/build/lint step returned ok'
    : 'completed cleanly with test steps (step outcomes unavailable)';
}

function isHumanTakeover(session: SessionDetail): boolean {
  const tools = session.steps.filter((s) => isToolStep(s));
  if (tools.length === 0) return false;
  const last = tools[tools.length - 1];
  return HUMAN_FACING_TOOLS.has(last.tool ?? last.lane);
}

function humanTakeoverReason(session: SessionDetail): string {
  const tools = session.steps.filter((s) => isToolStep(s));
  const last = tools[tools.length - 1];
  return `final tool step is ${last.tool ?? last.lane}`;
}

function isInvalidEnv(session: SessionDetail): boolean {
  const envSteps = session.steps.filter((s) => {
    const text = stepText(s);
    return OUTCOME_SIGNALS.some((sig) => sig.type === 'env' && sig.pattern.test(text));
  });
  const envErrors = envSteps.filter((s) => s.outcome === 'error').length;
  const totalErrors = session.meta.errorCount;

  if (totalErrors > 0 && envErrors >= 2 && envErrors / totalErrors >= 0.5) return true;
  if (session.meta.outcome === 'errored' && envSteps.length >= 3 && envErrors / envSteps.length >= 0.5) return true;

  const substantive = substantiveSteps(session);
  const firstError = substantive.find((s) => s.outcome === 'error');
  if (
    session.meta.outcome === 'errored' &&
    firstError &&
    OUTCOME_SIGNALS.some((sig) => sig.type === 'env' && sig.pattern.test(stepText(firstError)))
  ) {
    const firstErrorIndex = substantive.indexOf(firstError);
    const after = substantive.slice(firstErrorIndex + 1);
    const recovered = after.some((s) => s.outcome === 'ok' && !HUMAN_FACING_TOOLS.has(s.tool ?? s.lane));
    if (!recovered) return true;
  }
  return false;
}

function invalidEnvReason(session: SessionDetail): string {
  const envSteps = session.steps.filter((s) => {
    const text = stepText(s);
    return OUTCOME_SIGNALS.some((sig) => sig.type === 'env' && sig.pattern.test(text));
  });
  const envErrors = envSteps.filter((s) => s.outcome === 'error').length;
  const totalErrors = session.meta.errorCount;
  if (totalErrors > 0 && envErrors >= 2 && envErrors / totalErrors >= 0.5) {
    return `${envErrors}/${totalErrors} errors are environment/setup related`;
  }
  return 'environment/setup failures dominated the early session and blocked recovery';
}

function isAbandoned(session: SessionDetail): boolean {
  if (session.meta.outcome !== 'errored') return false;
  const hasStall = session.gaps.some((g) => g.durationMs >= 120_000);
  const substantive = substantiveSteps(session);
  if (substantive.length === 0) return hasStall || session.meta.errorCount > 0;
  const lastErrorOrdinal = lastStepOrdinalOf(session, (s) => s.outcome === 'error');
  if (lastErrorOrdinal === undefined) return false;
  const recoveryAfter = substantive.some(
    (s) => s.ordinal > lastErrorOrdinal && s.outcome === 'ok' && !HUMAN_FACING_TOOLS.has(s.tool ?? s.lane),
  );
  return !recoveryAfter || hasStall;
}

function abandonedReason(session: SessionDetail): string {
  const hasStall = session.gaps.some((g) => g.durationMs >= 120_000);
  return hasStall ? 'errored with a long stall and no recovery' : 'errored with no successful recovery';
}

function isPartial(_session: SessionDetail): boolean {
  return true;
}

function partialReason(session: SessionDetail): string {
  const counts = signalCounts(session);
  if (session.meta.outcome === 'completed') {
    if (counts.test > 0) return 'tests ran but final test step did not return ok';
    if (counts.merge > 0) return 'merge-related activity but no confirmed merge';
    return 'completed without a landing or test signal';
  }
  return 'incomplete work with no higher-confidence outcome signal';
}


interface OutcomeRule {
  key: TraceOutcome;
  confidence: 'high' | 'medium' | 'low' | ((session: SessionDetail) => 'high' | 'medium' | 'low');
  score: (session: SessionDetail) => boolean;
  reason: (session: SessionDetail) => string;
}

function ruleConfidence(
  rule: OutcomeRule,
  session: SessionDetail,
): 'high' | 'medium' | 'low' {
  return typeof rule.confidence === 'function' ? rule.confidence(session) : rule.confidence;
}

const OUTCOME_RULES: OutcomeRule[] = [
  { key: 'merged', confidence: 'high', score: isMerged, reason: mergedReason },
  { key: 'tests-green', confidence: testsGreenConfidence, score: isTestsGreen, reason: testsGreenReason },
  { key: 'human-takeover', confidence: 'medium', score: isHumanTakeover, reason: humanTakeoverReason },
  { key: 'invalid-env', confidence: 'medium', score: isInvalidEnv, reason: invalidEnvReason },
  { key: 'abandoned', confidence: 'medium', score: isAbandoned, reason: abandonedReason },
  { key: 'partial', confidence: 'low', score: isPartial, reason: partialReason },
];


export function classifyPhenotype(session: SessionDetail): FailurePhenotype | null {
  return classifyPhenotypeDetailed(session).phenotype;
}

export function classifyPhenotypeDetailed(session: SessionDetail): PhenotypeResult {
  for (const rule of PHENOTYPE_RULES) {
    if (rule.score(session)) {
      return { phenotype: rule.key, reason: rule.reason(session) };
    }
  }
  return { phenotype: null, reason: 'no failure phenotype matched' };
}

export function deriveOutcome(session: SessionDetail): TraceOutcome {
  return deriveOutcomeDetailed(session).outcome;
}

export function deriveOutcomeDetailed(session: SessionDetail): OutcomeResult {
  for (const rule of OUTCOME_RULES) {
    if (rule.score(session)) {
      return { outcome: rule.key, confidence: ruleConfidence(rule, session), reason: rule.reason(session) };
    }
  }
  return { outcome: 'partial', confidence: 'low', reason: 'no outcome signal matched' };
}

export type { SessionDetail } from './sync.js';
