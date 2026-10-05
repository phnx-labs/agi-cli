/** Cloud dispatch types: the provider-agnostic interface every backend (Rush, Codex, Factory)
 * implements, plus shared task and event types. */

import type { JobTrigger } from '../scheduling/routines.js';

/** Identifier for a cloud backend: each is an agent's own cloud (rush, codex, factory, antigravity,
 * cursor) or `host` (your machine over SSH). Agents route to their native cloud via
 * `cloudProvider`; `--provider` overrides. `host` is only ever explicit. */
export type CloudProviderId = 'rush' | 'codex' | 'factory' | 'antigravity' | 'cursor' | 'host';

/** Lifecycle state of a cloud task. `idle` is a long-lived session stopped between turns and
 * resumable via `message()`, unlike terminal `completed | failed | cancelled`. */
export type CloudTaskStatus =
  | 'queued'
  | 'allocating'
  | 'running'
  | 'idle'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'cancelled';

type StatusNormalizingProvider = 'rush' | 'codex' | 'antigravity' | 'cursor';

/** Normalize a provider's raw status into `CloudTaskStatus`, per provider with explicit defaults:
 * rush switches over known Factory Floor strings (default `running`); codex substring-matches
 * (default `running`); antigravity defaults to `completed`. */
export function normalizeProviderStatus(
  provider: StatusNormalizingProvider,
  wireStatus: string | undefined,
): CloudTaskStatus {
  switch (provider) {
    case 'rush':
      return normalizeRushStatus(wireStatus ?? '');
    case 'codex':
      return normalizeCodexStatus(wireStatus ?? '');
    case 'antigravity':
      return normalizeAntigravityStatus(wireStatus);
    case 'cursor':
      return normalizeCursorStatus(wireStatus ?? '');
  }
}

function normalizeCursorStatus(s: string): CloudTaskStatus {
  switch (s.toUpperCase()) {
    case 'CREATING': return 'queued';
    case 'RUNNING': return 'running';
    case 'FINISHED': return 'completed';
    case 'ERROR':
    case 'EXPIRED': return 'failed';
    case 'CANCELLED': return 'cancelled';
    default: return 'running';
  }
}

function normalizeRushStatus(s: string): CloudTaskStatus {
  switch (s) {
    case 'allocating': return 'allocating';
    case 'running': return 'running';
    case 'idle':
    case 'paused':
    case 'needs_review': return 'idle';
    case 'input_required': return 'input_required';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return 'running';
  }
}

function normalizeCodexStatus(s: string): CloudTaskStatus {
  const lower = s.toLowerCase();
  if (lower.includes('queued') || lower.includes('pending')) return 'queued';
  if (lower.includes('running') || lower.includes('in_progress')) return 'running';
  if (lower.includes('idle') || lower.includes('paused') || lower.includes('needs_review')) return 'idle';
  if (lower.includes('completed') || lower.includes('succeeded') || lower.includes('success')) return 'completed';
  if (lower.includes('failed') || lower.includes('error')) return 'failed';
  if (lower.includes('cancelled') || lower.includes('canceled')) return 'cancelled';
  return 'running';
}

/** Antigravity Interactions API status to canonical enum: substring match, undefined-safe, default
 * `completed` because the synchronous response is terminal. */
function normalizeAntigravityStatus(s: string | undefined): CloudTaskStatus {
  const lower = (s ?? '').toLowerCase();
  if (lower.includes('queue') || lower.includes('pending')) return 'queued';
  if (lower.includes('run') || lower.includes('progress')) return 'running';
  if (lower.includes('idle') || lower.includes('paused') || lower.includes('needs_review')) return 'idle';
  if (lower.includes('complete') || lower.includes('success')) return 'completed';
  if (lower.includes('fail') || lower.includes('error')) return 'failed';
  if (lower.includes('cancel')) return 'cancelled';
  return 'completed';
}

export interface CloudTask {
  id: string;
  provider: CloudProviderId;
  status: CloudTaskStatus;
  agent?: string;
  prompt: string;
  /** First (or only) repo the task targets, kept for back-compat with one-task-one-repo callers;
   * see `repos` for multi-repo. */
  repo?: string;
  /** All repos the task targets, in dispatch order, for multi-repo dispatches. `repo` mirrors
   * `repos[0]` when both are set. */
  repos?: string[];
  branch?: string;
  prUrl?: string;
  createdAt: string;
  updatedAt: string;
  summary?: string;
}

/** Event emitted by a running cloud task: a discriminated union mirroring the local `SessionEvent`
 * taxonomy so the same UI renders both. The `unknown` variant surfaces unrecognized provider
 * events instead of dropping them. */
export type CloudEvent =
  | { type: 'text'; content: string; timestamp?: string }
  | { type: 'thinking'; content: string; timestamp?: string }
  | { type: 'tool_use'; tool: string; input: unknown; timestamp?: string }
  | { type: 'tool_result'; tool: string; output: unknown; timestamp?: string }
  | { type: 'status'; status: CloudTaskStatus; timestamp?: string }
  | { type: 'usage'; model?: string; inputTokens?: number; outputTokens?: number; timestamp?: string }
  | { type: 'done'; status?: CloudTaskStatus; prUrl?: string; summary?: string; timestamp?: string }
  | { type: 'error'; message: string; timestamp?: string }
  | { type: 'unknown'; name: string; data: string; timestamp?: string };

export interface SkillRef {
  id: string;
  version?: string;
}

export interface ImageAttachment {
  data: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}

export const MAX_IMAGES_PER_DISPATCH = 5;

export interface DispatchOptions {
  prompt: string;
  agent?: string;
  /** Event/webhook trigger from `agents cloud run --on <event>`: the dispatch is persisted as a
   * trigger-bound routine for the local webhook receiver. Remote firing is a follow-up; today it
   * parses, validates and persists. */
  trigger?: JobTrigger;
  /** Legacy single-repo target, still honored: if `repos` is empty this is the only repo. */
  repo?: string;
  /** One or more target repos (repeatable `--repo`). Rush clones each into
   * /workspace/<owner>/<name>/; Codex Cloud rejects multi-repo; Factory clones each into the
   * workspace first. */
  repos?: string[];
  branch?: string;
  timeout?: string;
  model?: string;
  /** Skills to ship with the dispatch, mounted in the pod before the agent runs. Providers without
   * support reject via `capabilities().skills === false`. */
  skills?: SkillRef[];
  /** Image attachments for vision dispatch, capped at MAX_IMAGES_PER_DISPATCH. */
  images?: ImageAttachment[];
  providerOptions?: Record<string, unknown>;
  env?: Record<string, string>;
}

/** Collapse `repo` + `repos` into one deduped list; the single source of truth for which repos a
 * dispatch targets. */
export function resolveDispatchRepos(options: DispatchOptions): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const candidates: string[] = [];
  if (options.repos) candidates.push(...options.repos);
  if (options.repo) candidates.push(options.repo);
  for (const raw of candidates) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** What a provider can actually do, so callers check flags and surface a typed error instead of
 * try/catch. Replaces the single-bool `supports()`. */
export interface ProviderCapabilities {
  available: boolean;
  dispatch: boolean;
  status: boolean;
  list: boolean;
  stream: boolean;
  cancel: boolean;
  message: boolean;
  multiRepo: boolean;
  skills: boolean;
  images: boolean;
}

/** A pre-provisioned target a provider runs inside (Codex `env_...` or a Factory Droid Computer
 * name), surfaced by `agents cloud envs` and the picker. */
export interface CloudTarget {
  id: string;
  label?: string;
  kind: TargetKind;
}

export type TargetKind = 'env' | 'computer' | 'host';

/** Thrown by `dispatch()` when a required pre-provisioned target (Codex env / Factory computer) is
 * missing. The CLI offers a picker via `listTargets`, or shows `guidance` when targets can't be
 * listed. */
export class MissingTargetError extends Error {
  constructor(public kind: TargetKind, message: string, public guidance?: string) {
    super(message);
    this.name = 'MissingTargetError';
  }
}

/** Contract every cloud backend implements, translating the unified dispatch interface to its own
 * API. `message()` may move a task from `idle` back to `running`. */
export interface CloudProvider {
  id: CloudProviderId;
  name: string;

  capabilities(): ProviderCapabilities;

  dispatch(options: DispatchOptions): Promise<CloudTask>;
  status(taskId: string): Promise<CloudTask>;
  list(filter?: { status?: CloudTaskStatus }): Promise<CloudTask[]>;

  stream(taskId: string): AsyncIterable<CloudEvent>;

  cancel(taskId: string): Promise<void>;

  message(taskId: string, content: string): Promise<void>;

  /** The pre-provisioned target this provider runs inside: Codex `env`, Factory `computer`;
   * undefined for Rush (per-repo) and Antigravity (on-demand). */
  targetKind?: TargetKind;

  /** Enumerate selectable targets for `agents cloud envs` and the picker, only where the backend
   * can list non-interactively (Factory). Codex omits it and uses `MissingTargetError.guidance`.
   * May throw. */
  listTargets?(): Promise<CloudTarget[]>;
}

export type DroidAutonomy = 'low' | 'medium' | 'high';

export interface CloudProviderConfig {
  rush?: Record<string, string>;
  codex?: { env?: string };
  /** Factory (Droid) cloud. `computer` is the pre-provisioned Droid Computer name (analogue of
   * Codex's `env`); `autonomy` is the default `droid exec --auto` level (default `high`). */
  factory?: { computer?: string; autonomy?: DroidAutonomy };
  /** Antigravity cloud. The Gemini key comes from the `agents secrets` bundle named here (never
   * agents.yaml), else GEMINI_API_KEY / GOOGLE_API_KEY. `model` overrides the default agent id. */
  antigravity?: { secretsBundle?: string; model?: string };
  cursor?: { secretsBundle?: string };
}

export interface CloudConfig {
  default_provider?: CloudProviderId;
  providers?: CloudProviderConfig;
}
