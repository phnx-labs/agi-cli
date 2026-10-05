import { deriveBlockState, type OpenBlock, type BlockOption } from './feed/feed.js';
import type { ActiveSession } from './session/active.js';
import type { InjectTarget } from './terminal/index.js';
import { addressabilityRecoveryHint } from './terminal/resolve.js';
import { injectTargetFromReplyRail } from './session/inject.js';

export type AnswerRouteKind = 'mailbox' | 'tmux' | 'iterm' | 'resume' | 'refuse';

export interface AnswerRoute {
  kind: AnswerRouteKind;
  reason: string;
  payload?: string;
  inject?: InjectTarget;
  resume?: { sessionId: string; agent: string };
  enter?: boolean;
}

interface AnswerRouterInput {
  mailboxId: string;
  answer: string;
  block?: OpenBlock | null;
  session?: ActiveSession | null;
}

const ESCAPE_KEY = '\u001b';

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

export function keystrokesForAnswer(
  answer: string,
  options?: Array<Pick<BlockOption, 'label'>>,
): { payload: string; matched: 'option' | 'free-text' | 'other'; enter?: boolean } {
  const idx = matchOptionIndex(answer, options);
  if (idx >= 0) {
    return { payload: `${idx + 1}`, matched: 'option' };
  }
  if (/^(?:esc|escape)$/i.test(answer.trim())) {
    return { payload: ESCAPE_KEY, matched: 'other', enter: false };
  }
  if (options?.length) {
    const otherIdx = options.findIndex((o) => /^other$/i.test((o.label ?? '').trim()));
    if (otherIdx >= 0) {
      return { payload: `${otherIdx + 1}\n${answer}`, matched: 'other' };
    }
  }
  return { payload: answer, matched: 'free-text' };
}

export function isParkedOnInput(session: ActiveSession | null | undefined): boolean {
  if (!session) return false;
  if (session.status === 'input_required') return true;
  if (session.activity === 'waiting_input') return true;
  if (session.awaitingReason === 'question' || session.awaitingReason === 'plan_review' || session.awaitingReason === 'permission') {
    return true;
  }
  return false;
}

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

export function resolveAnswerRoute(input: AnswerRouterInput): AnswerRoute {
  const { answer, block, session } = input;
  const openQ = isOpenQuestionBlock(block);
  const parked = isParkedOnInput(session);

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

  return {
    kind: 'mailbox',
    reason: openQ
      ? 'Open block on a running agent — deliver via mailbox at next tool call.'
      : 'No open question — deliver via mailbox at next tool call.',
    payload: answer,
  };
}

export function resumeArgv(route: AnswerRoute): string[] {
  if (route.kind !== 'resume' || !route.resume) {
    throw new Error('resumeArgv requires a resume route');
  }
  const { agent, sessionId } = route.resume;
  const text = route.payload ?? '';
  return ['run', agent, '--resume', sessionId, '--', text];
}
