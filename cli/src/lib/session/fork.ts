/** Session forking: branch a conversation into a new, independent sibling, leaving the original
 * untouched. `resume` continues the SAME session; `fork` starts a NEW same-harness one seeded with
 * a recap. The recap, not a transcript copy, works across devices and REPL harnesses. */
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { sessionHeadline } from './title.js';

/** File-change tally as `sessions preview --json` serializes it (digest.changes). */
interface ForkRecapChanges {
  created: number;
  modified: number;
  deleted: number;
}

/** Everything the recap seed is built from — resolved cross-fleet before launch. */
interface ForkRecapInput {
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

/** Resolve the display label from a raw SessionMeta. Pass the session WHOLE: a caller rebuilding an
 * object literal can omit the optional `generatedTitle` unflagged, silently degrading the headline
 * to `topic` (PHNX-3797). `title.ladder-completeness.test.ts` catches that shape. */
export function forkLabelFor(session: Pick<SessionMeta, 'label' | 'generatedTitle' | 'topic' | 'shortId'>): string {
  return sessionHeadline(session) || session.shortId;
}

/** Build the recap-seed prompt handed to the forked sibling as its opening input. Pure and
 * deterministic (no filesystem, no spawn), so the launch orchestration in `commands/fork.ts` stays
 * the only side-effecting layer. */
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
