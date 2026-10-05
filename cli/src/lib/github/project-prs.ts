
import * as fs from 'fs';
import * as path from 'path';
import { ghExec, canonicalizeRepo, projectRepoSlugs, type GhExec } from './pr-mergeable.js';
import { isRateLimitError, rollupForSha, type RollupItem } from './rest.js';
import { cachedViewer, fetchViewerProfile } from './viewer.js';
import { repoPathClaims, type ProjectDef } from '../projects.js';
import { getCacheDir } from '../state.js';
import { atomicWriteFileSync } from '../fs-atomic.js';
import { npmView as defaultNpmView, readLatestTag, withMergesSince, type NpmView, type RepoRelease, type TagRead } from './release-drift.js';

export interface ProjectPrAuthor {
  login: string;
  avatarUrl: string;
}

export type ProjectPrScope = 'project' | 'repo-wide';

export type CiState = 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ERROR' | 'EXPECTED';

export interface ProjectPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  state: string;
  createdAt: string;
  updatedAt: string;
  author: ProjectPrAuthor;
  headRefName: string;
  baseRefName: string;
  headSha: string;
  body: string;
  scope: ProjectPrScope | null;
  mergeable: boolean | null;
  mergeableState: string | null;
  checks: RollupItem[] | null;
  reviewDecision: string | null;
  ciState: CiState | null;
  failingChecks: string[];
  autoMerge: ProjectPrAutoMerge | null;
}

export interface ProjectPrAutoMerge {
  enabledBy: string;
  method: string;
}

export interface RepoMergeAbility {
  viewerIsAdmin: boolean;
  adminBypass: boolean;
  autoMergeAllowed: boolean;
  methods: MergeMethod[];
}

export interface MergedPr {
  number: number;
  title: string;
  url: string;
  author: ProjectPrAuthor;
  headRefName: string;
  baseRefName: string;
  mergedAt: string;
  mergedBy: string | null;
  mergeCommitSha: string | null;
  ciState: CiState | null;
  failingChecks: string[];
  additions: number;
  deletions: number;
  scope: ProjectPrScope | null;
}

export interface DefaultBranchCi {
  name: string;
  sha: string;
  ciState: CiState | null;
  failingChecks: string[];
}

export interface ProjectRepoPrs {
  slug: string;
  sharedWith: string[];
  pullRequests: ProjectPr[];
  merge: RepoMergeAbility | null;
  recentlyMerged: MergedPr[];
  defaultBranch: DefaultBranchCi | null;
  ciError: string | null;
  truncated: boolean;
  release: RepoRelease | null;
  releaseError: string | null;
  error: string | null;
}

export interface ProjectPrsEnvelope {
  project: { name: string; linearProjectId: string | null };
  viewer: string | null;
  repositories: ProjectRepoPrs[];
  partial: boolean;
}

export interface ProjectPrsContext {
  nowMs?: number;
  cacheDir?: string;
  npmView?: NpmView;
}

export interface ProjectPrsOptions {
  repo?: string;
  number?: number;
}

const PR_JQ =
  '{number, title, url: .html_url, isDraft: (.draft // false), ' +
  'state: (.state // "" | ascii_upcase), createdAt: (.created_at // ""), updatedAt: (.updated_at // ""), ' +
  'login: (.user.login // ""), avatarUrl: (.user.avatar_url // ""), ' +
  'headRefName: (.head.ref // ""), baseRefName: (.base.ref // ""), ' +
  'headSha: (.head.sha // ""), body: (.body // ""), ' +
  'mergeable: .mergeable, mergeableState: .mergeable_state, ' +
  'autoMerge: (if .auto_merge then {enabledBy: (.auto_merge.enabled_by.login // ""), method: (.auto_merge.merge_method // "")} else null end)}';

function parseNdjson(out: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    rows.push(JSON.parse(t) as Record<string, unknown>);
  }
  return rows;
}

export function rowToProjectPr(row: Record<string, unknown>): ProjectPr {
  return {
    number: Number(row.number),
    title: String(row.title ?? ''),
    url: String(row.url ?? ''),
    isDraft: Boolean(row.isDraft),
    state: String(row.state ?? ''),
    createdAt: String(row.createdAt ?? ''),
    updatedAt: String(row.updatedAt ?? ''),
    author: { login: String(row.login ?? ''), avatarUrl: String(row.avatarUrl ?? '') },
    headRefName: String(row.headRefName ?? ''),
    baseRefName: String(row.baseRefName ?? ''),
    headSha: String(row.headSha ?? ''),
    body: String(row.body ?? ''),
    scope: null,
    mergeable: typeof row.mergeable === 'boolean' ? row.mergeable : null,
    mergeableState: typeof row.mergeableState === 'string' ? row.mergeableState : null,
    checks: null,
    reviewDecision: null,
    ciState: null,
    failingChecks: [],
    autoMerge: isRecord(row.autoMerge)
      ? { enabledBy: String(row.autoMerge.enabledBy ?? ''), method: String(row.autoMerge.method ?? '') }
      : null,
  };
}

export async function listOpenPrs(repo: string, gh: GhExec = ghExec): Promise<ProjectPr[]> {
  const out = await gh([
    'api',
    `repos/${repo}/pulls?state=open&per_page=100`,
    '--paginate',
    '--cache', '60s',
    '--jq',
    `.[] | ${PR_JQ}`,
  ]);
  return parseNdjson(out).map(rowToProjectPr);
}

export async function fetchOnePr(repo: string, number: number, gh: GhExec = ghExec): Promise<ProjectPr> {
  const out = await gh(['api', `repos/${repo}/pulls/${number}`, '--jq', PR_JQ]);
  const rows = parseNdjson(out);
  if (rows.length === 0) throw new Error(`no PR ${repo}#${number}`);
  return rowToProjectPr(rows[0]);
}

export async function fetchReviewAndHead(
  repo: string,
  number: number,
  gh: GhExec = ghExec,
): Promise<{ reviewDecision: string | null; headRefOid: string | null }> {
  const out = (await gh([
    'pr', 'view', String(number), '--repo', repo, '--json', 'reviewDecision,headRefOid',
  ])).trim();
  const parsed = out ? (JSON.parse(out) as { reviewDecision?: string; headRefOid?: string }) : {};
  return {
    reviewDecision: parsed.reviewDecision || null,
    headRefOid: parsed.headRefOid || null,
  };
}

export async function enrichPr(repo: string, pr: ProjectPr, gh: GhExec = ghExec): Promise<ProjectPr> {
  const { reviewDecision, headRefOid } = await fetchReviewAndHead(repo, pr.number, gh);
  const head = headRefOid || pr.headSha;
  const checks = await rollupForSha(repo, head, gh);
  return { ...pr, headSha: head, checks, reviewDecision, ...ciFromRollupItems(checks) };
}

export const MERGED_WINDOW_DAYS = 7;
export const MERGED_LIMIT = 20;
export const MERGED_PAGE_CAP = 3;

export const FAILING_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
export const FAILING_STATES = new Set(['FAILURE', 'ERROR']);

export interface CiSummary {
  ciState: CiState | null;
  failingChecks: string[];
}

const NO_CI: CiSummary = { ciState: null, failingChecks: [] };

const isCheckRun = (item: RollupItem) => item.state === undefined;

export function ciFromRollupItems(items: readonly RollupItem[]): CiSummary {
  if (items.length === 0) return NO_CI;
  const failing: string[] = [];
  let failed = false;
  let pending = false;
  for (const item of items) {
    const run = isCheckRun(item);
    if (run ? FAILING_CONCLUSIONS.has(item.conclusion ?? '') : FAILING_STATES.has(item.state ?? '')) {
      failing.push(item.name);
      if (run || item.state === 'FAILURE') failed = true;
    } else if (run ? item.status !== 'COMPLETED' : item.state === 'PENDING') {
      pending = true;
    }
  }
  if (failing.length > 0) return { ciState: failed ? 'FAILURE' : 'ERROR', failingChecks: failing };
  return { ciState: pending ? 'PENDING' : 'SUCCESS', failingChecks: [] };
}

const PASSING_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

export function isPassingRollup(items: readonly RollupItem[]): boolean {
  return items.length > 0 && items.every((i) => (isCheckRun(i)
    ? i.status === 'COMPLETED' && PASSING_CONCLUSIONS.has(i.conclusion ?? '')
    : i.state === 'SUCCESS'));
}

export const PASSING_ROLLUP_TTL_MS = 60 * 60 * 1000;

export const FAILING_ROLLUP_TTL_MS = 5 * 60 * 1000;

export function isFinishedRollup(items: readonly RollupItem[]): boolean {
  return items.length > 0 && items.every((i) => (isCheckRun(i) ? i.status === 'COMPLETED' : i.state !== 'PENDING'));
}

function rollupTtlMs(items: readonly RollupItem[]): number {
  return isPassingRollup(items) ? PASSING_ROLLUP_TTL_MS : FAILING_ROLLUP_TTL_MS;
}

interface CachedRollup {
  items: RollupItem[];
  readAt: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const isFileList = (v: unknown): v is string[] => Array.isArray(v) && v.every((f) => typeof f === 'string');

const isCachedRollup = (v: unknown): v is CachedRollup =>
  isRecord(v) && typeof v.readAt === 'number' && Array.isArray(v.items) &&
  v.items.every((i) => isRecord(i) && typeof i.name === 'string');

const isNpmRead = (v: unknown): v is { version: string | null; error: string | null; readAt: number } =>
  isRecord(v) && typeof v.readAt === 'number' && (v.version === null || typeof v.version === 'string') &&
  (v.error === null || typeof v.error === 'string');

const isMergedDetail = (v: unknown): v is MergedDetail =>
  isRecord(v) && (v.mergedBy === null || typeof v.mergedBy === 'string') &&
  typeof v.additions === 'number' && typeof v.deletions === 'number';

export class KeyedCache<T> {
  private readonly file: string;
  private readonly sep: '@' | '#';
  private entries: Record<string, T> = {};
  private dirty = false;

  constructor(dir: string, name: string, sep: '@' | '#', isValid: (v: unknown) => v is T) {
    this.file = path.join(dir, name);
    this.sep = sep;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    for (const [key, value] of Object.entries(parsed)) {
      if (isValid(value)) this.entries[key] = value;
      else this.dirty = true;
    }
  }

  get(slug: string, id: string | number): T | undefined {
    return this.entries[`${slug}${this.sep}${id}`];
  }

  set(slug: string, id: string | number, value: T): void {
    this.entries[`${slug}${this.sep}${id}`] = value;
    this.dirty = true;
  }

  prune(slug: string, listed: ReadonlySet<string>): void {
    for (const key of Object.keys(this.entries)) {
      const at = key.lastIndexOf(this.sep);
      if (key.slice(0, at) === slug && !listed.has(key.slice(at + 1))) {
        delete this.entries[key];
        this.dirty = true;
      }
    }
  }

  save(): void {
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    atomicWriteFileSync(this.file, JSON.stringify(this.entries));
  }
}

class CiErrors {
  message: string | null = null;

  record(err: unknown): void {
    const msg = ghFailure(err);
    if (this.message === null || (isRateLimited(msg) && !isRateLimited(this.message))) this.message = msg;
  }
}

function isRateLimited(message: string): boolean {
  return isRateLimitError(message) || /API rate limit exceeded/i.test(message);
}

interface CiReader {
  slug: string;
  gh: GhExec;
  rollups: KeyedCache<CachedRollup>;
  errors: CiErrors;
  nowMs: number;
  reads: Map<string, Promise<CiSummary>>;
}

function readCi(ci: CiReader, sha: string | null): Promise<CiSummary> {
  if (!sha) return Promise.resolve(NO_CI);
  let read = ci.reads.get(sha);
  if (!read) {
    read = readCiUncached(ci, sha);
    ci.reads.set(sha, read);
  }
  return read;
}

async function readCiUncached(ci: CiReader, sha: string): Promise<CiSummary> {
  const hit = ci.rollups.get(ci.slug, sha);
  const age = hit ? ci.nowMs - hit.readAt : -1;
  if (hit && age >= 0 && age < rollupTtlMs(hit.items)) return ciFromRollupItems(hit.items);
  try {
    const items = await rollupForSha(ci.slug, sha, ci.gh);
    if (isFinishedRollup(items)) ci.rollups.set(ci.slug, sha, { items, readAt: ci.nowMs });
    return ciFromRollupItems(items);
  } catch (err) {
    ci.errors.record(err);
    return NO_CI;
  }
}

const CLOSED_JQ =
  '.[] | {number, title, url: .html_url, login: (.user.login // ""), avatarUrl: (.user.avatar_url // ""), ' +
  'headRefName: (.head.ref // ""), headSha: (.head.sha // ""), baseRefName: (.base.ref // ""), ' +
  'mergedAt: .merged_at, mergeCommitSha: .merge_commit_sha, updatedAt: .updated_at}';

interface MergedCandidate {
  pr: MergedPr;
  headSha: string;
}

export async function listRecentlyMerged(
  repo: string,
  sinceMs: number,
  gh: GhExec = ghExec,
): Promise<{ merged: MergedCandidate[]; truncated: boolean }> {
  const rows: Array<Record<string, unknown>> = [];
  let truncated = false;
  for (let page = 1; page <= MERGED_PAGE_CAP; page++) {
    const pageRows = parseNdjson(await gh([
      'api', `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`,
      '--cache', '60s', '--jq', CLOSED_JQ,
    ]));
    rows.push(...pageRows);
    const oldest = pageRows.at(-1)?.updatedAt;
    if (pageRows.length < 100 || typeof oldest !== 'string' || Date.parse(oldest) < sinceMs) break;
    truncated = page === MERGED_PAGE_CAP;
  }
  const merged = rows
    .filter((r) => typeof r.mergedAt === 'string' && Date.parse(r.mergedAt) >= sinceMs)
    .sort((a, b) => Date.parse(String(b.mergedAt)) - Date.parse(String(a.mergedAt)))
    .map((r) => ({
      headSha: String(r.headSha ?? ''),
      pr: {
        number: Number(r.number),
        title: String(r.title ?? ''),
        url: String(r.url ?? ''),
        author: { login: String(r.login ?? ''), avatarUrl: String(r.avatarUrl ?? '') },
        headRefName: String(r.headRefName ?? ''),
        baseRefName: String(r.baseRefName ?? ''),
        mergedAt: String(r.mergedAt),
        mergedBy: null,
        mergeCommitSha: typeof r.mergeCommitSha === 'string' && r.mergeCommitSha ? r.mergeCommitSha : null,
        ciState: null,
        failingChecks: [],
        additions: 0,
        deletions: 0,
        scope: null,
      },
    }));
  return { merged, truncated };
}

interface MergedDetail {
  mergedBy: string | null;
  additions: number;
  deletions: number;
}

async function readMergedDetail(
  slug: string,
  number: number,
  gh: GhExec,
  details: KeyedCache<MergedDetail>,
  errors: CiErrors,
): Promise<MergedDetail | null> {
  const hit = details.get(slug, number);
  if (hit) return hit;
  try {
    const row = JSON.parse((await gh([
      'api', `repos/${slug}/pulls/${number}`, '--jq', '{mergedBy: .merged_by.login, additions, deletions}',
    ])).trim()) as { mergedBy?: string | null; additions?: number; deletions?: number };
    const detail = { mergedBy: row.mergedBy || null, additions: Number(row.additions ?? 0), deletions: Number(row.deletions ?? 0) };
    details.set(slug, number, detail);
    return detail;
  } catch (err) {
    errors.record(err);
    return null;
  }
}

async function readDefaultBranch(ci: CiReader): Promise<DefaultBranchCi | null> {
  try {
    const name = (await ci.gh(['api', `repos/${ci.slug}`, '--cache', '1h', '--jq', '.default_branch'])).trim();
    if (!name) throw new Error(`${ci.slug} reports no default branch`);
    const sha = (await ci.gh(['api', `repos/${ci.slug}/branches/${name}`, '--jq', '.commit.sha'])).trim();
    if (!sha) throw new Error(`${ci.slug}@${name} has no head commit`);
    return { name, sha, ...await readCi(ci, sha) };
  } catch (err) {
    ci.errors.record(err);
    return null;
  }
}

export async function resolveTargetSlugs(
  def: ProjectDef,
  repo: string | undefined,
  gh: GhExec,
): Promise<string[]> {
  const raw = projectRepoSlugs([def]);
  const canonPairs = await Promise.all(raw.map(async (slug) => [slug, await canonicalizeRepo(slug, gh)] as const));
  const canon = new Map<string, string>(canonPairs);
  const canonical = [...new Set(canon.values())];
  if (!repo) return canonical;

  const requested = await canonicalizeRepo(repo, gh);
  const attached =
    raw.includes(repo) ||
    canonical.includes(requested) ||
    [...canon.keys()].some((k) => k === repo);
  if (!attached) {
    const list = raw.length ? raw.join(', ') : '(none)';
    throw new Error(
      `Repo "${repo}" is not attached to project "${def.name}". Attached repos: ${list}.`,
    );
  }
  return [requested];
}

export function scopeForFiles(files: readonly string[], own: readonly string[], others: readonly string[]): ProjectPrScope | null {
  const under = (prefixes: readonly string[]) => files.some((f) => prefixes.some((p) => f.startsWith(p)));
  if (under(own)) return 'project';
  if (under(others)) return null;
  return 'repo-wide';
}

class PrFilesCache extends KeyedCache<string[]> {
  constructor(dir: string) {
    super(dir, 'project-pr-files.json', '@', isFileList);
  }

  async files(slug: string, pr: { number: number; headSha: string }, gh: GhExec): Promise<string[]> {
    const hit = this.get(slug, pr.headSha);
    if (hit) return hit;
    const out = await gh(['api', `repos/${slug}/pulls/${pr.number}/files?per_page=100`, '--paginate', '--jq', '.[] | .filename, (.previous_filename // empty)']);
    const files = out.split('\n').map((l) => l.trim()).filter(Boolean);
    this.set(slug, pr.headSha, files);
    return files;
  }
}

async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function fetchViewer(gh: GhExec = ghExec): Promise<string | null> {
  return (await fetchViewerProfile(gh))?.login ?? null;
}

async function canonicalClaims(def: ProjectDef, gh: GhExec): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const { slug, prefix } of repoPathClaims(def)) {
    const canonical = await canonicalizeRepo(slug, gh);
    out.set(canonical, [...(out.get(canonical) ?? []), prefix]);
  }
  return out;
}

async function repoPeers(
  def: ProjectDef,
  peers: readonly ProjectDef[],
  gh: GhExec,
): Promise<Map<string, { names: string[]; prefixes: string[] }>> {
  const bySlug = new Map<string, { names: string[]; prefixes: string[] }>();
  await Promise.all(peers.filter((p) => p.name !== def.name).map(async (peer) => {
    const [slugs, claims] = await Promise.all([
      Promise.all(projectRepoSlugs([peer]).map((s) => canonicalizeRepo(s, gh))),
      canonicalClaims(peer, gh),
    ]);
    for (const slug of new Set(slugs)) {
      const entry = bySlug.get(slug) ?? { names: [], prefixes: [] };
      entry.names.push(peer.name);
      entry.prefixes.push(...(claims.get(slug) ?? []));
      bySlug.set(slug, entry);
    }
  }));
  for (const entry of bySlug.values()) entry.names.sort();
  return bySlug;
}

export async function buildProjectPrs(
  def: ProjectDef,
  opts: ProjectPrsOptions = {},
  gh: GhExec = ghExec,
  peers: readonly ProjectDef[] = [],
  ctx: ProjectPrsContext = {},
): Promise<ProjectPrsEnvelope> {
  const project = { name: def.name, linearProjectId: def.linear?.projectId ?? null };
  const slugs = await resolveTargetSlugs(def, opts.repo, gh);
  if (slugs.length === 0) return { project, viewer: null, repositories: [], partial: false };
  const viewerRead = fetchViewer(gh);
  const [shared, ownClaims] = await Promise.all([repoPeers(def, peers, gh), canonicalClaims(def, gh)]);
  const cacheDir = ctx.cacheDir ?? getCacheDir();
  const filesCache = new PrFilesCache(cacheDir);
  const rollups = new KeyedCache<CachedRollup>(cacheDir, 'project-pr-ci.json', '@', isCachedRollup);
  const details = new KeyedCache<MergedDetail>(cacheDir, 'project-pr-merged.json', '#', isMergedDetail);
  const npmVersions = new KeyedCache<{ version: string | null; error: string | null; readAt: number }>(cacheDir, 'project-npm-versions.json', '#', isNpmRead);
  const nowMs = ctx.nowMs ?? Date.now();
  const npm = {
    view: ctx.npmView ?? defaultNpmView,
    nowMs,
    cache: { get: (name: string) => npmVersions.get('npm', name), set: (name: string, v: { version: string | null; error: string | null; readAt: number }) => npmVersions.set('npm', name, v) },
  };
  const sinceMs = nowMs - MERGED_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const repositories: ProjectRepoPrs[] = await Promise.all(
    slugs.map(async (slug): Promise<ProjectRepoPrs> => {
      const peer = shared.get(slug);
      const sharedWith = peer?.names ?? [];
      try {
        const mergeRead = readRepoMergeAbility(slug, gh).then(
          (merge) => ({ merge, error: null }),
          (err: unknown) => ({ merge: null, error: err }),
        );
        if (opts.number !== undefined) {
          const pr = await fetchOnePr(slug, opts.number, gh);
          const enriched = await enrichPr(slug, pr, gh);
          const { merge, error: mergeError } = await mergeRead;
          return {
            slug, sharedWith, pullRequests: [enriched], merge,
            recentlyMerged: [], defaultBranch: null, ciError: mergeError === null ? null : ghFailure(mergeError), truncated: false, release: null, releaseError: null, error: null,
          };
        }
        const errors = new CiErrors();
        const ci: CiReader = { slug, gh, rollups, errors, nowMs, reads: new Map() };
        const tagRead: Promise<{ tag: TagRead | null; error: string | null }> = readLatestTag(slug, gh, npm)
          .then((tag) => ({ tag, error: null }), (err: unknown) => ({ tag: null, error: ghFailure(err) }));
        const [listed, mergedRead, defaultBranch] = await Promise.all([
          listOpenPrs(slug, gh),
          listRecentlyMerged(slug, sinceMs, gh).catch((err: unknown) => {
            errors.record(err);
            return null;
          }),
          readDefaultBranch(ci),
        ]);
        const mergedListed = mergedRead?.merged ?? null;
        let pullRequests: ProjectPr[] = listed;
        let merged = mergedListed ?? [];
        const own = ownClaims.get(slug);
        if (peer && own) {
          if (mergedListed) filesCache.prune(slug, new Set([...listed.map((pr) => pr.headSha), ...merged.map((m) => m.headSha)]));
          const scopeOf = async (pr: { number: number; headSha: string }) =>
            scopeForFiles(await filesCache.files(slug, pr, gh), own, peer.prefixes);
          const [openScopes, mergedScopes] = await Promise.all([
            mapBounded(pullRequests, 8, scopeOf),
            mapBounded(merged, 8, (m) => scopeOf({ number: m.pr.number, headSha: m.headSha })),
          ]);
          pullRequests = pullRequests
            .map((pr, i) => ({ ...pr, scope: openScopes[i] }))
            .filter((pr) => pr.scope !== null);
          merged = merged
            .map((m, i) => ({ ...m, pr: { ...m.pr, scope: mergedScopes[i] } }))
            .filter((m) => m.pr.scope !== null);
        }
        const { tag, error: releaseError } = await tagRead;
        const release = tag
          ? withMergesSince(tag, mergedListed ? merged.map((m) => m.pr) : null, { sinceMs, truncated: mergedRead?.truncated ?? false, base: defaultBranch?.name ?? null })
          : null;
        merged = merged.slice(0, MERGED_LIMIT);
        const [openCi, recentlyMerged] = await Promise.all([
          mapBounded(pullRequests, 8, (pr) => readCi(ci, pr.headSha)),
          mapBounded(merged, 8, async (m): Promise<MergedPr> => {
            const [detail, mergeCi] = await Promise.all([
              readMergedDetail(slug, m.pr.number, gh, details, errors),
              readCi(ci, m.pr.mergeCommitSha),
            ]);
            return { ...m.pr, ...(detail ?? {}), ...mergeCi };
          }),
        ]);
        pullRequests = pullRequests.map((pr, i) => ({ ...pr, ...openCi[i] }));
        const { merge, error: mergeError } = await mergeRead;
        if (mergeError !== null) errors.record(mergeError);
        if (mergedListed) {
          details.prune(slug, new Set(mergedListed.map((m) => String(m.pr.number))));
          if (defaultBranch) {
            rollups.prune(slug, new Set([
              ...listed.map((pr) => pr.headSha),
              ...mergedListed.flatMap((m) => (m.pr.mergeCommitSha ? [m.pr.mergeCommitSha] : [])),
              defaultBranch.sha,
            ]));
          }
        }
        return {
          slug, sharedWith, pullRequests, merge, recentlyMerged, defaultBranch,
          ciError: errors.message, truncated: mergedRead?.truncated ?? false, release, releaseError, error: null,
        };
      } catch (err) {
        return {
          slug, sharedWith, pullRequests: [], merge: null, recentlyMerged: [], defaultBranch: null, ciError: null, truncated: false,
          release: null, releaseError: null, error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  filesCache.save();
  rollups.save();
  details.save();
  npmVersions.save();

  const partial = repositories.some((r) => r.error !== null);
  return { project, viewer: await viewerRead, repositories, partial };
}

export const MERGE_METHODS = ['rebase', 'squash', 'merge'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export interface ProjectPrMergeResult {
  repo: string;
  number: number;
  method: MergeMethod;
  merged: boolean;
  sha: string | null;
  message: string;
}

interface RepoMergeSettings {
  methods: MergeMethod[];
  viewerIsAdmin: boolean;
  autoMergeAllowed: boolean;
  defaultBranch: string;
}

async function readRepoMergeSettings(repo: string, gh: GhExec): Promise<RepoMergeSettings> {
  const row = JSON.parse((await gh([
    'api', `repos/${repo}`, '--cache', '1h',
    '--jq', '{rebase: .allow_rebase_merge, squash: .allow_squash_merge, merge: .allow_merge_commit, ' +
      'admin: (.permissions.admin // false), autoMerge: (.allow_auto_merge // false), defaultBranch: (.default_branch // "")}',
  ])).trim()) as Record<MergeMethod, boolean | undefined> & { admin?: boolean; autoMerge?: boolean; defaultBranch?: string };
  return {
    methods: MERGE_METHODS.filter((m) => row[m]),
    viewerIsAdmin: row.admin === true,
    autoMergeAllowed: row.autoMerge === true,
    defaultBranch: row.defaultBranch ?? '',
  };
}

export async function defaultMergeMethod(repo: string, gh: GhExec = ghExec): Promise<MergeMethod> {
  const method = (await readRepoMergeSettings(repo, gh)).methods[0];
  if (!method) throw new Error(`${repo} allows no merge method this token can see.`);
  return method;
}

export async function readRepoMergeAbility(repo: string, gh: GhExec = ghExec): Promise<RepoMergeAbility> {
  const settings = await readRepoMergeSettings(repo, gh);
  let adminBypass = false;
  if (settings.viewerIsAdmin) {
    if (!settings.defaultBranch) throw new Error(`${repo} reports no default branch`);
    try {
      const enforced = (await gh([
        'api', `repos/${repo}/branches/${settings.defaultBranch}/protection`, '--cache', '1h', '--jq', '.enforce_admins.enabled',
      ])).trim();
      adminBypass = enforced !== 'true';
    } catch (err) {
      if (!/\(HTTP 404\)/.test(ghFailure(err))) throw err;
      adminBypass = true;
    }
  }
  return {
    viewerIsAdmin: settings.viewerIsAdmin,
    adminBypass,
    autoMergeAllowed: settings.autoMergeAllowed,
    methods: settings.methods,
  };
}

export function ghFailure(err: unknown): string {
  const stderr = (err as { stderr?: unknown })?.stderr;
  const text = typeof stderr === 'string' && stderr.trim() ? stderr : err instanceof Error ? err.message : String(err);
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /\(HTTP \d{3}\)/.test(l)) ?? lines[0] ?? text;
  return line.replace(/^gh:\s*/, '');
}

export const BLOCKED_WITHOUT_ADMIN = 'Blocked by branch protection; pass --admin to merge as an admin';

const MERGEABLE_STATES = new Set(['clean', 'unstable', 'has_hooks']);

export function mergeRefusalWithoutAdmin(state: string): string | null {
  if (MERGEABLE_STATES.has(state)) return null;
  switch (state) {
    case 'blocked': return BLOCKED_WITHOUT_ADMIN;
    case 'dirty': return 'Has merge conflicts';
    case 'behind': return 'The branch is behind its base; update it, or pass --admin to merge as an admin';
    case 'draft': return 'Draft: mark it ready for review first';
    default: return 'GitHub is still computing mergeability; try again in a moment';
  }
}

export function readableMergeRefusal(message: string): string {
  const checks = /Required status checks? (.+?) (?:is|are) expected/i.exec(message);
  if (checks && /\(HTTP 405\)/.test(message)) {
    const names = checks[1].replace(/"/g, '');
    const plural = names.includes(',') ? 'checks' : 'check';
    return `Required ${plural} ${names} ${plural === 'check' ? "hasn't" : "haven't"} passed (HTTP 405)`;
  }
  if (/\(HTTP 409\)/.test(message)) return 'The head moved since you looked; reload the PR and try again (HTTP 409)';
  return message;
}

// The reviewed SHA is sent to GitHub so a moved head fails instead of merging unseen code.
export async function mergeProjectPr(
  repo: string,
  number: number,
  sha: string,
  method: MergeMethod | undefined,
  opts: { admin?: boolean } = {},
  gh: GhExec = ghExec,
): Promise<ProjectPrMergeResult> {
  let chosen: MergeMethod;
  try {
    chosen = method ?? await defaultMergeMethod(repo, gh);
  } catch (err) {
    return { repo, number, method: method ?? MERGE_METHODS[0], merged: false, sha: null, message: ghFailure(err) };
  }
  if (!opts.admin) {
    let state: string;
    try {
      state = (await gh(['api', `repos/${repo}/pulls/${number}`, '--jq', '.mergeable_state // ""'])).trim();
    } catch (err) {
      return { repo, number, method: chosen, merged: false, sha: null, message: ghFailure(err) };
    }
    const refusal = mergeRefusalWithoutAdmin(state);
    if (refusal !== null) return { repo, number, method: chosen, merged: false, sha: null, message: refusal };
  }
  let out: string;
  try {
    out = await gh([
      'api', '-X', 'PUT', `repos/${repo}/pulls/${number}/merge`,
      '-f', `sha=${sha}`, '-f', `merge_method=${chosen}`, '--jq', '.sha',
    ]);
  } catch (err) {
    return { repo, number, method: chosen, merged: false, sha: null, message: readableMergeRefusal(ghFailure(err)) };
  }
  return { repo, number, method: chosen, merged: true, sha: out.trim() || null, message: 'Merged' };
}

// Re-read and pin the live head for every mutation that depends on review.
function assertHeadIs(repo: string, number: number, live: string, seen: string): string {
  if (!live.toLowerCase().startsWith(seen.toLowerCase())) {
    throw new Error(`${repo}#${number} moved to ${live.slice(0, 7)} since you looked at ${seen.slice(0, 7)}; reload it and try again.`);
  }
  return live;
}

export interface ProjectPrAutoMergeResult {
  repo: string;
  number: number;
  enabled: boolean;
  method: MergeMethod | null;
  message: string;
}

export async function setProjectPrAutoMerge(
  repo: string,
  number: number,
  opts: { enable: true; sha: string; method?: MergeMethod } | { enable: false },
  gh: GhExec = ghExec,
): Promise<ProjectPrAutoMergeResult> {
  const base = { repo, number };
  let pr: { sha: string; nodeId: string; state: string; merged: boolean; autoMethod: string | null };
  try {
    pr = JSON.parse((await gh([
      'api', `repos/${repo}/pulls/${number}`, '--jq',
      '{sha: .head.sha, nodeId: .node_id, state: .state, merged: (.merged // false), autoMethod: (.auto_merge.merge_method // null)}',
    ])).trim()) as typeof pr;
  } catch (err) {
    return { ...base, enabled: false, method: null, message: ghFailure(err) };
  }
  const current = { enabled: pr.autoMethod !== null, method: (pr.autoMethod as MergeMethod | null) };
  if (pr.state !== 'open') return { ...base, ...current, message: pr.merged ? 'Already merged' : 'The pull request is closed' };
  if (!opts.enable) {
    if (!current.enabled) return { ...base, enabled: false, method: null, message: 'Auto-merge was not on' };
    try {
      await gh([
        'api', 'graphql',
        '-f', 'query=mutation($id: ID!) { disablePullRequestAutoMerge(input: {pullRequestId: $id}) { pullRequest { autoMergeRequest { mergeMethod } } } }',
        '-f', `id=${pr.nodeId}`,
        '--jq', '.data.disablePullRequestAutoMerge.pullRequest.autoMergeRequest',
      ]);
    } catch (err) {
      return { ...base, ...current, message: ghFailure(err) };
    }
    return { ...base, enabled: false, method: null, message: 'Auto-merge turned off' };
  }
  let head: string;
  let chosen: MergeMethod;
  try {
    if (!opts.sha) throw new Error('Auto-merge is pinned to the head you reviewed; pass its SHA.');
    head = assertHeadIs(repo, number, pr.sha, opts.sha);
    chosen = opts.method ?? await defaultMergeMethod(repo, gh);
  } catch (err) {
    return { ...base, ...current, message: ghFailure(err) };
  }
  try {
    await gh([
      'api', 'graphql',
      '-f', 'query=mutation($id: ID!, $method: PullRequestMergeMethod!, $head: GitObjectID!) { enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $head}) { pullRequest { autoMergeRequest { mergeMethod } } } }',
      '-f', `id=${pr.nodeId}`,
      '-f', `method=${chosen.toUpperCase()}`,
      '-f', `head=${head}`,
      '--jq', '.data.enablePullRequestAutoMerge.pullRequest.autoMergeRequest.mergeMethod',
    ]);
  } catch (err) {
    return { ...base, ...current, message: ghFailure(err) };
  }
  return { ...base, enabled: true, method: chosen, message: `Auto-merge on (${chosen}); it merges once the required checks pass` };
}

export interface ProjectPrReadyResult {
  repo: string;
  number: number;
  ready: boolean;
  sha: string | null;
  message: string;
}

export async function markProjectPrReady(
  repo: string,
  number: number,
  sha: string | undefined,
  gh: GhExec = ghExec,
): Promise<ProjectPrReadyResult> {
  let head: { sha: string; draft: boolean; nodeId: string; state: string; merged: boolean };
  try {
    head = JSON.parse((await gh([
      'api', `repos/${repo}/pulls/${number}`, '--jq',
      '{sha: .head.sha, draft: (.draft // false), nodeId: .node_id, state: .state, merged: (.merged // false)}',
    ])).trim()) as { sha: string; draft: boolean; nodeId: string; state: string; merged: boolean };
    if (sha) assertHeadIs(repo, number, head.sha, sha);
  } catch (err) {
    return { repo, number, ready: false, sha: null, message: ghFailure(err) };
  }
  if (head.state !== 'open') {
    return { repo, number, ready: false, sha: head.sha, message: head.merged ? 'Already merged' : 'The pull request is closed' };
  }
  if (!head.draft) return { repo, number, ready: true, sha: head.sha, message: 'Already ready for review' };
  try {
    await gh([
      'api', 'graphql',
      '-f', 'query=mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }',
      '-f', `id=${head.nodeId}`,
      '--jq', '.data.markPullRequestReadyForReview.pullRequest.isDraft',
    ]);
  } catch (err) {
    return { repo, number, ready: false, sha: head.sha, message: ghFailure(err) };
  }
  return { repo, number, ready: true, sha: head.sha, message: 'Marked ready for review' };
}

export const OWN_PR_APPROVAL = "GitHub doesn't let you approve your own pull request";

export interface ProjectPrReviewResult {
  repo: string;
  number: number;
  event: 'APPROVE';
  submitted: boolean;
  sha: string | null;
  id: number | null;
  url: string | null;
  message: string;
}

export async function approveProjectPr(
  repo: string,
  number: number,
  sha: string,
  body: string | undefined,
  gh: GhExec = ghExec,
  viewerLogin: () => Promise<string | null> = async () => (await cachedViewer())?.login ?? null,
): Promise<ProjectPrReviewResult> {
  const base = { repo, number, event: 'APPROVE' as const };
  let commitId: string;
  try {
    const [live, viewer] = await Promise.all([
      gh(['api', `repos/${repo}/pulls/${number}`, '--jq', '{sha: .head.sha, author: (.user.login // "")}'])
        .then((out) => JSON.parse(out.trim()) as { sha: string; author: string }),
      viewerLogin(),
    ]);
    if (viewer && live.author && viewer.toLowerCase() === live.author.toLowerCase()) {
      return { ...base, submitted: false, sha: live.sha, id: null, url: null, message: OWN_PR_APPROVAL };
    }
    if (!live.sha) throw new Error(`no head SHA for ${repo}#${number}`);
    commitId = assertHeadIs(repo, number, live.sha, sha);
  } catch (err) {
    return { ...base, submitted: false, sha: null, id: null, url: null, message: ghFailure(err) };
  }
  // Attach approval to the exact reviewed commit, not whichever head wins a race.
  const args = ['api', '-X', 'POST', `repos/${repo}/pulls/${number}/reviews`, '-f', 'event=APPROVE', '-f', `commit_id=${commitId}`];
  if (body) args.push('-f', `body=${body}`);
  let posted: { id?: number; url?: string };
  try {
    posted = JSON.parse((await gh([...args, '--jq', '{id, url: .html_url}'])).trim()) as { id?: number; url?: string };
  } catch (err) {
    return { ...base, submitted: false, sha: commitId, id: null, url: null, message: ghFailure(err) };
  }
  return { ...base, submitted: true, sha: commitId, id: posted.id ?? null, url: posted.url || null, message: 'Approved' };
}

export interface ProjectPrCommentResult {
  repo: string;
  number: number;
  commented: boolean;
  id: number | null;
  url: string | null;
  message: string;
}

export async function commentOnProjectPr(
  repo: string,
  number: number,
  body: string,
  gh: GhExec = ghExec,
): Promise<ProjectPrCommentResult> {
  let posted: { id?: number; url?: string };
  try {
    posted = JSON.parse((await gh([
      'api', '-X', 'POST', `repos/${repo}/issues/${number}/comments`, '-f', `body=${body}`, '--jq', '{id, url: .html_url}',
    ])).trim()) as { id?: number; url?: string };
  } catch (err) {
    return { repo, number, commented: false, id: null, url: null, message: ghFailure(err) };
  }
  return { repo, number, commented: true, id: posted.id ?? null, url: posted.url || null, message: 'Commented' };
}
