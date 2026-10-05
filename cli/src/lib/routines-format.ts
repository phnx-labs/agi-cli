

const DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

export function humanizeCron(expr: string, _tz?: string): string {
  try {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return expr;

    const [minute, hour, dom, month, dow] = parts;

    if (minute === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
      return 'every minute';
    }

    const everyMinMatch = minute.match(/^\*\/(\d+)$/);
    if (everyMinMatch && hour === '*' && dom === '*' && month === '*' && dow === '*') {
      const n = parseInt(everyMinMatch[1], 10);
      return `every ${n} minute${n === 1 ? '' : 's'}`;
    }

    const everyHourMatch = hour.match(/^\*\/(\d+)$/);
    if (everyHourMatch && minute === '0' && dom === '*' && month === '*' && dow === '*') {
      const n = parseInt(everyHourMatch[1], 10);
      return `every ${n} hour${n === 1 ? '' : 's'}`;
    }

    const hourNum = /^\d+$/.test(hour) ? parseInt(hour, 10) : null;
    const minNum = /^\d+$/.test(minute) ? parseInt(minute, 10) : null;

    if (hourNum === null || minNum === null) return expr;

    const timeStr = formatTime12(hourNum, minNum);

    if (dom === '*' && month === '*' && dow === '*') {
      return `daily at ${timeStr}`;
    }

    if (dom === '*' && month === '*' && dow === '1-5') {
      return `weekdays at ${timeStr}`;
    }

    if (dom === '*' && month === '*' && /^\d$/.test(dow)) {
      const dayIdx = parseInt(dow, 10);
      if (dayIdx >= 0 && dayIdx <= 6) {
        return `${DAY_NAMES[dayIdx]} at ${timeStr}`;
      }
    }

    if (/^\d+$/.test(dom) && month === '*' && dow === '*') {
      const d = parseInt(dom, 10);
      return `monthly on day ${d} at ${timeStr}`;
    }

    if (everyHourMatch && dom === '*' && month === '*' && dow === '*') {
      const n = parseInt(everyHourMatch[1], 10);
      return `every ${n} hour${n === 1 ? '' : 's'} at :${String(minNum).padStart(2, '0')}`;
    }

    return expr;
  } catch {
    return expr;
  }
}

function formatTime12(hour: number, minute: number): string {
  const period = hour < 12 ? 'AM' : 'PM';
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const m = String(minute).padStart(2, '0');
  return `${h}:${m} ${period}`;
}


const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function humanizeNextRun(date: Date | null, now: Date, tz?: string): string {
  if (!date) return '-';

  try {
    const locale = 'en-US';
    const tzOpts = tz ? { timeZone: tz } : {};

    // Extract calendar date components for both dates using the same timezone.
    const toYMD = (d: Date): { y: number; m: number; day: number } => {
      const fmt = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'numeric', day: 'numeric', ...tzOpts });
      const parts = fmt.formatToParts(d);
      const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
      return { y: get('year'), m: get('month'), day: get('day') };
    };

    const nowYMD = toYMD(now);
    const dateYMD = toYMD(date);

    // Diff in whole calendar days (ignoring time-of-day)
    const nowMidnight = Date.UTC(nowYMD.y, nowYMD.m - 1, nowYMD.day);
    const dateMidnight = Date.UTC(dateYMD.y, dateYMD.m - 1, dateYMD.day);
    const diffDays = Math.round((dateMidnight - nowMidnight) / 86400000);

    // Time string for the date
    const timeFmt = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', hour12: true, ...tzOpts });
    const timeStr = timeFmt.format(date);

    if (diffDays === 0) return `today ${timeStr}`;
    if (diffDays === 1) return `tomorrow ${timeStr}`;
    if (diffDays < 7) {
      const weekdayIdx = new Intl.DateTimeFormat(locale, { weekday: 'short', ...tzOpts })
        .formatToParts(date)
        .find((p) => p.type === 'weekday')?.value;
      return `${weekdayIdx ?? WEEKDAY_NAMES[date.getDay()]} ${timeStr}`;
    }

    // Further out: "Jun 15, 9:00 AM"
    const monthName = MONTH_NAMES[dateYMD.m - 1];
    return `${monthName} ${dateYMD.day}, ${timeStr}`;
  } catch {
    return date.toLocaleString();
  }
}

// ---------------------------------------------------------------------------
// formatRepoLink
// ---------------------------------------------------------------------------

/**
 * Maximum display length for a repo cell. Display strings longer than this
 * are truncated with an ellipsis so column alignment is preserved.
 * Consumers that render the column should use this constant as the column width.
 */
export const REPO_DISPLAY_MAX = 24;

/**
 * Parse a repo string into a display label and an optional hyperlink target.
 *
 * Rules:
 *   - null / undefined / empty / non-string → display '-', href null
 *   - 'owner/name' (one slash)              → display 'owner/name', href 'https://github.com/owner/name/pulls'
 *   - 'https://...' or 'http://...'         → display hostname+path, href the URL verbatim
 *   - anything else                         → display raw string, href null
 *
 * The display string is truncated to REPO_DISPLAY_MAX characters (with a
 * trailing '…') when it would otherwise exceed the column width. The href
 * is always the full untruncated URL so hyperlinks remain functional.
 *
 * NEVER throws — mirrors the contract of humanizeCron.
 */
export function formatRepoLink(repo: unknown): { display: string; href: string | null } {
  if (repo == null || typeof repo !== 'string' || repo.trim() === '') {
    return { display: '-', href: null };
  }

  const trimmed = repo.trim();
  let display: string;
  let href: string | null;

  // Absolute URL
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
    try {
      const url = new URL(trimmed);
      display = url.hostname + url.pathname.replace(/\/$/, '');
      href = trimmed;
    } catch {
      display = trimmed;
      href = null;
    }
  } else if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed)) {
    // GitHub shorthand: owner/name (exactly one slash, no scheme, no extra slashes)
    display = trimmed;
    href = `https://github.com/${trimmed}/pulls`;
  } else {
    // Anything else: plain text, no link
    display = trimmed;
    href = null;
  }

  // Truncate display to column width; href stays untruncated.
  if (display.length > REPO_DISPLAY_MAX) {
    display = display.slice(0, REPO_DISPLAY_MAX - 1) + '…';
  }

  return { display, href };
}
