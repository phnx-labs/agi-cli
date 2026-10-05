import { describe, it, expect } from 'vitest';
import { AgentStatus } from './agents.js';
import {
  resolveTeammateDelivery,
  deliveryDisplayLabel,
  deliveryColorKey,
} from './delivery.js';

describe('resolveTeammateDelivery (RUSH-2380)', () => {
  it('completed with no PR is no_pr (process done, nothing to merge)', () => {
    expect(
      resolveTeammateDelivery({ status: AgentStatus.COMPLETED, prUrl: null }),
    ).toBe('no_pr');
    expect(
      resolveTeammateDelivery({ status: 'completed', prUrl: undefined }),
    ).toBe('no_pr');
  });

  it('completed with a PR URL and unknown merge is pr_open (pessimistic)', () => {
    expect(
      resolveTeammateDelivery({
        status: AgentStatus.COMPLETED,
        prUrl: 'https://github.com/phnx-labs/agents-cli/pull/2317',
      }),
    ).toBe('pr_open');
    expect(
      resolveTeammateDelivery({
        status: AgentStatus.COMPLETED,
        prUrl: 'https://github.com/phnx-labs/agents-cli/pull/2317',
        prMerged: null,
      }),
    ).toBe('pr_open');
  });

  it('completed with prMerged=false is pr_open', () => {
    expect(
      resolveTeammateDelivery({
        status: AgentStatus.COMPLETED,
        prUrl: 'https://github.com/x/y/pull/1',
        prMerged: false,
      }),
    ).toBe('pr_open');
  });

  it('completed with prMerged=true is pr_merged', () => {
    expect(
      resolveTeammateDelivery({
        status: AgentStatus.COMPLETED,
        prUrl: 'https://github.com/x/y/pull/1',
        prMerged: true,
      }),
    ).toBe('pr_merged');
  });

  it('whitespace-only prUrl counts as no PR', () => {
    expect(
      resolveTeammateDelivery({ status: AgentStatus.COMPLETED, prUrl: '   ' }),
    ).toBe('no_pr');
  });

  it('running / pending / failed / stopped map directly', () => {
    expect(resolveTeammateDelivery({ status: AgentStatus.RUNNING })).toBe('in_progress');
    expect(resolveTeammateDelivery({ status: AgentStatus.PENDING })).toBe('pending');
    expect(resolveTeammateDelivery({ status: AgentStatus.FAILED, prUrl: 'https://x/y/pull/1' })).toBe(
      'failed',
    );
    expect(resolveTeammateDelivery({ status: AgentStatus.STOPPED })).toBe('stopped');
  });

  it('a running teammate with a PR URL is still in_progress (not PR OPEN yet)', () => {
    expect(
      resolveTeammateDelivery({
        status: AgentStatus.RUNNING,
        prUrl: 'https://github.com/x/y/pull/9',
      }),
    ).toBe('in_progress');
  });

  it('completed with no PR and uncommitted changes is stranded (PHNX-2951)', () => {
    expect(
      resolveTeammateDelivery({
        status: AgentStatus.COMPLETED,
        prUrl: null,
        hasUncommittedChanges: true,
      }),
    ).toBe('stranded');
  });

  it('completed with no PR and a clean worktree stays no_pr', () => {
    expect(
      resolveTeammateDelivery({
        status: AgentStatus.COMPLETED,
        prUrl: null,
        hasUncommittedChanges: false,
      }),
    ).toBe('no_pr');
  });

  it('completed with a PR URL ignores worktree state', () => {
    expect(
      resolveTeammateDelivery({
        status: AgentStatus.COMPLETED,
        prUrl: 'https://github.com/x/y/pull/9',
        hasUncommittedChanges: true,
      }),
    ).toBe('pr_open');
  });
});

describe('deliveryDisplayLabel', () => {
  it('surfaces PR OPEN instead of COMPLETED when delivery is pr_open', () => {
    expect(deliveryDisplayLabel('pr_open', AgentStatus.COMPLETED)).toBe('PR OPEN');
    expect(deliveryDisplayLabel('pr_merged', AgentStatus.COMPLETED)).toBe('COMPLETED');
    expect(deliveryDisplayLabel('no_pr', AgentStatus.COMPLETED)).toBe('COMPLETED');
    expect(deliveryDisplayLabel('failed', AgentStatus.FAILED)).toBe('FAILED');
    expect(deliveryDisplayLabel('in_progress', AgentStatus.RUNNING)).toBe('RUNNING');
  });

  it('surfaces STRANDED for completed teammates with uncommitted work (PHNX-2951)', () => {
    expect(deliveryDisplayLabel('stranded', AgentStatus.COMPLETED)).toBe('STRANDED');
  });
});

describe('deliveryColorKey', () => {
  it('uses pr_open key so the row is not green COMPLETED', () => {
    expect(deliveryColorKey('pr_open', 'completed')).toBe('pr_open');
    expect(deliveryColorKey('no_pr', 'completed')).toBe('completed');
  });

  it('uses stranded key so the row is not green COMPLETED (PHNX-2951)', () => {
    expect(deliveryColorKey('stranded', 'completed')).toBe('stranded');
  });
});
