/**
 * Session forking — branch an existing conversation into a new, independent
 * sibling that continues the work, leaving the original untouched.
 *
 * `resume` continues the SAME conversation (same id, same file — it appends).
 * `fork` launches a NEW same-harness session, load-balanced, seeded with a
 * recap of the source so it picks up where the original left off. This is the
 * "git branch" of conversations.
 *
 * The recap — not a transcript copy — is what makes fork work across every
 * device and every REPL harness: the sibling is handed plain text as its opening
 * input, so it never has to reach a transcript that may live on another box. The
 * source is resolved cross-fleet by the same resolver `preview` uses; this module
 * owns only the pure recap text the resolved data folds into.
 */
import type { SessionMeta } from './types.js';
import { sessionHeadline } from './title.js';

/** File-change tally as `sessions preview --json` serializes it (digest.changes). */
export interface ForkRecapChanges {
  created: number;
  modified: number;
  deleted: number;
}

/** Everything the recap seed is built from — resolved cross-fleet before launch. */
export interface ForkRecapInput {
  /** Source harness id — the sibling launches the same one. */
  agent: string;
  /** Display label for the source (label → topic → short id, resolved by the caller). */
  label: string;
  /** Source working directory, so the sibling re-roots itself. */
  cwd?: string;
  /** Linear/GitHub ticket the source was bound to, if any. */
  ticketId?: string;
  /** Device that owns the source transcript, for the `/continue` escape hatch. */
  machine?: string;
  /** Short + full id, so the sibling can pull full history with `/continue <id>`. */
  shortId: string;
  id: string;
  /** The source's last assistant line — the single best "where it left off" signal. */
  lastAssistant?: string;
  /** Changed-files tally so far. */
  changes?: ForkRecapChanges;
}

/** Longest last-assistant excerpt carried into the seed — enough to convey intent
 * without pasting a wall of text (decision: Recap, not Full digest). */
const LAST_LINE_CAP = 400;

/** Collapse whitespace and cap length so a multi-paragraph final message becomes
 * one scannable recap line. */
function trimLastLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= LAST_LINE_CAP) return collapsed;
  return `${collapsed.slice(0, LAST_LINE_CAP).trimEnd()}…`;
}

/**
 * Resolve the human display label the caller passes in from a raw SessionMeta.
 *
 * Pass the session WHOLE. A caller that re-lists fields into an object literal
 * can legally omit the optional `generatedTitle` — the type system does not
 * flag a missing optional property — and the headline then silently degrades to
 * `topic`. That is what the fork call site did (PHNX-3797); the rebuilt-literal
 * shape is caught by `title.ladder-completeness.test.ts`.
 */
export function forkLabelFor(session: Pick<SessionMeta, 'label' | 'generatedTitle' | 'topic' | 'shortId'>): string {
  return sessionHeadline(session) || session.shortId;
}

/**
 * Build the recap-seed prompt handed to the forked sibling as its opening input.
 *
 * Pure and deterministic (unit-tested) — no filesystem, no spawn — so the launch
 * orchestration in `commands/fork.ts` stays the only side-effecting layer.
 */
export function buildForkRecap(input: ForkRecapInput): string {
  const lines: string[] = [];
  lines.push(`Continue a prior ${input.agent} session ("${input.label}"). Pick up where it left off — do not restart it.`);
  if (input.cwd) lines.push(`Working directory: ${input.cwd}`);
  if (input.ticketId) lines.push(`Ticket: ${input.ticketId}`);

  const last = input.lastAssistant ? trimLastLine(input.lastAssistant) : '';
  if (last) lines.push(`It last said: "${last}"`);

  const chg = input.changes;
  if (chg && (chg.created || chg.modified || chg.deleted)) {
    lines.push(`Changes so far: +${chg.created} ~${chg.modified} -${chg.deleted}.`);
  }

  const origin = input.machine ? ` on ${input.machine}` : '';
  lines.push(
    `Source session ${input.shortId}${origin} — run \`/continue ${input.id}\` if you need the full transcript.`,
  );
  return lines.join('\n');
}
