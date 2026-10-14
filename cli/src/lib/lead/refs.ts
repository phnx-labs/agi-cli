import { linearIssueKeys } from '@phnx-labs/sessions-cli/reader';
import type { LeadRef, LeadTicketRef } from './events.js';
import type { RosterRow } from './roster.js';

export interface RefContext {
  ticketPrefixes: ReadonlySet<string>;
  repo?: string;
  knownPrs: ReadonlySet<number>;
  sessions: RosterRow[];
}

const PR_URL_RE = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
const PR_NUM_RE = /(^|[^\w/&#])#(\d{1,6})\b/g;
const UUID_RE = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g;
const SHORT_ID_RE = /\b[0-9a-f]{8}\b/g;
const MIN_TITLE_WORDS = 3;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractRefs(text: string, ctx: RefContext): LeadRef[] {
  const refs: LeadRef[] = [];
  const seen = new Set<string>();
  const add = (key: string, ref: LeadRef) => {
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };

  for (const id of linearIssueKeys(text)) {
    if (ctx.ticketPrefixes.has(id.split('-')[0])) add(`ticket:${id}`, { kind: 'ticket', id });
  }

  for (const m of text.matchAll(PR_URL_RE)) {
    const number = Number(m[2]);
    add(`pr:${m[1]}#${number}`, { kind: 'pr', repo: m[1], number, url: `https://github.com/${m[1]}/pull/${number}` });
  }
  if (ctx.repo) {
    for (const m of text.matchAll(PR_NUM_RE)) {
      const number = Number(m[2]);
      if (!ctx.knownPrs.has(number)) continue;
      add(`pr:${ctx.repo}#${number}`, { kind: 'pr', repo: ctx.repo, number, url: `https://github.com/${ctx.repo}/pull/${number}` });
    }
  }

  const byId = new Map(ctx.sessions.map((s) => [s.id, s]));
  const byShort = new Map<string, RosterRow[]>();
  for (const s of ctx.sessions) {
    const short = s.id.slice(0, 8);
    byShort.set(short, [...(byShort.get(short) ?? []), s]);
  }
  const sessionRef = (s: RosterRow): LeadRef => ({ kind: 'session', id: s.id, title: s.title, host: s.host });
  for (const m of text.matchAll(UUID_RE)) {
    const s = byId.get(m[0]);
    if (s) add(`session:${s.id}`, sessionRef(s));
  }
  for (const m of text.matchAll(SHORT_ID_RE)) {
    const hits = byShort.get(m[0]);
    if (hits && hits.length === 1) add(`session:${hits[0].id}`, sessionRef(hits[0]));
  }
  const titled = ctx.sessions
    .filter((s) => s.title.trim().split(/\s+/).length >= MIN_TITLE_WORDS)
    .sort((a, b) => b.title.length - a.title.length);
  for (const s of titled) {
    const re = new RegExp(`(^|[^\\w])${escapeRe(s.title)}(?=$|[^\\w])`);
    if (re.test(text)) add(`session:${s.id}`, sessionRef(s));
  }
  return refs;
}

export interface TicketLookup {
  cached(id: string): { url?: string; title?: string } | undefined;
  urlFor(id: string): string | undefined;
}

export function enrichTickets(refs: LeadRef[], lookup: TicketLookup): LeadRef[] {
  return refs.map((ref) => {
    if (ref.kind !== 'ticket') return ref;
    const hit = lookup.cached(ref.id);
    const url = hit?.url ?? lookup.urlFor(ref.id);
    const out: LeadTicketRef = { kind: 'ticket', id: ref.id };
    if (url) out.url = url;
    if (hit?.title) out.title = hit.title;
    return out;
  });
}
