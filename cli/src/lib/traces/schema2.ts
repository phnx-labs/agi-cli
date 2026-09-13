/* ────────────────────────────────────────────────────────────────────────
 * Schema 2 — canonical ToolExecution session detail (PHNX-3442, producer side).
 *
 * This is the PRODUCER's authoring contract for the `schema: 2` per-session
 * detail shard. It mirrors, field for field, the CONSUMER contract already
 * shipped and live in `prix/web/lib/traces/types.ts` (SessionDetailV2). The
 * split is deliberate: the command / patch / output PARSING lives here in
 * agents-cli — the worker stores the shard opaquely and the console reads the
 * union directly and NEVER reparses (spec §3, §5).
 *
 * Step 1 (the consumer decoder that reads BOTH schema 1 and schema 2) is merged
 * and live in prod, so emitting schema 2 from here is safe: an old console
 * would still read it, a new one reads it richly.
 *
 * This module is TYPES ONLY. The per-tool mappers that populate these shapes
 * (bash argv + classification, edit/write hunks + the cross-step revert ledger,
 * read/grep counts, first-class permission/hook steps) land in follow-up
 * increments alongside `buildSessionDetailV2`.
 * ──────────────────────────────────────────────────────────────────────── */

export type StepOutcome = 'ok' | 'error' | 'running' | 'unknown';

interface SessionStepBase {
  ordinal: number;
  startMs: number;
  durationMs: number;
  /**
   * Whether `durationMs` was measured from a paired result (`false`) or inferred
   * from the next event (`true`). Mandatory — the console must visually
   * distinguish measured from inferred duration.
   */
  durationEstimated: boolean;
  outcome: StepOutcome;
  label: string;
}

export interface ThinkingStep extends SessionStepBase {
  kind: 'thinking';
  lane: 'think';
  outcome: 'ok' | 'running' | 'unknown';
}

interface ExecutionBase extends SessionStepBase {
  kind: 'execution';
  lane: string;
  callId?: string;
  /** The tool call this execution targets (hook/permission → the guarded call). */
  targetCallId?: string;
}

type ToolExecutionType = 'bash' | 'edit' | 'write' | 'read' | 'grep' | 'generic';

interface ToolExecutionBase extends ExecutionBase {
  executionType: ToolExecutionType;
  tool: string;
  result: ExecutionResult;
}

export interface ExecutionResult {
  exitCode?: number;
  statusCode?: number;
  errorCode?: string;
  stdout?: TextPreview;
  stderr?: TextPreview;
  combined?: TextPreview;
}

export interface TextPreview {
  text: string;
  truncated: boolean;
  originalBytes: number;
}

export type BashCategory = 'build' | 'test' | 'git' | 'network' | 'other';

export type BashDanger = 'normal' | 'potentially-destructive' | 'DESTRUCTIVE';

export interface BashAction {
  ordinal: number;
  source: string;
  argv: string[];
  /** false when a dynamic node (substitution/expansion) kept argv incomplete. */
  argvComplete: boolean;
  program?: string;
  categories: BashCategory[];
  danger: BashDanger;
  destructiveOperation?: string;
}

export interface BashExecution extends ToolExecutionBase {
  executionType: 'bash';
  /** Redacted outer command. */
  command: string;
  /** Redacted shell payload after unwrapping `/bin/zsh -lc "…"`. */
  unwrappedCommand: string;
  parseStatus: 'parsed' | 'partial' | 'unparseable';
  parseDiagnostics: string[];
  actions: BashAction[];
}

export type FileOperation = 'create' | 'update' | 'overwrite' | 'delete' | 'rename' | 'unknown';

export interface FileHunk {
  id: string;
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
  addedLines: number;
  removedLines: number;
  beforeHash?: string;
  afterHash?: string;
  before?: TextPreview;
  after?: TextPreview;
  revertedByStep?: number;
}

export interface FileMutation {
  path: string;
  operation: FileOperation;
  hunks: FileHunk[];
  revertedByStep?: number;
}

export interface RevertLink {
  revertedStep: number;
  path: string;
  revertedHunkIds: string[];
}

export interface EditExecution extends ToolExecutionBase {
  executionType: 'edit';
  files: FileMutation[];
  reverts: RevertLink[];
}

export interface WriteExecution extends ToolExecutionBase {
  executionType: 'write';
  files: FileMutation[];
  reverts: RevertLink[];
}

export interface CountResult {
  value: number;
  relation: 'exact' | 'at-least';
}

export interface ReadExecution extends ToolExecutionBase {
  executionType: 'read';
  file: string;
  offset?: number;
  limit?: number;
  returnedLines?: CountResult;
  returnedBytes?: CountResult;
}

export interface GrepExecution extends ToolExecutionBase {
  executionType: 'grep';
  query: string;
  path?: string;
  glob?: string;
  outputMode?: 'content' | 'files' | 'count' | 'unknown';
  hits?: CountResult;
}

export interface GenericToolExecution extends ToolExecutionBase {
  executionType: 'generic';
  input?: TextPreview;
}

/** A permission request/decision — a first-class sibling, NOT a fake tool. */
export interface PermissionExecution extends ExecutionBase {
  executionType: 'permission';
  lane: 'permission';
  requestId?: string;
  permissionKind: 'command' | 'filesystem' | 'network' | 'mcp' | 'other';
  decision: 'approved' | 'denied' | 'cancelled' | 'pending';
  scope?: string;
  reason?: TextPreview;
}

/** A hook firing — a first-class sibling, NOT a fake tool. */
export interface HookExecution extends ExecutionBase {
  executionType: 'hook';
  lane: 'hook';
  hookName?: string;
  hookEvent?: string;
  phase: 'pre' | 'post' | 'session' | 'other';
  decision: 'allowed' | 'blocked' | 'error' | 'unknown';
  result: ExecutionResult;
}

export type SessionStepV2 =
  | ThinkingStep
  | BashExecution
  | EditExecution
  | WriteExecution
  | ReadExecution
  | GrepExecution
  | GenericToolExecution
  | PermissionExecution
  | HookExecution;
