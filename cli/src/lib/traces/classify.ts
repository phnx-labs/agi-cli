export type TraceTopicGroup = 'code' | 'research' | 'review' | 'content' | 'ops';
/**
 * `real`/`guard`/`hook` are the cause buckets of a FAILED tool call (`classifyCause`).
 * `behavioral` is different in kind: a silent failure with no error code at all — the
 * agent went idle after its last event and a human had to nudge it. It is derived from
 * per-session friction facets (`computeBehavioralPatterns` in `insights.ts`), never from
 * `classifyCause`, so a failed-tool-call classifier never returns it.
 */
export type TraceFailureCause = 'real' | 'guard' | 'hook' | 'behavioral';

/** Per-bucket aggregate stats for one day, stored in the rolling bucketHistory. */
export interface BucketStats {
  key: string;
  date: string;
  count: number;
  /** Tool-error count / total tool calls in this session set (0–1). */
  errorRate: number;
  /** Sessions with ≥1 stall friction signal / total sessions in bucket (0–1). */
  stallRate: number;
}

/** Movement signal for one topic bucket compared to its 7-day rolling average. */
export interface DriftSignal {
  bucket: string;
  /** current errorRate − 7d average (positive = degrading). */
  errorDelta: number;
  /** current stallRate − 7d average (positive = degrading). */
  stallDelta: number;
  severity: 'degrading' | 'stable' | 'improving';
}

interface TopicEvidence {
  cwd?: string | null;
  gitBranch?: string | null;
  topic?: string | null;
  label?: string | null;
  toolMix?: Record<string, number>;
}

export interface ClassifiedTopic {
  group: TraceTopicGroup;
  key: string;
  label: string;
}

interface ToolCallFailure {
  tool: string;
  exit_code?: number | null;
  status_code?: number | null;
  error_code?: string | null;
  error?: string | null;
  parse_error?: string | null;
  outcome?: string | null;
}

function normalizedEvidence(input: TopicEvidence): string {
  return [input.cwd, input.gitBranch, input.topic, input.label]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

/**
 * The human task labels the console's session-topic treemap renders — the taxonomy
 * approved in the Phoenix Evals mockup (`console-v0-mockup.html`, 2026-08-24), which the
 * shipped 5-label heuristic never matched. Ordered most-specific first; the first rule
 * whose `text` (normalized cwd+branch+topic+label) or `tool` (any tool in the mix) hits
 * wins. `group` stays one of the five stable `TraceTopicGroup` values so the treemap's
 * grouping and existing consumers don't move — only the per-leaf `key`/`label` become the
 * granular human terms (Feature work / Bug fixes / Refactor / Debugging / Release /
 * Fleet-ops / Blog & docs). One-time: existing users' `bucketHistory`/`driftSignals` keyed
 * on the old `engineering`/`operations`/`content` show a single-day discontinuity the day
 * this ships, then track the new keys.
 */
interface TopicRule {
  group: TraceTopicGroup;
  key: string;
  label: string;
  text?: RegExp;
  tool?: RegExp;
}

const TOPIC_RULES: readonly TopicRule[] = [
  { group: 'review', key: 'code-review', label: 'Code review',
    text: /\b(review|audit|pr[-_/ ]?review|code[-_/ ]?review)\b/, tool: /review|comment/ },
  { group: 'ops', key: 'release', label: 'Release',
    text: /\b(release|deploy|publish|rollout|changelog)\b/ },
  { group: 'research', key: 'debugging', label: 'Debugging',
    text: /\b(debug|investigat|repro|root[-_ ]?cause|traceback|stack ?trace)\b/ },
  { group: 'content', key: 'content', label: 'Blog & docs',
    text: /\b(blog|docs?|documentation|readme|post|article|content|caption)\b/ },
  { group: 'research', key: 'research', label: 'Research',
    text: /\b(research|analysis|benchmark|paper|explore|spike)\b/, tool: /web_search|search_query|webfetch|browser/ },
  { group: 'code', key: 'bugfix', label: 'Bug fixes',
    text: /\b(fix|bug|hotfix|patch)\b/ },
  { group: 'code', key: 'refactor', label: 'Refactor',
    text: /\b(refactor|cleanup|clean[-_ ]?up|restructure|rename|tidy)\b/ },
  { group: 'ops', key: 'operations', label: 'Fleet / ops',
    text: /\b(fleet|ci|infra|daemon|provision|ops|pipeline)\b/, tool: /ssh|deploy|computer/ },
  { group: 'code', key: 'feature', label: 'Feature work',
    text: /\b(feat|feature|implement|add|build|code|test)\b/, tool: /edit|write|apply_patch|exec|bash|shell/ },
];

/** Classify a session from metadata and aggregate tool names; never reads transcript text. */
export function classifyTopic(input: TopicEvidence): ClassifiedTopic {
  const text = normalizedEvidence(input);
  const tools = Object.keys(input.toolMix ?? {}).map((tool) => tool.toLowerCase());
  for (const rule of TOPIC_RULES) {
    if ((rule.text && rule.text.test(text)) || (rule.tool && tools.some((tool) => rule.tool!.test(tool)))) {
      return { group: rule.group, key: rule.key, label: rule.label };
    }
  }
  return { group: 'research', key: 'general', label: 'General' };
}

/** Bucket a failed tool call without inspecting raw tool input or transcript text. */
export function classifyCause(call: ToolCallFailure): TraceFailureCause {
  const evidence = [call.error_code, call.error, call.parse_error]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  if (/\b(?:git-guard|main-branch-guard)\b/.test(evidence)) return 'guard';
  if (/permission\b.*\bdenied\b.*\b(?:auto[- ]mode|classifier)\b/.test(evidence)) {
    return 'hook';
  }
  return 'real';
}

const DRIFT_THRESHOLD = 0.20;

/**
 * Compare today's per-bucket stats to the last 7 days of history and return
 * movement signals. Buckets with fewer than 3 historical days are skipped —
 * not enough signal to distinguish noise from drift.
 */
export function computeDriftSignal(
  history: BucketStats[][],
  today: BucketStats[],
): DriftSignal[] {
  const signals: DriftSignal[] = [];
  for (const stat of today) {
    const pastStats = history
      .flatMap((day) => day.filter((b) => b.key === stat.key))
      .slice(-7);
    if (pastStats.length < 3) continue;
    const avgError = pastStats.reduce((sum, b) => sum + b.errorRate, 0) / pastStats.length;
    const avgStall = pastStats.reduce((sum, b) => sum + b.stallRate, 0) / pastStats.length;
    const errorDelta = stat.errorRate - avgError;
    const stallDelta = stat.stallRate - avgStall;
    const severity: DriftSignal['severity'] =
      errorDelta > DRIFT_THRESHOLD || stallDelta > DRIFT_THRESHOLD
        ? 'degrading'
        : errorDelta < -DRIFT_THRESHOLD || stallDelta < -DRIFT_THRESHOLD
        ? 'improving'
        : 'stable';
    signals.push({ bucket: stat.key, errorDelta, stallDelta, severity });
  }
  return signals.sort((a, b) => b.errorDelta - a.errorDelta);
}
