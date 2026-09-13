/**
 * Group-by dimensions + time-to-first-tool latency for the traces insight
 * engine (the console's Issue bar).
 *
 * Pure functions, no I/O. Classifiers are DATA-DRIVEN TABLES — a new task type
 * or timing bucket is a row, not a new if/else-by-name arm. The integrator
 * (`insights.ts` / `sync.ts`) tags each session; this file does not write the
 * shard.
 *
 * Input is the redacted `SessionDetail` from `agents traces sync` plus the
 * SyncRow fields the detail strips (prompt, gitBranch, files). Structural —
 * `SessionDetail` is a valid `SegmentSession`.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const TASK_TYPES = ['bugfix', 'feature', 'refactor', 'test', 'chore', 'other'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

const FAILURE_TIMINGS = ['early', 'mid', 'late'] as const;
type FailureTiming = (typeof FAILURE_TIMINGS)[number];

/** The #1 group-by axis: compare the pair, never the model alone. */
interface SegmentAgent {
  model: string;
  harness: string;
}

export interface SegmentFile {
  path: string;
  /** Write/create vs Edit/patch. */
  action: 'new' | 'edit';
}

export interface SegmentStep {
  startMs: number;
  durationMs?: number;
  outcome?: 'ok' | 'error' | 'unknown' | string;
  tool?: string;
  kind?: 'tool' | 'thinking' | string;
  label?: string;
}

/**
 * Session shape the classifiers read. `SessionDetail` (sessions/<id>.json)
 * satisfies this; callers may also pass SyncRow fields (`prompt`, `gitBranch`,
 * `agent`, `model`, `files`) alongside steps.
 */
export interface SegmentSession {
  id?: string;
  prompt?: string | null;
  gitBranch?: string | null;
  topic?: string | null;
  label?: string | null;
  mode?: string | null;
  agent?: string | null;
  harness?: string | null;
  model?: string | null;
  spanMs?: number | null;
  files?: readonly SegmentFile[] | null;
  meta?: {
    agent?: string | null;
    model?: string | null;
    spanMs?: number | null;
    repo?: string | null;
    tools?: number | null;
  } | null;
  steps?: readonly SegmentStep[] | null;
  whereItWentWrong?: string | null;
}

export interface Percentiles {
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

/** Time-to-first-tool latency — `steps[0].startMs` over tool-using sessions. */
export interface LatencyInsight {
  firstToolMs: Percentiles;
}

interface SegmentDimensions {
  agent: SegmentAgent;
  taskType: TaskType;
  failureTiming: FailureTiming | null;
}

// ---------------------------------------------------------------------------
// Tables — the classifiers. Add a row; do not add an if/else-by-name arm.
// ---------------------------------------------------------------------------

/**
 * Tool name → file action. Lowercased. Write-family is a new file; Edit-family
 * is a patch. Anything else is ignored for diff-shape.
 */
const FILE_ACTION_TOOLS: ReadonlyArray<{
  action: SegmentFile['action'];
  tools: readonly string[];
}> = [
  { action: 'new', tools: ['write', 'write_file', 'create_file', 'create'] },
  { action: 'edit', tools: ['edit', 'strreplace', 'apply_patch', 'applypatch', 'notebookedit'] },
];

/** Path heuristics for a test-only diff. */
const TEST_PATH_PATTERN =
  /(?:^|\/)(?:__tests__|testdata|test)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rs)$/i;

/** Path heuristics for a chore-only diff (lockfiles, CI, docs). */
const CHORE_PATH_PATTERN =
  /(?:^|\/)(?:package(?:-lock)?\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|Dockerfile|Makefile|\.github\/|CHANGELOG[^/]*|README[^/]*|\.gitignore)$/i;

type DiffShape = {
  files: readonly SegmentFile[];
  testOnly: boolean;
  newOnly: boolean;
  choreOnly: boolean;
};

const DIFF_SHAPE_MATCHERS: ReadonlyArray<{
  key: keyof Pick<DiffShape, 'testOnly' | 'newOnly' | 'choreOnly'>;
  match: (files: readonly SegmentFile[]) => boolean;
}> = [
  {
    key: 'testOnly',
    match: (files) => files.length > 0 && files.every((f) => TEST_PATH_PATTERN.test(f.path)),
  },
  {
    key: 'newOnly',
    match: (files) => files.length > 0 && files.every((f) => f.action === 'new'),
  },
  {
    key: 'choreOnly',
    match: (files) => files.length > 0 && files.every((f) => CHORE_PATH_PATTERN.test(f.path)),
  },
];

/**
 * Task-type rules, first match wins. Prompt/branch keywords outrank diff shape
 * except where `shape` is set (test-only files, chore-only files, all-new files).
 *
 * Order is the product priority: test-only work is not a "feature"; a `fix/`
 * branch is a bugfix even if files are new; chore lockfile edits are not features.
 */
export const TASK_TYPE_RULES: ReadonlyArray<{
  type: Exclude<TaskType, 'other'>;
  patterns: readonly RegExp[];
  shape?: keyof Pick<DiffShape, 'testOnly' | 'newOnly' | 'choreOnly'>;
}> = [
  {
    type: 'test',
    patterns: [
      /\bunit tests?\b/,
      /\bintegration tests?\b/,
      /\btestdata\b/,
      /\bcoverage\b/,
      /\b(?:add|write|update|fix)\s+tests?\b/,
      /\btest[- ]only\b/,
      /(?:^|\/)tests?\//,
      /^test\//,
      /\.(?:test|spec)\./,
    ],
    shape: 'testOnly',
  },
  {
    type: 'bugfix',
    patterns: [
      /\bbugfix(?:es)?\b/,
      /\bhot[- ]?fix(?:es)?\b/,
      /\bfixes\b/,
      /\bfixing\b/,
      /\bfix\b/,
      /\bbugs?\b/,
      /\bregression\b/,
      /\bcrash(?:es|ed|ing)?\b/,
      /\bbroken\b/,
      /(?:^|\/)fix(?:es)?\//,
      /^bugfix\//,
    ],
  },
  {
    type: 'refactor',
    patterns: [
      /\brefactor(?:s|ing|ed)?\b/,
      /\bclean[- ]?ups?\b/,
      /\bextract(?:s|ing|ed)?\b/,
      /\brename(?:s|d|ing)?\b/,
      /(?:^|\/)refactor\//,
    ],
  },
  {
    type: 'chore',
    patterns: [
      /\bchore\b/,
      /\bdependenc(?:y|ies)\b/,
      /\bbump\b/,
      /\blint(?:ing|er)?\b/,
      /\bformat(?:ting)?\b/,
      /(?:^|\/)chore\//,
      /\b(?:ci|cd)[-_/]/,
    ],
    shape: 'choreOnly',
  },
  {
    type: 'feature',
    patterns: [
      /\bfeat(?:ure)?s?\b/,
      /\bimplement(?:s|ing|ed)?\b/,
      /\bnew feature\b/,
      /(?:^|\/)feat(?:ure)?\//,
    ],
    shape: 'newOnly',
  },
];

/**
 * Normalized position of the first failing step inside the session span.
 * Early failures cascade — highest-signal bucket. Exclusive upper bound.
 */
const FAILURE_TIMING_BUCKETS: ReadonlyArray<{
  timing: FailureTiming;
  maxExclusive: number;
}> = [
  { timing: 'early', maxExclusive: 1 / 3 },
  { timing: 'mid', maxExclusive: 2 / 3 },
  { timing: 'late', maxExclusive: Number.POSITIVE_INFINITY },
];

const AGENT_FIELDS = {
  model: [
    (s: SegmentSession) => s.meta?.model,
    (s: SegmentSession) => s.model,
  ],
  harness: [
    (s: SegmentSession) => s.meta?.agent,
    (s: SegmentSession) => s.harness,
    (s: SegmentSession) => s.agent,
  ],
} as const;

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/** Model × harness unit — the #1 group-by axis. */
export function deriveAgent(session: SegmentSession): SegmentAgent {
  return {
    model: firstPresent(AGENT_FIELDS.model.map((read) => read(session))),
    harness: firstPresent(AGENT_FIELDS.harness.map((read) => read(session))),
  };
}

/**
 * Classify the session's work from the opening prompt + diff shape (files
 * touched, new vs edit, test-only). First matching table row wins.
 */
export function classifyTaskType(session: SegmentSession): TaskType {
  const haystack = taskHaystack(session);
  const shape = inferDiffShape(session);
  for (const rule of TASK_TYPE_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(haystack))) return rule.type;
    if (rule.shape && shape[rule.shape]) return rule.type;
  }
  return 'other';
}

/**
 * Bucket the FIRST failing step by its normalized position in the session
 * span (`firstFailure.startMs / spanMs`). Sessions with no failing step
 * return null — they do not belong on the failure-timing axis.
 */
export function failureTiming(session: SegmentSession): FailureTiming | null {
  const firstFailure = (session.steps ?? []).find((step) => step.outcome === 'error');
  if (!firstFailure) return null;
  const span = sessionSpanMs(session);
  const position = span > 0 ? firstFailure.startMs / span : 0;
  return FAILURE_TIMING_BUCKETS.find((bucket) => position < bucket.maxExclusive)?.timing ?? null;
}

/**
 * Time-to-first-tool latency from `steps[0].startMs` across sessions that
 * recorded at least one step. Nearest-rank percentiles (same formula as the
 * traces index stats) so p99 on `/tmp/traces-real` lands at ~128s.
 */
export function computeLatency(sessions: readonly SegmentSession[]): LatencyInsight {
  const samples: number[] = [];
  for (const session of sessions) {
    const steps = session.steps ?? [];
    if (steps.length === 0) continue;
    const startMs = steps[0]?.startMs;
    if (typeof startMs !== 'number' || !Number.isFinite(startMs)) continue;
    samples.push(startMs);
  }
  return {
    firstToolMs: {
      p50: percentileNearest(samples, 0.5),
      p90: percentileNearest(samples, 0.9),
      p99: percentileNearest(samples, 0.99),
      max: samples.length === 0 ? 0 : Math.max(...samples),
    },
  };
}

/** All three group-by dimensions for one session. */
export function deriveDimensions(session: SegmentSession): SegmentDimensions {
  return {
    agent: deriveAgent(session),
    taskType: classifyTaskType(session),
    failureTiming: failureTiming(session),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function firstPresent(values: Array<string | null | undefined>): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return 'unknown';
}

function taskHaystack(session: SegmentSession): string {
  const filePaths = inferFiles(session).map((file) => file.path);
  const writeLabels = (session.steps ?? [])
    .filter((step) => fileActionForTool(step.tool) !== undefined)
    .map((step) => step.label ?? '');
  return [
    session.prompt,
    session.gitBranch,
    session.topic,
    session.label,
    session.meta?.repo,
    ...filePaths,
    ...writeLabels,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')
    .toLowerCase();
}

function inferFiles(session: SegmentSession): readonly SegmentFile[] {
  if (session.files && session.files.length > 0) return session.files;
  const files: SegmentFile[] = [];
  for (const step of session.steps ?? []) {
    const action = fileActionForTool(step.tool);
    if (!action) continue;
    const path = filePathFromLabel(step.label);
    if (!path) continue;
    files.push({ path, action });
  }
  return files;
}

function fileActionForTool(tool: string | undefined): SegmentFile['action'] | undefined {
  if (!tool) return undefined;
  const name = tool.toLowerCase();
  for (const row of FILE_ACTION_TOOLS) {
    if (row.tools.includes(name)) return row.action;
  }
  return undefined;
}

/** Best-effort path from a redacted Write/Edit label (`path/to/file.ts`). */
function filePathFromLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const match = label.match(/(?:^|[\s`'"])(\/?[\w.@-]+(?:\/[\w.@-]+)+\.[A-Za-z][\w.]*)/);
  return match?.[1];
}

function inferDiffShape(session: SegmentSession): DiffShape {
  const files = inferFiles(session);
  const shape: DiffShape = { files, testOnly: false, newOnly: false, choreOnly: false };
  for (const matcher of DIFF_SHAPE_MATCHERS) {
    shape[matcher.key] = matcher.match(files);
  }
  return shape;
}

function sessionSpanMs(session: SegmentSession): number {
  const declared = session.meta?.spanMs ?? session.spanMs ?? 0;
  if (declared > 0) return declared;
  let max = 0;
  for (const step of session.steps ?? []) {
    max = Math.max(max, step.startMs + (step.durationMs ?? 0));
  }
  return max;
}

/**
 * Nearest-rank percentile, ratio in (0, 1]. Same index rule as
 * `sync.ts`'s private `percentile` — linear interpolation (`lib/percentile.ts`)
 * would report ~71s for p99 on the 738-session corpus; the published figure is
 * 128s / 2m8s.
 */
function percentileNearest(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}
