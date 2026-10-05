
import { AgentStatus } from './agents.js';

export type TeammateDelivery =
  | 'pending'
  | 'in_progress'
  | 'pr_open'
  | 'pr_merged'
  | 'no_pr'
  | 'stranded'
  | 'failed'
  | 'stopped';

export function resolveTeammateDelivery(opts: {
  status: AgentStatus | string;
  prUrl?: string | null;
  prMerged?: boolean | null;
  hasUncommittedChanges?: boolean | null;
}): TeammateDelivery {
  const status = String(opts.status);
  if (status === AgentStatus.PENDING || status === 'pending') return 'pending';
  if (status === AgentStatus.RUNNING || status === 'running') return 'in_progress';
  if (status === AgentStatus.FAILED || status === 'failed') return 'failed';
  if (status === AgentStatus.STOPPED || status === 'stopped') return 'stopped';

  if (status === AgentStatus.COMPLETED || status === 'completed') {
    const prUrl = opts.prUrl?.trim();
    if (!prUrl) {
      return opts.hasUncommittedChanges ? 'stranded' : 'no_pr';
    }
    if (opts.prMerged === true) return 'pr_merged';
    return 'pr_open';
  }

  return 'in_progress';
}

export function deliveryDisplayLabel(
  delivery: TeammateDelivery,
  processStatus: AgentStatus | string,
): string {
  if (delivery === 'pr_open') return 'PR OPEN';
  if (delivery === 'pr_merged') return 'COMPLETED';
  if (delivery === 'stranded') return 'STRANDED';
  return String(processStatus).toUpperCase();
}

export function deliveryColorKey(delivery: TeammateDelivery, processStatus: string): string {
  if (delivery === 'pr_open') return 'pr_open';
  if (delivery === 'stranded') return 'stranded';
  return String(processStatus);
}
