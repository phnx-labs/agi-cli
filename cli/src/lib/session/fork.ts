import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { sessionHeadline } from './title.js';

interface ForkRecapChanges {
  created: number;
  modified: number;
  deleted: number;
}

interface ForkRecapInput {
  agent: string;
  label: string;
  cwd?: string;
  ticketId?: string;
  machine?: string;
  shortId: string;
  id: string;
  lastAssistant?: string;
  changes?: ForkRecapChanges;
}

const LAST_LINE_CAP = 400;

function trimLastLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= LAST_LINE_CAP) return collapsed;
  return `${collapsed.slice(0, LAST_LINE_CAP).trimEnd()}…`;
}

export function forkLabelFor(session: Pick<SessionMeta, 'label' | 'generatedTitle' | 'topic' | 'shortId'>): string {
  return sessionHeadline(session) || session.shortId;
}

// Fork seeds a new same-harness sibling with bounded plain-text recap, never a transcript copy.
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
