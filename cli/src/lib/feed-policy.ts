import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { getUserAgentsDir } from './state.js';
import {
  deriveBlockState,
  recordAnswer,
  recordDefaulted,
  recordMessageReceipt,
  recordParked,
  type OpenBlock,
  type AnswerRecord,
} from './feed/feed.js';
import { enqueue, mailboxDir } from './mailbox.js';

type BlockClass = 'approval' | 'decision';

interface ClassPolicy {
  timeoutMinutes: number;
  safeDefault?: string;
}

interface FeedPolicy {
  approval: ClassPolicy;
  decision: ClassPolicy;
  phoneNotifyThreshold: 'low' | 'medium' | 'high';
}

const POLICY_FILE = 'feed-policy.yaml';
const COST_RANK: Record<'low' | 'medium' | 'high', number> = { low: 0, medium: 1, high: 2 };

export const DEFAULT_POLICY: FeedPolicy = {
  approval: { timeoutMinutes: 30, safeDefault: 'deny' },
  decision: { timeoutMinutes: 60 },
  phoneNotifyThreshold: 'medium',
};

function getPolicyPath(root?: string): string {
  return path.join(root ?? getUserAgentsDir(), POLICY_FILE);
}

function normalizeClassPolicy(raw: unknown, fallback: ClassPolicy): ClassPolicy {
  const p = (raw ?? {}) as Partial<ClassPolicy>;
  const timeout = typeof p.timeoutMinutes === 'number' ? p.timeoutMinutes : fallback.timeoutMinutes;
  return {
    timeoutMinutes: Math.max(1, Math.round(timeout)),
    safeDefault: typeof p.safeDefault === 'string' ? p.safeDefault : fallback.safeDefault,
  };
}

export function loadPolicy(root?: string): FeedPolicy {
  const file = getPolicyPath(root);
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = yaml.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      const p = parsed as Partial<FeedPolicy>;
      const threshold = p.phoneNotifyThreshold;
      return {
        approval: normalizeClassPolicy(p.approval, DEFAULT_POLICY.approval),
        decision: normalizeClassPolicy(p.decision, DEFAULT_POLICY.decision),
        phoneNotifyThreshold: threshold === 'low' || threshold === 'medium' || threshold === 'high' ? threshold : DEFAULT_POLICY.phoneNotifyThreshold,
      };
    }
  } catch {
  }
  return DEFAULT_POLICY;
}

export function blockClass(block: OpenBlock): BlockClass {
  return block.blockClass === 'decision' ? 'decision' : 'approval';
}

export function isPhoneUrgent(block: OpenBlock, policy: FeedPolicy): boolean {
  // State, not answer presence, decides openness: an unconfirmed claimed answer remains eligible for escalation.
  if (deriveBlockState(block) !== 'open') return false;
  const cost = block.costOfDelay ?? 'low';
  return COST_RANK[cost] >= COST_RANK[policy.phoneNotifyThreshold];
}

function minutesElapsed(block: OpenBlock, now: Date): number {
  const ts = Date.parse(block.ts);
  if (Number.isNaN(ts)) return 0;
  return (now.getTime() - ts) / 60_000;
}

function timeoutMinutesForBlock(block: OpenBlock, policy: FeedPolicy): number {
  if (typeof block.timeoutMinutes === 'number' && Number.isFinite(block.timeoutMinutes) && block.timeoutMinutes > 0) {
    return Math.max(1, Math.round(block.timeoutMinutes));
  }
  return policy[blockClass(block)].timeoutMinutes;
}

export function isTimedOut(block: OpenBlock, policy: FeedPolicy, now: Date): boolean {
  const minutes = minutesElapsed(block, now);
  return minutes >= timeoutMinutesForBlock(block, policy);
}

interface PolicyResult {
  blockId: string;
  action: 'none' | 'defaulted' | 'parked';
  answer?: AnswerRecord;
}

export function applyPolicyToBlock(
  block: OpenBlock,
  policy: FeedPolicy,
  now: Date,
  root?: string,
  mailboxRoot?: string,
): PolicyResult {
  // Approvals may default; decisions hard-park rather than inventing an answer.
  if (deriveBlockState(block) !== 'open' || block.parkedAt || block.defaultedAt) {
    return { blockId: block.blockId, action: 'none' };
  }

  if (!isTimedOut(block, policy, now)) {
    return { blockId: block.blockId, action: 'none' };
  }

  const cls = blockClass(block);
  if (cls === 'approval') {
    const safeDefault = block.safeDefault ?? policy.approval.safeDefault;
    if (!safeDefault) {
      return { blockId: block.blockId, action: 'none' };
    }

    const claim = recordAnswer(
      block.blockId,
      { answeredFrom: 'policy', answeredBy: 'default-on-no-answer', operatorId: 'policy', verified: true },
      root,
    );
    if (!claim.ok) {
      return { blockId: block.blockId, action: 'none' };
    }

    const msgId = enqueue(mailboxDir(block.mailboxId, mailboxRoot), {
      to: block.mailboxId,
      text: safeDefault,
      from: 'policy',
      blockId: block.blockId,
    });
    recordMessageReceipt(
      block.blockId,
      { msgId, status: 'queued', at: now.toISOString(), from: 'policy' },
      root,
    );
    recordDefaulted(block.blockId, root);

    return {
      blockId: block.blockId,
      action: 'defaulted',
      answer: {
        answeredAt: now.toISOString(),
        answeredFrom: 'policy',
        answeredBy: 'default-on-no-answer',
        operatorId: 'policy',
        verified: true,
      },
    };
  }

  recordParked(block.blockId, root);
  return {
    blockId: block.blockId,
    action: 'parked',
    answer: {
      answeredAt: now.toISOString(),
      answeredFrom: 'policy',
      answeredBy: 'hard-park',
      operatorId: 'policy',
      verified: true,
    },
  };
}
