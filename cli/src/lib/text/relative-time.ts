
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function calendarLabel(thenMs: number, nowMs: number): string {
  const d = new Date(thenMs);
  const label = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(nowMs).getFullYear()
    ? label
    : `${label} '${String(d.getFullYear()).slice(-2)}`;
}

export function formatRelativeTime(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  if (isNaN(then)) return isoTimestamp;

  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHrs = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHrs < 24) return `${diffHrs} hour${diffHrs === 1 ? '' : 's'} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;

  return calendarLabel(then, now);
}

export function formatCompactAge(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  if (isNaN(then)) return isoTimestamp;

  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHrs = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHrs < 24) return `${diffHrs}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return calendarLabel(then, now);
}

const SPAN_MIN_MS = 60_000;

export interface SessionAgeParts {
  created?: string;
  last: string;
}

export function sessionAgeParts(createdIso: string, lastActivityIso?: string): SessionAgeParts {
  const lastIso = lastActivityIso ?? createdIso;
  const last = formatRelativeTime(lastIso);
  const createdMs = new Date(createdIso).getTime();
  const lastMs = new Date(lastIso).getTime();
  if (isNaN(createdMs) || isNaN(lastMs) || lastMs - createdMs < SPAN_MIN_MS) return { last };
  return { created: formatCompactAge(createdIso), last };
}

export function parseTimeFilter(input: string): number {
  const relativeMatch = input.match(/^(\d+)(mo|[mhdwy])$/i);
  if (relativeMatch) {
    const value = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    if (unit === 'm') return Date.now() - value * 60_000;
    if (unit === 'h') return Date.now() - value * 3_600_000;
    if (unit === 'd') return Date.now() - value * 86_400_000;
    if (unit === 'w') return Date.now() - value * 7 * 86_400_000;
    if (unit === 'mo') return Date.now() - value * 30 * 86_400_000;
    if (unit === 'y') return Date.now() - value * 365 * 86_400_000;
  }
  const ts = new Date(input).getTime();
  return Number.isNaN(ts) ? 0 : ts;
}
