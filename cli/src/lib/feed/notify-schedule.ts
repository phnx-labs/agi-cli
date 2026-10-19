import type { AttentionUrgency } from './attention.js';

export const NOTIFY_LEVELS: readonly AttentionUrgency[] = ['urgent', 'high', 'normal', 'low'];

export const NOTIFY_LEVEL_KEYS: Record<AttentionUrgency, string> = {
  urgent: 'menubar.menu.notifyUrgent',
  high: 'menubar.menu.notifyHigh',
  normal: 'menubar.menu.notifyNormal',
  low: 'menubar.menu.notifyLow',
};

export const DEFAULT_NOTIFY_SCHEDULES: Record<AttentionUrgency, readonly string[]> = {
  urgent: ['0m', '15m', '30m', 'stay', 'sound'],
  high: ['0m', '30m', 'stay'],
  normal: ['5m', '1h'],
  low: ['sidebar'],
};

export type NotifySchedule =
  | { sidebar: true }
  | { sidebar: false; atMs: number[]; stay: boolean; sound: boolean };

const DURATION = /^(\d+)(m|h)$/;

export function parseNotifySchedule(tokens: readonly string[]): NotifySchedule | string {
  if (tokens.length === 1 && tokens[0] === 'sidebar') return { sidebar: true };
  if (tokens.includes('sidebar')) return '"sidebar" must be the only token.';
  const atMs: number[] = [];
  let stay = false;
  let sound = false;
  for (const token of tokens) {
    const duration = DURATION.exec(token);
    if (duration) {
      const ms = Number(duration[1]) * (duration[2] === 'h' ? 3_600_000 : 60_000);
      if (atMs.length && ms <= atMs[atMs.length - 1]) return `"${token}" is not later than the time before it; list the times in increasing order.`;
      atMs.push(ms);
    } else if (token === 'stay' && !stay) stay = true;
    else if (token === 'sound' && !sound) sound = true;
    else if (token === 'stay' || token === 'sound') return `"${token}" is listed twice.`;
    else return `"${token}" is not a time (5m, 1h), stay, sound or sidebar.`;
  }
  if (atMs.length === 0) return 'list at least one time (e.g. 0m), or sidebar for no banner.';
  return { sidebar: false, atMs, stay, sound };
}

export function validateNotifySchedule(name: string): (value: unknown) => string | null {
  return (value) => {
    const parsed = parseNotifySchedule(value as string[]);
    return typeof parsed === 'string' ? `${name}: ${parsed}` : null;
  };
}

export function notifyScheduleDescription(level: AttentionUrgency): string {
  return (
    `AGI Menu: when a ${level}-urgency agent ask posts a Mac banner. Times (5m, 1h) are measured from when the ask ` +
    'opened: the first posts the banner, each later one a reminder. Add stay to keep the banner on screen and sound ' +
    `to play a sound, or set just sidebar for no banner. Default ${JSON.stringify(DEFAULT_NOTIFY_SCHEDULES[level])}.` +
    (level === 'low' ? ' It also schedules the banner a finished session turn posts: sidebar (the default) posts none, any time turns it on.' : '')
  );
}

export function formatWaited(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
