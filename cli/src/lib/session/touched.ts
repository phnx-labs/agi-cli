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
  prs: TouchedPr[];
  tickets: TouchedTicket[];
}

export const TOUCHED_MAX = 50;

const GH_PR_ACTIONS: Record<string, TouchedPrAction> = {
  merge: 'merged',
  review: 'reviewed',
  comment: 'commented',
  checkout: 'checked out',
  edit: 'edited',
  close: 'closed',
};

const AGENTS_PRS_ACTIONS: Record<string, TouchedPrAction> = {
  merge: 'merged',
  review: 'reviewed',
  comment: 'commented',
};

const GH_PR_VALUE_FLAGS = new Set([
  '-R', '--repo', '-b', '--body', '-F', '--body-file', '-t', '--subject', '-c', '--comment',
  '--match-head-commit', '-A', '--author-email', '--title', '-B', '--base', '--branch',
  '--add-assignee', '--remove-assignee', '--add-label', '--remove-label', '--add-reviewer',
  '--remove-reviewer', '--add-project', '--remove-project', '-m', '--milestone',
]);

const LINEAR_UPDATE_VALUE_FLAGS = new Set([
  '--status', '--comment', '--proof', '--label', '--unlabel', '--priority', '--assign', '--delegate',
  '--parent', '--project', '--milestone', '--title', '--description', '--description-file',
  '--due-date', '--remind-at', '--cycle', '--blocks', '--blocked-by', '--relates', '--team',
]);

const PR_URL_RE = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]\S*)?$/;
const LEADING_CD_RE = /^\s*cd\s+(\S+)\s*(?:&&|;|\n)/;

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
  const action = GH_PR_ACTIONS[tokens[2] ?? ''];
  if (!action) return undefined;
  const args = tokens.slice(3);
  if (action === 'merged' && (args.includes('--auto') || args.includes('--disable-auto'))) return undefined;
  const target = positionals(args, GH_PR_VALUE_FLAGS)[0];
  if (!target) return undefined;
  const url = target.match(PR_URL_RE);
  if (url) return prTouch(`${url[1]}/${url[2]}`, Number(url[3]), action);
  if (!/^\d+$/.test(target)) return undefined;
  const repo = normalizeRepo(flagValue(args, ['-R', '--repo'])) ?? inferRepo();
  return repo ? prTouch(repo, Number(target), action) : undefined;
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

export function touchesFromCommand(
  command: string,
  cwd: string | undefined,
  repoForDir: (dir: string) => string | undefined = githubRepoForDir,
): CommandTouches {
  const prs: TouchedPr[] = [];
  const tickets: TouchedTicket[] = [];
  const inferRepo = (): string | undefined => {
    const dir = resolveCommandDir(cwd, command.match(LEADING_CD_RE)?.[1]);
    return dir ? repoForDir(dir) : undefined;
  };
  for (const raw of tokenizeBash(command)) {
    const tokens = withoutEnvPrefix(raw);
    const bin = path.basename(tokens[0] ?? '');
    if (bin === 'gh' && tokens[1] === 'pr') {
      const pr = ghPrTouch(tokens, inferRepo);
      if (pr) prs.push(pr);
    } else if ((bin === 'agents' || bin === 'ag') && tokens[1] === 'projects' && tokens[2] === 'prs') {
      const pr = agentsPrsTouch(tokens);
      if (pr) prs.push(pr);
    } else if (bin === 'linear' && tokens[1] === 'update') {
      tickets.push(...linearUpdateTouches(tokens));
    }
  }
  return { prs, tickets };
}

const repoByDir = new Map<string, string | null>();

function nearestExistingDir(dir: string): string | undefined {
  let current = dir;
  for (;;) {
    try {
      if (fs.statSync(current).isDirectory()) return current;
    } catch {  }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function githubRepoForDir(dir: string): string | undefined {
  const existing = nearestExistingDir(dir);
  if (!existing) return undefined;
  if (!repoByDir.has(existing)) {
    if (repoByDir.size >= 256) repoByDir.clear();
    let repo: string | null = null;
    try {
      const url = execFileSync('git', ['-C', existing, 'config', '--get', 'remote.origin.url'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      });
      repo = repoFromRemote(url);
    } catch {  }
    repoByDir.set(existing, repo);
  }
  return repoByDir.get(existing) ?? undefined;
}

function resolveCommandDir(cwd: string | undefined, cdTarget: string | undefined): string | undefined {
  if (!cdTarget) return cwd;
  const expanded = cdTarget === '~' ? os.homedir() : cdTarget.startsWith('~/') ? path.join(os.homedir(), cdTarget.slice(2)) : cdTarget;
  if (path.isAbsolute(expanded)) return expanded;
  return cwd ? path.resolve(cwd, expanded) : undefined;
}

export interface TouchedLedger {
  touchedPrs: TouchedPr[];
  touchedTickets: TouchedTicket[];
}

export function recordTouches(
  ledger: TouchedLedger,
  touches: CommandTouches,
  created: { prUrls: string[]; tickets: Iterable<string> },
): void {
  const createdPrs = new Set(created.prUrls.map(u => u.toLowerCase()));
  const createdTickets = new Set([...created.tickets].map(t => t.toUpperCase()));
  for (const pr of touches.prs) {
    const key = pr.url.toLowerCase();
    if (createdPrs.has(key)) continue;
    ledger.touchedPrs = [pr, ...ledger.touchedPrs.filter(p => p.url.toLowerCase() !== key)].slice(0, TOUCHED_MAX);
  }
  for (const ticket of touches.tickets) {
    if (createdTickets.has(ticket.id)) continue;
    ledger.touchedTickets = [ticket, ...ledger.touchedTickets.filter(t => t.id !== ticket.id)].slice(0, TOUCHED_MAX);
  }
}
