import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linearIssueKeys, tokenizeBash } from '@phnx-labs/sessions-cli/reader';
import { repoFromRemote } from '../github/gh-overload.js';

export type TouchedPrAction = 'merged' | 'reviewed' | 'commented' | 'checked out' | 'edited' | 'closed';

export interface TouchedPr {
  url: string;
  number: number;
  repo: string;
  action: TouchedPrAction;
}

export interface TouchedTicket {
  id: string;
  action: string;
}

export interface CommandTouches {
  prs: Array<TouchedPr & { masked?: true }>;
  tickets: Array<TouchedTicket & { masked?: true }>;
}

const TOUCHED_MAX = 50;
const PENDING_MAX = 64;

const GH_BODY_FLAGS = ['-b', '--body', '-F', '--body-file'];
const GH_PR_VERBS: Record<string, { action: TouchedPrAction; valueFlags: Set<string> }> = {
  merge: { action: 'merged', valueFlags: new Set([...GH_BODY_FLAGS, '-t', '--subject', '--match-head-commit', '-A', '--author-email']) },
  review: { action: 'reviewed', valueFlags: new Set(GH_BODY_FLAGS) },
  comment: { action: 'commented', valueFlags: new Set(GH_BODY_FLAGS) },
  checkout: { action: 'checked out', valueFlags: new Set(['-b', '--branch']) },
  edit: {
    action: 'edited',
    valueFlags: new Set([...GH_BODY_FLAGS, '-t', '--title', '-B', '--base', '-m', '--milestone',
      '--add-assignee', '--remove-assignee', '--add-label', '--remove-label', '--add-reviewer',
      '--remove-reviewer', '--add-project', '--remove-project']),
  },
  close: { action: 'closed', valueFlags: new Set(['-c', '--comment']) },
};

const AGENTS_PRS_ACTIONS: Record<string, TouchedPrAction> = {
  merge: 'merged',
  review: 'reviewed',
  comment: 'commented',
};

const LINEAR_UPDATE_VALUE_FLAGS = new Set([
  '--status', '--comment', '--proof', '--label', '--unlabel', '--priority', '--assign', '--delegate',
  '--parent', '--project', '--milestone', '--title', '--description', '--description-file',
  '--due-date', '--remind-at', '--cycle', '--blocks', '--blocked-by', '--relates', '--team',
]);

const MERGED_EVIDENCE_RE = /"merged":\s*true|\bmerged pull request\b/i;

const PR_URL_RE = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]\S*)?$/;

type Operator = '&&' | '||' | '|' | ';' | '&' | '';

interface Segment {
  text: string;
  op: Operator;
}

function heredocDelimiter(cmd: string, at: number): { word: string; strip: boolean } | undefined {
  const m = cmd.slice(at).match(/^<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/);
  return m ? { word: m[3]!, strip: m[1] === '-' } : undefined;
}

function splitTopLevel(cmd: string): Segment[] {
  const out: Segment[] = [];
  const heredocs: Array<{ word: string; strip: boolean }> = [];
  let start = 0;
  let depth = 0;
  let quote: '"' | "'" | '`' | undefined;
  const cut = (end: number, op: Operator, next: number): number => {
    const text = cmd.slice(start, end).trim();
    if (text) out.push({ text, op });
    else if (out.length > 0 && op) out[out.length - 1]!.op = op;
    start = next;
    return next - 1;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      if (c === '\\' && quote !== "'") i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') { depth++; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;
    if (c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      const h = heredocDelimiter(cmd, i);
      if (h) heredocs.push(h);
      i++;
      continue;
    }
    if (c === '\n') {
      let next = i + 1;
      for (const h of heredocs.splice(0)) {
        while (next < cmd.length) {
          const eol = cmd.indexOf('\n', next);
          const line = cmd.slice(next, eol < 0 ? cmd.length : eol);
          next = eol < 0 ? cmd.length : eol + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.word) break;
        }
      }
      i = cut(i, ';', next);
      continue;
    }
    if (c === ';') { i = cut(i, ';', i + 1); continue; }
    if (c === '&' && cmd[i + 1] === '&') { i = cut(i, '&&', i + 2); continue; }
    if (c === '|' && cmd[i + 1] === '|') { i = cut(i, '||', i + 2); continue; }
    if (c === '|') { i = cut(i, '|', cmd[i + 1] === '&' ? i + 2 : i + 1); continue; }
    if (c === '&' && cmd[i - 1] !== '>' && cmd[i + 1] !== '>') { i = cut(i, '&', i + 1); continue; }
  }
  cut(cmd.length, '', cmd.length);
  return out;
}

function flagValue(tokens: string[], names: string[]): string | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    for (const name of names) {
      if (t === name) return tokens[i + 1];
      if (name.startsWith('--') && t.startsWith(`${name}=`)) return t.slice(name.length + 1);
    }
  }
  return undefined;
}

function positionals(tokens: string[], valueFlags: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === '--') { out.push(...tokens.slice(i + 1)); break; }
    if (t.startsWith('-')) {
      if (valueFlags.has(t)) i++;
      continue;
    }
    out.push(t);
  }
  return out;
}

function normalizeRepo(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = value.replace(/^https?:\/\//, '').replace(/^github\.com\//, '').replace(/\.git$/, '').match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

function prTouch(repo: string, number: number, action: TouchedPrAction): TouchedPr {
  return { url: `https://github.com/${repo}/pull/${number}`, number, repo, action };
}

function withoutEnvPrefix(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  return tokens.slice(i);
}

function ghPrTouch(tokens: string[], inferRepo: () => string | undefined): TouchedPr | undefined {
  const verb = GH_PR_VERBS[tokens[2] ?? ''];
  if (!verb) return undefined;
  const args = tokens.slice(3);
  if (verb.action === 'merged' && (args.includes('--auto') || args.includes('--disable-auto'))) return undefined;
  const target = positionals(args, new Set(['-R', '--repo', ...verb.valueFlags]))[0];
  if (!target) return undefined;
  const url = target.match(PR_URL_RE);
  if (url) return prTouch(`${url[1]}/${url[2]}`, Number(url[3]), verb.action);
  if (!/^\d+$/.test(target)) return undefined;
  const repo = normalizeRepo(flagValue(args, ['-R', '--repo'])) ?? inferRepo();
  return repo ? prTouch(repo, Number(target), verb.action) : undefined;
}

function agentsPrsTouch(tokens: string[]): TouchedPr | undefined {
  const action = AGENTS_PRS_ACTIONS[tokens[3] ?? ''];
  if (!action) return undefined;
  const args = tokens.slice(4);
  const repo = normalizeRepo(flagValue(args, ['--repo']));
  const number = flagValue(args, ['--number']);
  return repo && number && /^\d+$/.test(number) ? prTouch(repo, Number(number), action) : undefined;
}

function linearUpdateTouches(tokens: string[]): TouchedTicket[] {
  const args = tokens.slice(2);
  const status = args.includes('--done') ? 'done'
    : args.includes('--pickup') ? 'started'
      : args.includes('--todo') ? 'moved to Todo'
        : flagValue(args, ['--status']) ? `moved to ${flagValue(args, ['--status'])}`
          : undefined;
  const action = status
    ?? (flagValue(args, ['--comment', '--proof']) !== undefined ? 'commented' : 'updated');
  const ids = positionals(args, LINEAR_UPDATE_VALUE_FLAGS).flatMap(t => linearIssueKeys(t).filter(k => k === t.toUpperCase()));
  return [...new Set(ids)].map(id => ({ id, action }));
}

function exitStatusCounts(segments: Segment[], index: number): boolean {
  return segments.slice(index, -1).every(s => s.op === '&&');
}

export function touchesFromCommand(
  command: string,
  cwd: string | undefined,
  repoForDir: (dir: string) => string | undefined = githubRepoForDir,
): CommandTouches {
  const prs: CommandTouches['prs'] = [];
  const tickets: CommandTouches['tickets'] = [];
  const segments = splitTopLevel(command);
  let dir = cwd;
  segments.forEach((segment, index) => {
    const tokens = withoutEnvPrefix(tokenizeBash(segment.text)[0] ?? []);
    const bin = path.basename(tokens[0] ?? '');
    if (bin === 'cd') {
      dir = resolveCommandDir(dir, tokens[1]);
      return;
    }
    const mark = exitStatusCounts(segments, index) ? {} : { masked: true as const };
    if (bin === 'gh' && tokens[1] === 'pr') {
      const pr = ghPrTouch(tokens, () => (dir ? repoForDir(dir) : undefined));
      if (pr) prs.push({ ...pr, ...mark });
    } else if ((bin === 'agents' || bin === 'ag') && tokens[1] === 'projects' && tokens[2] === 'prs') {
      const pr = agentsPrsTouch(tokens);
      if (pr) prs.push({ ...pr, ...mark });
    } else if (bin === 'linear' && tokens[1] === 'update') {
      tickets.push(...linearUpdateTouches(tokens).map(t => ({ ...t, ...mark })));
    }
  });
  return { prs, tickets };
}

const REPO_CACHE_MAX = 1024;
const repoByDir = new Map<string, string | null>();

function githubRepoForDir(dir: string): string | undefined {
  const cached = repoByDir.get(dir);
  if (cached !== undefined) return cached ?? undefined;
  let repo: string | null = null;
  try {
    if (fs.statSync(dir).isDirectory()) {
      const url = execFileSync('git', ['-C', dir, 'config', '--get', 'remote.origin.url'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
      });
      repo = repoFromRemote(url);
    }
  } catch {  }
  if (repoByDir.size >= REPO_CACHE_MAX) repoByDir.delete(repoByDir.keys().next().value!);
  repoByDir.set(dir, repo);
  return repo ?? undefined;
}

function resolveCommandDir(cwd: string | undefined, cdTarget: string | undefined): string | undefined {
  if (!cdTarget || cdTarget === '~') return os.homedir();
  const expanded = cdTarget.startsWith('~/') ? path.join(os.homedir(), cdTarget.slice(2)) : cdTarget;
  if (path.isAbsolute(expanded)) return expanded;
  return cwd ? path.resolve(cwd, expanded) : undefined;
}

interface TouchedLedger {
  touchedPrs: TouchedPr[];
  touchedTickets: TouchedTicket[];
}

export function trackPendingTouches(pending: Map<string, CommandTouches>, id: string, touches: CommandTouches): void {
  if (touches.prs.length === 0 && touches.tickets.length === 0) return;
  if (pending.size >= PENDING_MAX) pending.delete(pending.keys().next().value!);
  pending.set(id, touches);
}

export function recordTouches(
  ledger: TouchedLedger,
  touches: CommandTouches,
  output: string,
  created: { prUrls: string[]; tickets: Iterable<string> },
): void {
  const createdPrs = new Set(created.prUrls.map(u => u.toLowerCase()));
  const createdTickets = new Set([...created.tickets].map(t => t.toUpperCase()));
  for (const { masked, ...pr } of touches.prs) {
    if (masked && !(pr.action === 'merged' && MERGED_EVIDENCE_RE.test(output))) continue;
    const key = pr.url.toLowerCase();
    if (createdPrs.has(key)) continue;
    ledger.touchedPrs = [pr, ...ledger.touchedPrs.filter(p => p.url.toLowerCase() !== key)].slice(0, TOUCHED_MAX);
  }
  for (const { masked, ...ticket } of touches.tickets) {
    if (masked) continue;
    if (createdTickets.has(ticket.id)) continue;
    ledger.touchedTickets = [ticket, ...ledger.touchedTickets.filter(t => t.id !== ticket.id)].slice(0, TOUCHED_MAX);
  }
}
