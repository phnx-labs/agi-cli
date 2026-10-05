/** Parked-agent answer router (RUSH-1474). `agents message` only enqueued to the mailbox (next
 * PreToolUse), which steers a running agent but never unblocks a parked one (TUI on
 * AskUserQuestion, headless awaiting input). This picks delivery from block x liveness x rail. */
import { deriveBlockState, type OpenBlock, type BlockOption } from './feed/feed.js';
import type { ActiveSession } from './session/active.js';
import type { InjectTarget } from './terminal/index.js';
import { addressabilityRecoveryHint } from './terminal/resolve.js';
import { injectTargetFromReplyRail } from './session/inject.js';

export type AnswerRouteKind = 'mailbox' | 'tmux' | 'iterm' | 'resume' | 'refuse';

export interface AnswerRoute {
  kind: AnswerRouteKind;
  /** Human reason shown in CLI output / refused errors. */
  reason: string;
  /** Keystrokes/payload for the chosen path: unused for mailbox; the digit or free text for
   * tmux/iterm; the free-text prompt for resume. */
  payload?: string;
  /** Inject target when kind is tmux/iterm. */
  inject?: InjectTarget;
  /** Session id + agent kind for resume. */
  resume?: { sessionId: string; agent: string };
  /** Whether to append Enter after the payload (default true). A cancel keystroke (Escape) sets
   * false: the ESC byte dismisses the prompt, and a newline would submit a stray empty line into
   * the composer. */
  enter?: boolean;
}

interface AnswerRouterInput {
  /** Resolved mailbox / session id. */
  mailboxId: string;
  /** Answer text (option label or free text). */
  answer: string;
  /** Open feed block for this agent, if any. */
  block?: OpenBlock | null;
  /** Live session row matching the mailbox, if any. */
  session?: ActiveSession | null;
}

/** The Escape keystroke as its raw control byte — what a tmux/iterm rail reads as a real Escape. */
const ESCAPE_KEY = '\u001b';

/** Match a free-text answer against question options: exact (case-insensitive), then startsWith,
 * then includes. Returns a 0-based index or -1. */
export function matchOptionIndex(
  answer: string,
  options: Array<Pick<BlockOption, 'label'>> | undefined,
): number {
  if (!options?.length) return -1;
  const needle = answer.trim().toLowerCase();
  if (!needle) return -1;
  const labels = options.map((o) => (o.label ?? '').trim());
  const exact = labels.findIndex((l) => l.toLowerCase() === needle);
  if (exact >= 0) return exact;
  const starts = labels.findIndex((l) => l.toLowerCase().startsWith(needle));
  if (starts >= 0) return starts;
  const includes = labels.findIndex((l) => l.toLowerCase().includes(needle));
  return includes;
}

/** Build the keystroke payload that closes an AskUserQuestion TUI: numbered options by 1-based
 * digit + Enter; free text selects "Other" then types, or types the answer if there is no Other. */
export function keystrokesForAnswer(
  answer: string,
  options?: Array<Pick<BlockOption, 'label'>>,
): { payload: string; matched: 'option' | 'free-text' | 'other'; enter?: boolean } {
  const idx = matchOptionIndex(answer, options);
  if (idx >= 0) {
    // AskUserQuestion / plan select-lists are 1-indexed digits.
    return { payload: `${idx + 1}`, matched: 'option' };
  }
  // A symbolic cancel token (the `esc` deliveryKey of a deny/send-back choice) is the Escape key,
  // not the letters: send the ESC byte and suppress Enter. Runs after option matching so an option
  // labelled "esc" wins.
  if (/^(?:esc|escape)$/i.test(answer.trim())) {
    return { payload: ESCAPE_KEY, matched: 'other', enter: false };
  }
  if (options?.length) {
    const otherIdx = options.findIndex((o) => /^other$/i.test((o.label ?? '').trim()));
    if (otherIdx >= 0) {
      // Select Other, then type the free text on the next field.
      return { payload: `${otherIdx + 1}\n${answer}`, matched: 'other' };
    }
  }
  return { payload: answer, matched: 'free-text' };
}

/** True when the session is waiting on user input (parked on a question/plan). */
export function isParkedOnInput(session: ActiveSession | null | undefined): boolean {
  if (!session) return false;
  if (session.status === 'input_required') return true;
  if (session.activity === 'waiting_input') return true;
  if (session.awaitingReason === 'question' || session.awaitingReason === 'plan_review' || session.awaitingReason === 'permission') {
    return true;
  }
  return false;
}

/** True when an open feed block still needs an answer. Openness comes from deriveBlockState, not a
 * truthy `block.answer`: a pending claim records the answer but stays `open` (feed.ts
 * `recordAnswer`); a retry would re-route a parked headless agent to a dead mailbox (PHNX-3999). */
export function isOpenQuestionBlock(block: OpenBlock | null | undefined): boolean {
  if (!block) return false;
  if (block.parkedAt || block.continuedAt || block.defaultedAt) return false;
  if (deriveBlockState(block) !== 'open') return false;
  return (block.questions?.length ?? 0) > 0;
}

function injectTargetForSession(session: ActiveSession): InjectTarget | null {
  if (session.provenance?.reply) {
    const fromRail = injectTargetFromReplyRail(session.provenance.reply);
    if (fromRail) return fromRail;
  }
  return null;
}

/** Pick the delivery for one answer. Parked on an open question: injectable rail (tmux/iterm) gives
 * keystrokes; headless resumes with the answer; interactive with no rail is refused (don't
 * mailbox-drop). Otherwise mailbox (running agent between tool calls). */
export function resolveAnswerRoute(input: AnswerRouterInput): AnswerRoute {
  const { answer, block, session } = input;
  const openQ = isOpenQuestionBlock(block);
  const parked = isParkedOnInput(session);

  // Options from the first question on the block (or the session's structured question).
  const options =
    block?.questions?.[0]?.options ??
    session?.question?.options?.map((o) => ({ label: o.label }));

  if (openQ && parked && session) {
    const inject = injectTargetForSession(session);
    const { payload, matched, enter } = keystrokesForAnswer(answer, options);

    if (inject) {
      const kind: AnswerRouteKind =
        inject.backend === 'tmux' ? 'tmux'
          : inject.backend === 'iterm' ? 'iterm'
            : 'tmux';
      return {
        kind,
        reason: `Parked on open question — drive ${inject.backend} selection (${matched}).`,
        payload,
        inject,
        ...(enter === false ? { enter: false } : {}),
      };
    }

    // Headless / no rail: re-enter via resume.
    if (session.context === 'headless' || session.context === 'teams' || !session.tty) {
      const sid = session.sessionId ?? input.mailboxId;
      if (!sid) {
        return {
          kind: 'refuse',
          reason: 'Parked headless agent has no session id to resume.',
        };
      }
      return {
        kind: 'resume',
        reason: 'Parked headless agent — resume with the answer as the next user turn.',
        payload: answer,
        resume: { sessionId: sid, agent: session.kind },
      };
    }

    return {
      kind: 'refuse',
      reason:
        'Agent is parked on a question but has no addressable terminal (no tmux/iterm rail). ' +
        addressabilityRecoveryHint(session),
    };
  }

  // Open block but agent is still looping between tool calls — mailbox is correct.
  // No block — free-form mid-flight steer — mailbox.
  return {
    kind: 'mailbox',
    reason: openQ
      ? 'Open block on a running agent — deliver via mailbox at next tool call.'
      : 'No open question — deliver via mailbox at next tool call.',
    payload: answer,
  };
}

/** Build argv for a headless resume that continues with the answer text. */
export function resumeArgv(route: AnswerRoute): string[] {
  if (route.kind !== 'resume' || !route.resume) {
    throw new Error('resumeArgv requires a resume route');
  }
  const { agent, sessionId } = route.resume;
  const text = route.payload ?? '';
  // `agents run <agent> --resume <id> -- <answer>` — the trailing prompt is the
  // next user turn after native resume (claude/codex) or /continue replay.
  return ['run', agent, '--resume', sessionId, '--', text];
}
