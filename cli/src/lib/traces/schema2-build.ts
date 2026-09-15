/**
 * schema2-build — the PRODUCER's per-tool mappers + `buildSessionDetailV2`
 * (PHNX-3442 step 2, increments 2-4).
 *
 * Populates the `SessionStepV2` discriminated union (schema2.ts) from the parsed
 * session events, reusing the SAME infrastructure the schema-1 path already uses:
 *
 *   - the callId pairing loop (`pairSteps` in session/trajectory.ts) — so a step's
 *     (use event, result event) triple is recovered without a duplicate loop;
 *   - bash unwrap/tokenize/classify (`session/bash-command.ts`) + the effective
 *     program resolver (`effectiveProgram`);
 *   - the meta / whereItWentWrong / surfacedToolFailures / active-time helpers
 *     factored out of sync.ts (`buildDetailMeta`, `buildWhereItWentWrong`, …).
 *
 * The command/patch/output PARSING lives here; the worker stores the shard
 * opaquely and the console reads the union directly and never reparses (spec §5).
 *
 * category / risk / categoryMetrics are DELIBERATELY omitted from the schema-2
 * detail: the shipped consumer (`decodeSessionDetail` → coerceCategory/Risk/Metrics)
 * backfills them to the same neutral defaults it uses for schema-1, so computing
 * them here would be inventing session-level signal this step does not own.
 */

import { createHash } from 'node:crypto';
import { redactSecrets } from '../redact.js';
import {
  classifyBashCommand,
  tokenizeBash,
  unwrapCommand,
  type BashCategory as ClassifierCategory,
} from '@phnx-labs/sessions-cli/reader';
import { computeSummaryStats } from '@phnx-labs/sessions-cli/reader';
import { extractShellPrograms } from '@phnx-labs/sessions-cli/reader';
import {
  effectiveProgram,
  eventTimestampsMs,
  pairSteps,
  type SessionTrajectory,
  type StepDraft,
} from '@phnx-labs/sessions-cli/reader';
import type { SessionEvent } from '@phnx-labs/sessions-cli/reader';
import { classifyActionDanger } from './schema2-danger.js';
import type {
  BashAction,
  BashCategory,
  BashExecution,
  CountResult,
  EditExecution,
  ExecutionResult,
  FileHunk,
  FileMutation,
  GenericToolExecution,
  GrepExecution,
  HookExecution,
  ReadExecution,
  RevertLink,
  SessionStepV2,
  StepOutcome,
  TextPreview,
  ThinkingStep,
  WriteExecution,
} from './schema2.js';
import {
  activeMsFromTrajectory,
  buildDetailMeta,
  buildWhereItWentWrong,
  type SessionDetail,
} from './sync.js';

/**
 * SessionDetailV2 — the schema-2 shard this producer emits.
 *
 * `category` / `risk` / `categoryMetrics` are DELIBERATELY OMITTED. The consumer's
 * `SessionDetailV2` declares them, but its `decodeSchema2` backfills neutral
 * defaults via `coerceCategory`/`coerceRisk`/`coerceMetrics` (never throws) — the
 * same defaulting it applies to schema-1 shards today. This producer does not yet
 * author those fields (their provenance is the prix/api PHNX-3351 hosted backend,
 * not agents-cli), so emitting them here would fabricate classification. Omission
 * is the honest choice and is asserted as a tested contract in
 * `schema2-fixture.test.ts`. Wire real category/risk here once its source is settled.
 */
export interface SessionDetailV2 {
  schema: 2;
  id: string;
  meta: SessionDetail['meta'];
  steps: SessionStepV2[];
  gaps: SessionTrajectory['gaps'];
  truncatedSteps: number;
  whereItWentWrong: string | null;
  surfacedToolFailures: Array<{ tool?: string; label: string; detail?: string }>;
}

// ---------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------

/** Cap on a single preview's characters — the same 500-ish bound parse.ts uses. */
const PREVIEW_MAX = 2000;

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * A bounded, redacted preview of text. `truncated` and `originalBytes` are honest —
 * the console needs to know whether it is seeing the whole thing (spec: the UI must
 * distinguish complete from truncated output). `originalBytes` is the UTF-8 byte
 * length of the FULL text, before clipping.
 */
function textPreview(
  raw: string | undefined,
  redact: boolean,
  knownSecrets: readonly string[] | undefined,
): TextPreview | undefined {
  if (raw === undefined || raw === null || raw.length === 0) return undefined;
  const originalBytes = Buffer.byteLength(raw, 'utf8');
  const clipped = raw.length > PREVIEW_MAX ? raw.slice(0, PREVIEW_MAX) : raw;
  const text = redact ? redactSecrets(clipped, knownSecrets) : clipped;
  return { text, truncated: raw.length > PREVIEW_MAX, originalBytes };
}

function stringArg(args: Record<string, any> | undefined, ...keys: string[]): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function numberArg(args: Record<string, any> | undefined, ...keys: string[]): number | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** The result event's ExecutionResult (exit/status/error codes + a combined output preview). */
function resultOf(
  resultEvent: SessionEvent | undefined,
  redact: boolean,
  knownSecrets: readonly string[] | undefined,
): ExecutionResult {
  const result: ExecutionResult = {};
  if (!resultEvent) return result;
  if (typeof resultEvent.exitCode === 'number') result.exitCode = resultEvent.exitCode;
  if (typeof resultEvent.statusCode === 'number') result.statusCode = resultEvent.statusCode;
  if (typeof resultEvent.errorCode === 'string') result.errorCode = resultEvent.errorCode;
  const combined = textPreview(resultEvent.output ?? resultEvent.content, redact, knownSecrets);
  if (combined) result.combined = combined;
  return result;
}

function stepOutcome(step: StepDraft['step']): StepOutcome {
  const o = step.outcome;
  if (o === 'ok' || o === 'error' || o === 'unknown') return o;
  return 'unknown';
}

/**
 * `at-least` when the output was truncated by the parser's per-event cap, else
 * `exact`. The parser caps `output` centrally (parse.ts `maxToolOutputChars`), so a
 * result whose text hit the cap under-counts — the count is a floor, not the truth.
 */
function countLines(
  resultEvent: SessionEvent | undefined,
): CountResult | undefined {
  if (!resultEvent) return undefined;
  const text = resultEvent.output ?? resultEvent.content;
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const lines = text.split('\n');
  // A trailing newline yields a final empty element — don't count it as a line.
  const value = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  // The parser truncates long tool output; we can't see the original length here,
  // so a preview that fills the cap is treated as a floor. PREVIEW-independent:
  // parse.ts already clipped, so the safest signal is whether the text looks cut.
  const truncated = text.length >= PREVIEW_MAX;
  return { value, relation: truncated ? 'at-least' : 'exact' };
}

// ---------------------------------------------------------------------------
// Bash unwrapping — extend unwrapCommand for the shell-exec wrappers it misses
// ---------------------------------------------------------------------------

/**
 * `unwrapCommand` (bash-command.ts) strips VAR=/sudo/cd&&/npx/loops/subshells but
 * NOT an interpreter wrapper like `/bin/zsh -lc "…"`, `bash -lc '…'`, or `sh -c …`
 * — the exact shape the managed runner wraps every command in. Peel that first,
 * then hand the inner payload to the existing unwrapper so all the wrappers it DOES
 * know still apply. One extra rule, at the source, not a fork of unwrapCommand.
 */
export function unwrapShellExec(command: string): string {
  const s = command.trim();
  // <interpreter> [flags] -c|-lc "PAYLOAD"  — interpreter is bash/zsh/sh/dash/ksh,
  // possibly a full path; the -c flag may be clustered with login/interactive
  // flags (`-lc`, `-ic`). The payload is the last quoted argument.
  const m = s.match(
    /^(?:\S*\/)?(?:bash|zsh|sh|dash|ksh)\s+(?:-[a-zA-Z]*c[a-zA-Z]*)\s+(['"])([\s\S]*)\1\s*$/,
  );
  if (m) return unwrapShellExec(m[2]);
  return unwrapCommand(s);
}

/**
 * Map a classifier `BashCategory` (the rich vcs|build-test|install|… taxonomy) to
 * the coarse schema-2 `BashCategory` (build|test|git|network|other). `build-test`
 * needs the argv/subcommand to decide build vs test — `bun test` is test, `bun
 * build` is build — so this takes the tokenized argv too.
 */
export function mapBashCategory(cat: ClassifierCategory, argv: string[]): BashCategory {
  switch (cat) {
    case 'vcs':
      return 'git';
    case 'remote':
    case 'http':
      return 'network';
    case 'build-test': {
      const lower = argv.map((t) => t.toLowerCase());
      const looksTest = lower.some((t) =>
        t === 'test' || t === 't' || /vitest|jest|pytest|mocha/.test(t) ||
        t === '--test' || /(^|:)test(:|$)/.test(t),
      );
      return looksTest ? 'test' : 'build';
    }
    default:
      return 'other';
  }
}

/**
 * Whether a segment's argv is COMPLETE — i.e. no dynamic node (command
 * substitution, process substitution, arithmetic/param expansion, glob) could
 * change what actually ran. Reuses the shell parser's occurrence walk indirectly:
 * a segment whose reconstructed programs from `extractShellPrograms` are all static
 * is complete. We approximate with the parser's diagnostics + a substitution scan,
 * because the schema-2 argv is the tokenizeBash split (shlex), which cannot itself
 * report expansion.
 */
function argvComplete(source: string): boolean {
  // A command/process substitution or an unexpanded var/glob means the literal
  // argv we tokenized is not the whole story.
  if (/\$\(|\$\{|`|<\(|\)\s*$/.test(source) && /\$\(|\$\{|`|<\(/.test(source)) return false;
  if (/\$[A-Za-z_]/.test(source)) return false; // a bare $VAR expansion
  if (/[*?]/.test(source) && !/['"][^'"]*[*?]/.test(source)) return false; // an unquoted glob
  return true;
}

/** Build the per-segment BashAction list for a bash command. */
export function buildBashActions(unwrapped: string): BashAction[] {
  const segments = tokenizeBash(unwrapped);
  const actions: BashAction[] = [];
  // Recover each segment's raw source text for `source`/argvComplete: tokenizeBash
  // drops the operators, so re-derive display source from the argv join (redaction
  // is applied by the caller on the whole command; the per-action source is the
  // already-tokenized argv, which carries no secrets the command didn't).
  segments.forEach((argv, i) => {
    if (argv.length === 0) return;
    const source = argv.join(' ');
    const info = classifyBashCommand(source);
    const prog = effectiveProgram(source);
    const complete = argvComplete(source);
    const categories: BashCategory[] = [mapBashCategory(info.category, argv)];
    const verdict = classifyActionDanger(argv, complete);
    const action: BashAction = {
      ordinal: i + 1,
      source,
      argv,
      argvComplete: complete,
      program: prog ?? info.tool,
      categories,
      danger: verdict.danger,
    };
    if (verdict.destructiveOperation) action.destructiveOperation = verdict.destructiveOperation;
    actions.push(action);
  });
  return actions;
}

// ---------------------------------------------------------------------------
// Per-tool mappers
// ---------------------------------------------------------------------------

interface MapCtx {
  redact: boolean;
  knownSecrets: readonly string[] | undefined;
}

function bashExecution(
  step: StepDraft['step'],
  useEvent: SessionEvent,
  resultEvent: SessionEvent | undefined,
  ctx: MapCtx,
): BashExecution {
  const rawCommand = useEvent.command ?? stringArg(useEvent.args, 'command', 'cmd', 'script') ?? '';
  const unwrapped = unwrapShellExec(rawCommand);
  const command = ctx.redact ? redactSecrets(rawCommand, ctx.knownSecrets) : rawCommand;
  const unwrappedCommand = ctx.redact ? redactSecrets(unwrapped, ctx.knownSecrets) : unwrapped;
  const { diagnostics } = extractShellPrograms(unwrapped);
  const actions = buildBashActions(unwrapped);
  // parseStatus: `parsed` when we tokenized ≥1 segment and the parser had no
  // diagnostics; `partial` when we got segments but the parser flagged something;
  // `unparseable` when we recovered no segments at all from a non-empty command.
  let parseStatus: BashExecution['parseStatus'];
  if (actions.length === 0) parseStatus = rawCommand.trim().length === 0 ? 'parsed' : 'unparseable';
  else if (diagnostics.length > 0) parseStatus = 'partial';
  else parseStatus = 'parsed';
  return {
    ...executionBase(step, 'execution'),
    executionType: 'bash',
    tool: step.tool ?? 'Bash',
    result: resultOf(resultEvent, ctx.redact, ctx.knownSecrets),
    command,
    unwrappedCommand,
    parseStatus,
    parseDiagnostics: diagnostics,
    actions,
  };
}

function readExecution(
  step: StepDraft['step'],
  useEvent: SessionEvent,
  resultEvent: SessionEvent | undefined,
  ctx: MapCtx,
): ReadExecution {
  const file = stringArg(useEvent.args, 'file_path', 'path', 'notebook_path', 'filePath') ?? useEvent.path ?? '';
  const exec: ReadExecution = {
    ...executionBase(step, 'execution'),
    executionType: 'read',
    tool: step.tool ?? 'Read',
    result: resultOf(resultEvent, ctx.redact, ctx.knownSecrets),
    file: ctx.redact ? redactSecrets(file, ctx.knownSecrets) : file,
  };
  const offset = numberArg(useEvent.args, 'offset');
  const limit = numberArg(useEvent.args, 'limit');
  if (offset !== undefined) exec.offset = offset;
  if (limit !== undefined) exec.limit = limit;
  const returnedLines = countLines(resultEvent);
  if (returnedLines) exec.returnedLines = returnedLines;
  return exec;
}

function grepExecution(
  step: StepDraft['step'],
  useEvent: SessionEvent,
  resultEvent: SessionEvent | undefined,
  ctx: MapCtx,
): GrepExecution {
  const query = stringArg(useEvent.args, 'pattern', 'query', 'q') ?? '';
  const grepPath = stringArg(useEvent.args, 'path');
  const glob = stringArg(useEvent.args, 'glob');
  const outputModeRaw = stringArg(useEvent.args, 'output_mode');
  const outputMode: GrepExecution['outputMode'] =
    outputModeRaw === 'content' || outputModeRaw === 'files' || outputModeRaw === 'count'
      ? (outputModeRaw === 'files' ? 'files' : outputModeRaw)
      : outputModeRaw
        ? 'unknown'
        : undefined;
  const exec: GrepExecution = {
    ...executionBase(step, 'execution'),
    executionType: 'grep',
    tool: step.tool ?? 'Grep',
    result: resultOf(resultEvent, ctx.redact, ctx.knownSecrets),
    query: ctx.redact ? redactSecrets(query, ctx.knownSecrets) : query,
  };
  if (grepPath) exec.path = ctx.redact ? redactSecrets(grepPath, ctx.knownSecrets) : grepPath;
  if (glob) exec.glob = glob;
  if (outputMode) exec.outputMode = outputMode;
  const hits = countLines(resultEvent);
  if (hits) exec.hits = hits;
  return exec;
}

/**
 * Build a FileMutation from an Edit (`old_string`/`new_string`) or Write
 * (`content`). The single hunk's added/removed line counts come from the string
 * diff; beforeHash/afterHash are content fingerprints so the cross-step revert
 * ledger can match a later edit that restores an earlier one.
 */
function fileMutationFromEdit(useEvent: SessionEvent): FileMutation | null {
  const path = stringArg(useEvent.args, 'file_path', 'path', 'filePath') ?? useEvent.path;
  if (!path) return null;
  const oldStr = stringArg(useEvent.args, 'old_string', 'old_str');
  const newStr = stringArg(useEvent.args, 'new_string', 'new_str');
  if (oldStr === undefined && newStr === undefined) {
    // No diff strings — record the mutation with an empty hunk list rather than
    // fabricate line counts.
    return { path, operation: 'update', hunks: [] };
  }
  const before = oldStr ?? '';
  const after = newStr ?? '';
  const removedLines = countStringLines(before);
  const addedLines = countStringLines(after);
  const hunk: FileHunk = {
    id: 'h1',
    addedLines,
    removedLines,
    beforeHash: shortHash(before),
    afterHash: shortHash(after),
  };
  return { path, operation: 'update', hunks: [hunk] };
}

function fileMutationFromWrite(useEvent: SessionEvent): FileMutation | null {
  const path = stringArg(useEvent.args, 'file_path', 'path', 'filePath') ?? useEvent.path;
  if (!path) return null;
  const content = stringArg(useEvent.args, 'content', 'contents');
  if (content === undefined) {
    return { path, operation: 'overwrite', hunks: [] };
  }
  const addedLines = countStringLines(content);
  const hunk: FileHunk = {
    id: 'h1',
    addedLines,
    removedLines: 0,
    afterHash: shortHash(content),
  };
  // A Write with no prior-content evidence: `overwrite` when the file may have
  // existed. We cannot tell create vs overwrite from the event, so `overwrite`
  // (the conservative "may have clobbered") — never invent `create`.
  return { path, operation: 'overwrite', hunks: [hunk] };
}

function countStringLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split('\n');
  return lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

function editExecution(
  step: StepDraft['step'],
  useEvent: SessionEvent,
  resultEvent: SessionEvent | undefined,
  ctx: MapCtx,
): EditExecution {
  const mutation = fileMutationFromEdit(useEvent);
  const files = mutation ? [redactMutationPath(mutation, ctx)] : [];
  return {
    ...executionBase(step, 'execution'),
    executionType: 'edit',
    tool: step.tool ?? 'Edit',
    result: resultOf(resultEvent, ctx.redact, ctx.knownSecrets),
    files,
    // reverts[] is populated in a cross-step pass over all mutations (see below).
    reverts: [],
  };
}

function writeExecution(
  step: StepDraft['step'],
  useEvent: SessionEvent,
  resultEvent: SessionEvent | undefined,
  ctx: MapCtx,
): WriteExecution {
  const mutation = fileMutationFromWrite(useEvent);
  const files = mutation ? [redactMutationPath(mutation, ctx)] : [];
  return {
    ...executionBase(step, 'execution'),
    executionType: 'write',
    tool: step.tool ?? 'Write',
    result: resultOf(resultEvent, ctx.redact, ctx.knownSecrets),
    files,
    reverts: [],
  };
}

function redactMutationPath(m: FileMutation, ctx: MapCtx): FileMutation {
  if (!ctx.redact) return m;
  return { ...m, path: redactSecrets(m.path, ctx.knownSecrets) };
}

function genericExecution(
  step: StepDraft['step'],
  useEvent: SessionEvent,
  resultEvent: SessionEvent | undefined,
  ctx: MapCtx,
): GenericToolExecution {
  const inputText = stringArg(
    useEvent.args,
    'command', 'cmd', 'file_path', 'path', 'query', 'pattern', 'url', 'description', 'prompt',
  ) ?? (useEvent.args ? JSON.stringify(useEvent.args).slice(0, PREVIEW_MAX) : undefined);
  const exec: GenericToolExecution = {
    ...executionBase(step, 'execution'),
    executionType: 'generic',
    tool: step.tool ?? 'unknown',
    result: resultOf(resultEvent, ctx.redact, ctx.knownSecrets),
  };
  const input = textPreview(inputText, ctx.redact, ctx.knownSecrets);
  if (input) exec.input = input;
  return exec;
}

/**
 * A hook firing → HookExecution. parse.ts emits `type: 'hook'` with `hookName`,
 * `hookEvent`, and `success` (boolean). It does NOT preserve the raw
 * blocked-vs-error distinction (both land as `success: false`), so `decision` is
 * conservative: `allowed` on success, else `unknown` — never a confident `blocked`
 * we cannot prove. `phase` is derived from the lifecycle event name.
 *
 * Hooks are NOT tool_use events, so `pairSteps` never draws them; the build draws
 * them separately from the raw event stream and merges by startMs (see below).
 *
 * TODO(PHNX-3442): (1) if parse.ts is extended to preserve the raw `hook_blocked`
 * vs `hook_error` attachment type, map those to `blocked`/`error` here instead of
 * the conservative `unknown`. (2) parse.ts emits NO permission events today (its
 * `permission-mode` lines are skipped, parse.ts:569), so `PermissionExecution` is
 * never produced — wire it once permission events are parsed.
 */
function hookExecution(event: SessionEvent, ordinal: number, startMs: number): HookExecution {
  const hookEvent = event.hookEvent;
  const phase: HookExecution['phase'] =
    hookEvent === undefined
      ? 'other'
      : /^Pre/i.test(hookEvent)
        ? 'pre'
        : /^Post/i.test(hookEvent)
          ? 'post'
          : /Session/i.test(hookEvent)
            ? 'session'
            : 'other';
  const decision: HookExecution['decision'] = event.success === true ? 'allowed' : 'unknown';
  const exec: HookExecution = {
    kind: 'execution',
    lane: 'hook',
    ordinal,
    startMs,
    durationMs: 0,
    durationEstimated: true,
    outcome: event.success === true ? 'ok' : 'unknown',
    label: event.hookName ?? 'hook',
    executionType: 'hook',
    phase,
    decision,
    result: {},
  };
  if (event.hookName) exec.hookName = event.hookName;
  if (hookEvent) exec.hookEvent = hookEvent;
  return exec;
}

/** Shared base fields for any execution step, mapped from the drawn trajectory step. */
function executionBase(step: StepDraft['step'], kind: 'execution') {
  const base = {
    kind,
    ordinal: step.ordinal,
    startMs: step.startMs,
    durationMs: step.durationMs,
    durationEstimated: step.durationEstimated,
    outcome: stepOutcome(step),
    label: step.label,
    lane: step.lane,
  } as const;
  const withCall = step.callId ? { ...base, callId: step.callId } : base;
  return withCall;
}

function thinkingStep(step: StepDraft['step']): ThinkingStep {
  const outcome = step.outcome === 'error' ? 'unknown' : (step.outcome === 'ok' ? 'ok' : 'unknown');
  return {
    kind: 'thinking',
    lane: 'think',
    ordinal: step.ordinal,
    startMs: step.startMs,
    durationMs: step.durationMs,
    durationEstimated: step.durationEstimated,
    outcome,
    label: step.label,
  };
}

// ---------------------------------------------------------------------------
// Cross-step revert ledger
// ---------------------------------------------------------------------------

/**
 * Detect when a later edit/write REVERTS an earlier one on the same path+hunk, by
 * content fingerprint: a hunk B reverts hunk A when they touch the same path and
 * B's afterHash equals A's beforeHash AND B's beforeHash equals A's afterHash — i.e.
 * B put the content back exactly the way A found it. Stamps `revertedByStep` on the
 * reverted hunk + mutation, and appends a RevertLink to the reverting step's
 * `reverts[]`.
 *
 * Conservative: only an EXACT hash round-trip counts. A partial/overlapping change
 * is left un-linked (empty reverts[]) rather than guessed — the spec's "do not fake
 * reverts" bar. This walks the already-built mutation steps in order; a mutation
 * with an empty hunk list (no diff strings were available) never participates.
 */
function applyRevertLedger(steps: SessionStepV2[]): void {
  interface HunkRef {
    step: EditExecution | WriteExecution;
    ordinal: number;
    path: string;
    hunk: FileHunk;
  }
  // Earlier hunks, most-recent-first per (path), so a revert matches the latest
  // un-reverted change to that path.
  const earlier: HunkRef[] = [];
  for (const step of steps) {
    if (step.kind !== 'execution') continue;
    if (step.executionType !== 'edit' && step.executionType !== 'write') continue;
    const mut = step as EditExecution | WriteExecution;
    for (const file of mut.files) {
      for (const hunk of file.hunks) {
        // Does this hunk revert any earlier un-reverted hunk on the same path?
        if (hunk.beforeHash && hunk.afterHash) {
          const match = earlier.find(
            (e) =>
              e.path === file.path &&
              e.hunk.revertedByStep === undefined &&
              e.hunk.afterHash !== undefined &&
              e.hunk.beforeHash !== undefined &&
              e.hunk.afterHash === hunk.beforeHash &&
              e.hunk.beforeHash === hunk.afterHash,
          );
          if (match) {
            match.hunk.revertedByStep = mut.ordinal;
            // Stamp the mutation too when all its hunks are now reverted.
            const parentFile = match.step.files.find((f) => f.path === match.path);
            if (parentFile && parentFile.hunks.every((h) => h.revertedByStep !== undefined)) {
              parentFile.revertedByStep = mut.ordinal;
            }
            mut.reverts.push({
              revertedStep: match.ordinal,
              path: file.path,
              revertedHunkIds: [match.hunk.id],
            });
          }
        }
        earlier.push({ step: mut, ordinal: mut.ordinal, path: file.path, hunk });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// buildSessionDetailV2
// ---------------------------------------------------------------------------

const TOOL_KINDS = {
  bash: new Set(['bash', 'exec', 'execute', 'exec_command', 'run_command', 'run_shell_command', 'shell']),
  read: new Set(['read', 'view', 'cat_file']),
  grep: new Set(['grep', 'search', 'codebase_search', 'grep_search']),
  edit: new Set(['edit', 'multiedit', 'str_replace', 'apply_patch', 'replace_file_content']),
  write: new Set(['write', 'create_file', 'write_file']),
};

function toolExecutionKind(tool: string): keyof typeof TOOL_KINDS | 'generic' {
  const t = tool.toLowerCase();
  for (const [kind, names] of Object.entries(TOOL_KINDS)) {
    if (names.has(t)) return kind as keyof typeof TOOL_KINDS;
  }
  return 'generic';
}

interface BuildDetailV2Options {
  redact?: boolean;
  knownSecrets?: readonly string[];
}

/**
 * Build the schema-2 per-session detail from a pre-built trajectory and its raw
 * events. The trajectory supplies meta/gaps/whereItWentWrong/surfacedToolFailures
 * (via the shared sync.ts helpers) and the truncation count; the raw events supply
 * the per-tool detail the schema-1 flat step could not carry.
 *
 * Re-pairs the events with `pairSteps` (the SAME loop buildTrajectory ran) to
 * recover each step's (use event, result event) triple, then dispatches per tool.
 */
export function buildSessionDetailV2(
  traj: SessionTrajectory,
  events: SessionEvent[],
  options: BuildDetailV2Options = {},
): SessionDetailV2 {
  const redact = options.redact !== false;
  const knownSecrets = options.knownSecrets;
  const ctx: MapCtx = { redact, knownSecrets };

  const stats = computeSummaryStats(events);
  const firstTs = stats.firstTs;
  const eventMs = eventTimestampsMs(events);
  const drafts = pairSteps(events, eventMs, firstTs, redact, knownSecrets);

  // Apply the SAME cap the trajectory used, so the two step lists line up and the
  // truncation count is honest. `traj.steps` is already capped + ordinal-numbered.
  const cappedDrafts = drafts.slice(0, traj.steps.length);

  const steps: SessionStepV2[] = [];
  for (let i = 0; i < cappedDrafts.length; i++) {
    const draft = cappedDrafts[i];
    // The trajectory step is the AUTHORITATIVE one: buildTrajectory resolved its
    // outcome, duration, durationEstimated, and exitCode after pairing. The fresh
    // draft from this re-pair only supplies the event indices (use/result); its
    // own `step` still carries the pre-resolution placeholders. So read base fields
    // from `traj.steps[i]` and use the draft solely for the event triple.
    const step = traj.steps[i];
    // Guard the positional pairing. buildTrajectory and this builder both derive
    // their drafts from the SAME events via the SAME deterministic `pairSteps`, so
    // draft[i] must describe the same step as traj.steps[i]. If a future change
    // makes the two call sites diverge (e.g. one filters events, the other does
    // not), fail loud here rather than silently emit a shard whose danger flags,
    // timestamps, and paths belong to the wrong step.
    if (draft.step.kind !== step.kind || draft.step.callId !== step.callId) {
      throw new Error(
        `schema-2 step/draft misalignment at ordinal ${step.ordinal}: ` +
          `draft(kind=${draft.step.kind},callId=${draft.step.callId ?? '∅'}) vs ` +
          `step(kind=${step.kind},callId=${step.callId ?? '∅'})`
      );
    }
    if (step.kind === 'thinking') {
      steps.push(thinkingStep(step));
      continue;
    }
    const useEvent = events[draft.eventIndex];
    const resultEvent = draft.resultEventIndex !== undefined ? events[draft.resultEventIndex] : undefined;

    const tool = step.tool ?? 'unknown';
    const kind = toolExecutionKind(tool);
    switch (kind) {
      case 'bash':
        steps.push(bashExecution(step, useEvent, resultEvent, ctx));
        break;
      case 'read':
        steps.push(readExecution(step, useEvent, resultEvent, ctx));
        break;
      case 'grep':
        steps.push(grepExecution(step, useEvent, resultEvent, ctx));
        break;
      case 'edit':
        steps.push(editExecution(step, useEvent, resultEvent, ctx));
        break;
      case 'write':
        steps.push(writeExecution(step, useEvent, resultEvent, ctx));
        break;
      default:
        steps.push(genericExecution(step, useEvent, resultEvent, ctx));
        break;
    }
  }

  // Draw hook firings (parse.ts `type:'hook'`) as first-class HookExecution steps.
  // They are not tool_use events, so pairSteps never drew them; merge them into the
  // step stream by startMs and re-number ordinals so the ordering stays truthful.
  // A session with no hook events leaves `steps` and its ordinals untouched.
  const hookSteps: HookExecution[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type !== 'hook') continue;
    const startMs = Number.isNaN(eventMs[i]) ? 0 : Math.max(0, eventMs[i] - firstTs);
    hookSteps.push(hookExecution(e, 0, startMs));
  }
  let merged = steps;
  if (hookSteps.length > 0) {
    merged = [...steps, ...hookSteps].sort((a, b) => a.startMs - b.startMs);
    merged.forEach((step, idx) => { step.ordinal = idx + 1; });
  }

  applyRevertLedger(merged);

  const s = traj.session as { id: string };
  return {
    schema: 2,
    id: s.id,
    meta: buildDetailMeta(traj),
    steps: merged,
    gaps: traj.gaps,
    truncatedSteps: traj.truncatedSteps,
    whereItWentWrong: buildWhereItWentWrong(traj),
    surfacedToolFailures: traj.steps
      .filter((step) => step.outcome === 'error')
      .map((step) => ({ tool: step.tool, label: step.label, detail: step.detail })),
  };
}

// re-export for callers/tests
export { activeMsFromTrajectory };
