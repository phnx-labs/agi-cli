/**
 * Parked-agent answer router (RUSH-1474).
 *
 * `agents message` historically only enqueued into the mailbox (delivered at the
 * next PreToolUse). That steers a *running* agent between tool calls but never
 * unblocks a *parked* agent:
 *   - interactive TUI open on AskUserQuestion (needs keystrokes, not context)
 *   - headless run waiting on input (no next tool call; needs resume)
 *
 * This module picks the delivery mechanism from (open feed block × session
 * liveness × runtime rail). Pure — unit-testable without a live PTY.
 */
import type { OpenBlock, BlockOption } from './feed/feed.js';
import type { ActiveSession } from './session/active.js';
import type { InjectTarget } from './terminal/index.js';
import { addressabilityRecoveryHint } from './terminal/resolve.js';
import { injectTargetFromReplyRail } from './session/inject.js';

export type AnswerRouteKind = 'mailbox' | 'pty' | 'tmux' | 'iterm' | 'resume' | 'refuse';

export interface AnswerRoute {
  kind: AnswerRouteKind;
  /** Human reason shown in CLI output / refused errors. */
  reason: string;
  /**
   * Keystrokes / payload for the chosen path.
   *  - mailbox: unused (text is enqueued as-is)
   *  - pty/tmux/iterm: the digit or free-text to inject
   *  - resume: the free-text prompt to pass on re-entry
   */
  payload?: string;
  /** Inject target when kind is pty/tmux/iterm. */
  inject?: InjectTarget;
  /** Session id + agent kind for resume. */
  resume?: { sessionId: string; agent: string };
  /**
   * Whether to append Enter after the injected payload. Default (omitted) is
   * true. A cancel keystroke (Escape, from a deny / send-back choice) sets this
   * false — the ESC byte itself dismisses the prompt, and a trailing newline
   * would submit a stray empty line into the composer behind it.
   */
  enter?: boolean;
}

export interface AnswerRouterInput {
  /** Resolved mailbox / session id. */
  mailboxId: string;
  /** Answer text (option label or free text). */
  answer: string;
  /** Open feed block for this agent, if any. */
  block?: OpenBlock | null;
  /** Live session row matching the mailbox, if any. */
  session?: ActiveSession | null;
}

/** The Escape keystroke as its raw control byte — what a PTY/tmux/iterm rail reads as a real Escape. */
const ESCAPE_KEY = '\u001b';

/**
 * Match free-text answer against question options.
 * Exact (case-insensitive) > startsWith > includes. Returns 0-based index or -1.
 */
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

/**
 * Build the keystroke payload that closes an AskUserQuestion TUI.
 * Numbered options are selected by digit (1-based) + Enter. Free text with an
 * "Other" option selects Other then types; without Other, types the answer.
 */
export function keystrokesForAnswer(
  answer: string,
  options?: Array<Pick<BlockOption, 'label'>>,
): { payload: string; matched: 'option' | 'free-text' | 'other'; enter?: boolean } {
  const idx = matchOptionIndex(answer, options);
  if (idx >= 0) {
    // AskUserQuestion / plan select-lists are 1-indexed digits.
    return { payload: `${idx + 1}`, matched: 'option' };
  }
  // A symbolic cancel token — the `esc` deliveryKey a deny / send-back choice
  // carries — is the Escape KEY, not the letters "esc". Send the ESC control
  // byte (a real cancel on every raw pty/tmux/iterm rail) and suppress the
  // trailing Enter, so the prompt is dismissed rather than confirmed by a stray
  // newline. Runs after the option match so an option literally labelled "esc"
  // still wins as a selection.
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

/** True when an open feed block still needs an answer. */
export function isOpenQuestionBlock(block: OpenBlock | null | undefined): boolean {
  if (!block) return false;
  if (block.answer || block.parkedAt || block.continuedAt || block.defaultedAt) return false;
  return (block.questions?.length ?? 0) > 0;
}

function injectTargetForSession(session: ActiveSession): InjectTarget | null {
  if (session.provenance?.reply) {
    const fromRail = injectTargetFromReplyRail(session.provenance.reply);
    if (fromRail) return fromRail;
  }
  // Only the agents-pty sidecar is addressable by session id. Generic headless
  // runs have no PTY server entry — those go through resume, not inject.
  if (session.sessionId && session.host === 'pty') {
    return { backend: 'pty', id: session.sessionId };
  }
  return null;
}

/**
 * Pick the delivery mechanism for one answer.
 *
 * Precedence:
 *   1. Parked on open question + injectable rail (tmux/iterm/pty) → keystroke
 *   2. Parked on open question + headless (no rail) → resume with answer
 *   3. Parked on open question + no rail + interactive → refuse (don't mailbox-drop)
 *   4. Otherwise → mailbox (running agent between tool calls)
 */
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
            : inject.backend === 'pty' ? 'pty'
              : 'pty';
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
        'Agent is parked on a question but has no addressable terminal (no tmux/iterm/pty rail). ' +
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
