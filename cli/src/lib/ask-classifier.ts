/**
 * Ask classifier + stall suppression (RUSH-1477).
 *
 * ~39% of AskUserQuestion calls are workflow-stalls ("should I…?", "what's next?",
 * "merge now?"). The feed's first job is to make those disappear so real Decisions
 * and Approvals stay visible.
 *
 * Pipeline:
 *   1. Classify every block into Decision / Approval / Clarification / Stall / Fyi
 *   2. Suppress stalls (and pure FYIs) with an auto-answer so they never render
 *   3. Surface Decision + Approval (+ Clarification when it needs a real fact)
 *
 * Rules-based on stable high-volume shapes. Pure classify/match; suppression has
 * side effects via the feed store when applied.
 */
import type { OpenBlock } from './feed/feed.js';
import { recordAnswer, recordMessageReceipt, removeBlock } from './feed/feed.js';
import { enqueue, mailboxDir } from './mailbox.js';

/** Taxonomy for a published ask. Exactly one class per block. */
export type AskClass =
  | 'decision'      // irreducible judgment — scope, direction, taste
  | 'approval'      // yes/no with a safe default — release/merge/commit
  | 'clarification' // missing fact — "which repo?"
  | 'stall'         // agent should have continued itself — "should I…?", "what's next?"
  | 'fyi';          // notification / done — no action

export interface Classification {
  class: AskClass;
  /** Why this class was chosen (rule name). */
  rule: string;
  /** True when the feed should hide this block and auto-answer it. */
  suppress: boolean;
  /** Auto-answer text when suppress is true. */
  autoAnswer?: string;
}

// ---- rules (order matters: first match wins) --------------------------------

interface Rule {
  name: string;
  class: AskClass;
  suppress: boolean;
  autoAnswer?: string;
  /** Return true when the rule matches the scan text. */
  test: (text: string) => boolean;
}

const RULES: Rule[] = [
  // FYI / done — no action needed
  {
    name: 'fyi-done',
    class: 'fyi',
    suppress: true,
    autoAnswer: 'acknowledged',
    test: (t) =>
      /\b(fyi|for your information|just letting you know|heads.?up|no action needed|already done|completed successfully)\b/.test(t) ||
      /^(done|shipped|merged|complete)[.!]?$/.test(t.trim()),
  },
  // Stall: "should I / want me to / shall I continue"
  {
    name: 'stall-should-i',
    class: 'stall',
    suppress: true,
    autoAnswer: 'Yes, continue.',
    test: (t) =>
      /\b(should i|shall i|want me to|would you like me to|do you want me to|can i go ahead|ok to proceed|okay to continue)\b/.test(t),
  },
  // Stall: "what's next / continue?"
  {
    name: 'stall-whats-next',
    class: 'stall',
    suppress: true,
    autoAnswer: 'Continue with the next step.',
    test: (t) =>
      /\b(what('?s| is)? next|what now|continue\??|keep going\??|ready for the next|next step\??)\b/.test(t) ||
      /^continue\??$/.test(t.trim()),
  },
  // Stall: verify-then-proceed / looks good?
  {
    name: 'stall-verify-proceed',
    class: 'stall',
    suppress: true,
    autoAnswer: 'Looks good — proceed.',
    test: (t) =>
      /\b(looks good\??|does this look (ok|right|good)|sound good\??|ready to (go|ship|land)\??|any objections\??)\b/.test(t),
  },
  // Approval: merge/release/ship/commit yes-no (surfaces; policy can default later)
  {
    name: 'approval-merge-release',
    class: 'approval',
    suppress: false,
    test: (t) =>
      /\b(merge (now|this|the pr|it)\??|release\??|ship (it|now)\??|publish\??|cut (a )?release|tag (and )?release|commit (this|these changes)\??)\b/.test(t) ||
      /\b(approve|deny|allow|reject)\b.*\b(merge|release|deploy|pr)\b/.test(t),
  },
  // Clarification: which X / which repo / pick one fact
  {
    name: 'clarification-which',
    class: 'clarification',
    suppress: false,
    test: (t) =>
      /\b(which (repo|branch|host|file|path|environment|env|project|package|version|account|device|machine)|what is the (path|url|id|name) of)\b/.test(t) ||
      /\b(missing (the )?(path|url|id|name|repo)|need (the )?(path|url|id|repo) for)\b/.test(t),
  },
  // Decision: scope / approach / tradeoff (never auto-suppress)
  {
    name: 'decision-scope-approach',
    class: 'decision',
    suppress: false,
    test: (t) =>
      /\b(scope|approach|architecture|design|trade-?off|which approach|how should we|prefer A or B|option a or b)\b/.test(t) ||
      /\b(break(ing)? change|public api|migrate everyone|rewrite)\b/.test(t),
  },
];

/**
 * Classify one ask from free text (+ optional explicit blockClass from the agent).
 * Explicit blockClass from the agent is honored as a floor: 'decision' never becomes
 * a suppressible stall (false-suppress rate ~0 for real Decisions).
 */
export function classifyAsk(
  text: string,
  opts?: { header?: string; blockClass?: OpenBlock['blockClass'] },
): Classification {
  const scan = [opts?.header, text].filter(Boolean).join(' ').toLowerCase();

  for (const rule of RULES) {
    if (!rule.test(scan)) continue;
    // Safety: agent-tagged decisions never suppress.
    if (opts?.blockClass === 'decision' && rule.suppress) {
      return { class: 'decision', rule: 'agent-blockClass-decision', suppress: false };
    }
    return {
      class: rule.class,
      rule: rule.name,
      suppress: rule.suppress,
      autoAnswer: rule.autoAnswer,
    };
  }

  // Explicit agent tag with no text rule.
  if (opts?.blockClass === 'decision') {
    return { class: 'decision', rule: 'agent-blockClass-decision', suppress: false };
  }
  if (opts?.blockClass === 'approval') {
    return { class: 'approval', rule: 'agent-blockClass-approval', suppress: false };
  }

  // Default: surface as decision so we never silent-drop unknowns.
  return { class: 'decision', rule: 'default-decision', suppress: false };
}

/** Classify a full open block (all questions concatenated). */
export function classifyBlock(block: OpenBlock): Classification {
  const text = block.questions.map((q) => q.text).join(' ');
  const header = block.questions.map((q) => q.header).filter(Boolean).join(' ');
  return classifyAsk(text, { header, blockClass: block.blockClass });
}

interface SuppressResult {
  blockId: string;
  class: AskClass;
  rule: string;
  autoAnswer: string;
  /** True when the block was removed from the visible feed. */
  suppressed: boolean;
}

/**
 * Auto-answer + remove a suppressible block so it never renders as a card.
 * Logs the stall as answered by policy:stall-suppression.
 */
export function suppressStallBlock(block: OpenBlock, root?: string, mailboxRoot?: string): SuppressResult {
  const c = classifyBlock(block);
  if (!c.suppress || !c.autoAnswer) {
    return { blockId: block.blockId, class: c.class, rule: c.rule, autoAnswer: '', suppressed: false };
  }

  const claim = recordAnswer(
    block.blockId,
    {
      answeredFrom: 'policy',
      answeredBy: 'stall-suppression',
      operatorId: 'policy',
      verified: true,
    },
    root,
  );
  if (!claim.ok) {
    return { blockId: block.blockId, class: c.class, rule: c.rule, autoAnswer: c.autoAnswer, suppressed: false };
  }

  try {
    // Mailbox lives under the global mailbox root (not the feed dir).
    const msgId = enqueue(mailboxDir(block.mailboxId, mailboxRoot), {
      to: block.mailboxId,
      text: c.autoAnswer,
      from: 'stall-suppression',
      blockId: block.blockId,
    });
    recordMessageReceipt(
      block.blockId,
      { msgId, status: 'queued', at: new Date().toISOString(), from: 'stall-suppression' },
      root,
    );
  } catch {
    // Mailbox write can fail if the box id is invalid; still drop the card.
  }

  removeBlock(block.blockId, root);
  return {
    blockId: block.blockId,
    class: c.class,
    rule: c.rule,
    autoAnswer: c.autoAnswer,
    suppressed: true,
  };
}

interface FeedFilterResult {
  /** Blocks that should render as cards. */
  surfaced: OpenBlock[];
  /** Suppression audit rows (stalls auto-resolved). */
  suppressed: SuppressResult[];
  /** Per-class counts over the input set (before suppression). */
  counts: Record<AskClass, number>;
}

/**
 * Classify every block; optionally apply stall suppression (mutate store).
 * When `apply` is false, only classifies (dry run for --json audit).
 */
export function filterBlocksForFeed(
  blocks: OpenBlock[],
  opts?: { apply?: boolean; root?: string; mailboxRoot?: string },
): FeedFilterResult {
  const counts: Record<AskClass, number> = {
    decision: 0,
    approval: 0,
    clarification: 0,
    stall: 0,
    fyi: 0,
  };
  const surfaced: OpenBlock[] = [];
  const suppressed: SuppressResult[] = [];
  const apply = opts?.apply === true;

  for (const block of blocks) {
    const c = classifyBlock(block);
    counts[c.class] += 1;
    if (c.suppress) {
      if (apply) {
        const r = suppressStallBlock(block, opts?.root, opts?.mailboxRoot);
        suppressed.push(r);
        if (!r.suppressed) surfaced.push(block);
      } else {
        suppressed.push({
          blockId: block.blockId,
          class: c.class,
          rule: c.rule,
          autoAnswer: c.autoAnswer ?? '',
          suppressed: false,
        });
      }
    } else {
      surfaced.push(block);
    }
  }

  return { surfaced, suppressed, counts };
}

/** Human digest: "31 stalls auto-resolved by policy". */
export function suppressionDigest(result: FeedFilterResult): string {
  const n = result.suppressed.filter((s) => s.suppressed || s.class === 'stall' || s.class === 'fyi').length;
  if (n === 0) return '';
  const applied = result.suppressed.filter((s) => s.suppressed).length;
  if (applied > 0) return `${applied} stall${applied === 1 ? '' : 's'} auto-resolved by policy`;
  return `${n} stall${n === 1 ? '' : 's'} eligible for suppression`;
}
