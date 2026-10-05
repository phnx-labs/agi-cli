
import type { JobTrigger } from '../scheduling/routines.js';

export type CloudProviderId = 'rush' | 'codex' | 'factory' | 'antigravity' | 'cursor' | 'host';

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
  repo?: string;
  repos?: string[];
  branch?: string;
  prUrl?: string;
  createdAt: string;
  updatedAt: string;
  summary?: string;
}

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
  trigger?: JobTrigger;
  repo?: string;
  repos?: string[];
  branch?: string;
  timeout?: string;
  model?: string;
  skills?: SkillRef[];
  images?: ImageAttachment[];
  providerOptions?: Record<string, unknown>;
  env?: Record<string, string>;
}

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

export interface CloudTarget {
  id: string;
  label?: string;
  kind: TargetKind;
}

export type TargetKind = 'env' | 'computer' | 'host';

export class MissingTargetError extends Error {
  constructor(public kind: TargetKind, message: string, public guidance?: string) {
    super(message);
    this.name = 'MissingTargetError';
  }
}

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

  targetKind?: TargetKind;

  listTargets?(): Promise<CloudTarget[]>;
}

export type DroidAutonomy = 'low' | 'medium' | 'high';

export interface CloudProviderConfig {
  rush?: Record<string, string>;
  codex?: { env?: string };
  factory?: { computer?: string; autonomy?: DroidAutonomy };
  antigravity?: { secretsBundle?: string; model?: string };
  cursor?: { secretsBundle?: string };
}

export interface CloudConfig {
  default_provider?: CloudProviderId;
  providers?: CloudProviderConfig;
}
