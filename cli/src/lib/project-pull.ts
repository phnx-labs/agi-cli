
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { expandLocalHome } from './project-root.js';
import { type ProjectRepoTarget } from './projects.js';
import { type RemoteAgentsJsonParseResult } from './remote-agents-json.js';
import { getRepoCommit, getRemoteUrl, pullRepo } from './git.js';
import { parseOwnerRepoFromRemote } from './registry.js';
import { machineId } from './machine-id.js';


export type ProjectPullStatus = 'updated' | 'current' | 'missing' | 'blocked' | 'failed';

export interface ProjectPullResult {
  host: string;
  path: string;
  expectedSlug?: string;
  status: ProjectPullStatus;
  branch?: string;
  upstream?: string;
  before?: string;
  after?: string;
  message?: string;
}

interface ProjectPullEnvelope {
  schemaVersion: 1;
  kind: 'project-pull';
  machine: string;
  targetFingerprint: string;
  results: ProjectPullResult[];
}


export function fingerprintTargets(targets: ProjectRepoTarget[]): string {

  const lines = targets
    .map((t) => `${t.path}\0${t.expectedSlug ?? ''}`)
    .sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}


export function encodePullTargets(targets: ProjectRepoTarget[]): string {

  return JSON.stringify(
    targets.map((t) => (t.expectedSlug === undefined ? { path: t.path } : { path: t.path, expectedSlug: t.expectedSlug })),
  );
}

export function pullLocalArgs(targets: ProjectRepoTarget[]): string[] {
  return ['projects', 'pull-local', '--targets', encodePullTargets(targets)];
}

export function decodePullTargets(raw: string): ProjectRepoTarget[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('expected a JSON array of targets');
  return parsed.map((x, i) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error(`target ${i} is not an object`);
    const o = x as Record<string, unknown>;
    if (typeof o.path !== 'string' || o.path.length === 0) throw new Error(`target ${i} has no "path"`);
    if (o.expectedSlug !== undefined && typeof o.expectedSlug !== 'string') {
      throw new Error(`target ${i} has a non-string "expectedSlug"`);
    }
    return o.expectedSlug === undefined
      ? { path: o.path }
      : { path: o.path, expectedSlug: o.expectedSlug as string };
  });
}


export async function pullProjectTargets(
  targets: ProjectRepoTarget[],
  host: string = machineId(),
): Promise<ProjectPullResult[]> {

  const results: ProjectPullResult[] = [];

  for (const target of targets) {
    const absPath = expandLocalHome(target.path);

    if (!fs.existsSync(absPath) || !fs.existsSync(path.join(absPath, '.git'))) {
      results.push({
        host,
        path: target.path,
        expectedSlug: target.expectedSlug,
        status: 'missing',
        message: 'Checkout not present on this device',
      });
      continue;
    }

    if (target.expectedSlug) {
      const remoteUrl = await getRemoteUrl(absPath);
      if (remoteUrl === null) {
        results.push({
          host,
          path: target.path,
          expectedSlug: target.expectedSlug,
          status: 'blocked',
          message: `Slug verification failed: no origin remote found (expected ${target.expectedSlug})`,
        });
        continue;
      }
      const actualSlug = parseOwnerRepoFromRemote(remoteUrl);
      if (actualSlug === null) {
        results.push({
          host,
          path: target.path,
          expectedSlug: target.expectedSlug,
          status: 'blocked',
          message: `Slug verification failed: cannot parse remote URL "${remoteUrl}" (expected ${target.expectedSlug})`,
        });
        continue;
      }
      if (actualSlug.toLowerCase() !== target.expectedSlug.toLowerCase()) {
        results.push({
          host,
          path: target.path,
          expectedSlug: target.expectedSlug,
          status: 'blocked',
          message: `Slug mismatch: expected ${target.expectedSlug}, found ${actualSlug}`,
        });
        continue;
      }
    }

    const beforeRaw = await getRepoCommit(absPath);
    const before = beforeRaw === 'unknown' ? undefined : beforeRaw;

    let pull: Awaited<ReturnType<typeof pullRepo>>;
    try {

      pull = await pullRepo(absPath, { mode: 'default-branch-fast-forward' });
    } catch (err) {
      results.push({
        host,
        path: target.path,
        expectedSlug: target.expectedSlug,
        status: 'failed',
        before,
        message: (err as Error).message,
      });
      continue;
    }

    if (!pull.success) {
      results.push({
        host,
        path: target.path,
        expectedSlug: target.expectedSlug,
        status: 'blocked',
        branch: pull.branch,
        before,
        message: pull.error,
      });
      continue;
    }

    const after = pull.commit;
    const status: ProjectPullStatus = before !== undefined && before !== after ? 'updated' : 'current';
    results.push({
      host,
      path: target.path,
      expectedSlug: target.expectedSlug,
      status,
      branch: pull.branch,
      before,
      after,
    });
  }

  return results;
}


export function buildPullEnvelope(
  results: ProjectPullResult[],
  targets: ProjectRepoTarget[],
): ProjectPullEnvelope {
  return {
    schemaVersion: 1,
    kind: 'project-pull',
    machine: machineId(),
    targetFingerprint: fingerprintTargets(targets),
    results,
  };
}


export function parseProjectPullEnvelope(
  stdout: string,
  machine: string,
  opts: { expectedFingerprint?: string } = {},
): RemoteAgentsJsonParseResult<ProjectPullResult> {

  const rejected = { items: [] as ProjectPullResult[], valid: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return rejected;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return rejected;
  const env = parsed as Record<string, unknown>;

  if (env.schemaVersion !== 1) return rejected;
  if (env.kind !== 'project-pull') return rejected;
  if (typeof env.machine !== 'string' || env.machine !== machine) return rejected;
  if (opts.expectedFingerprint !== undefined && env.targetFingerprint !== opts.expectedFingerprint) return rejected;
  if (!Array.isArray(env.results)) return rejected;

  const validStatuses = new Set<string>(['updated', 'current', 'missing', 'blocked', 'failed']);
  const items: ProjectPullResult[] = [];
  for (const x of env.results as unknown[]) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return rejected;
    const r = x as Record<string, unknown>;
    if (typeof r.path !== 'string') return rejected;
    if (typeof r.status !== 'string' || !validStatuses.has(r.status)) return rejected;
    const result: ProjectPullResult = {
      host: machine,
      path: r.path,
      status: r.status as ProjectPullStatus,
    };
    if (typeof r.expectedSlug === 'string') result.expectedSlug = r.expectedSlug;
    if (typeof r.branch === 'string') result.branch = r.branch;
    if (typeof r.upstream === 'string') result.upstream = r.upstream;
    if (typeof r.before === 'string') result.before = r.before;
    if (typeof r.after === 'string') result.after = r.after;
    if (typeof r.message === 'string') result.message = r.message;
    items.push(result);
  }
  return { items, valid: true };
}


export function projectPullComplete(results: ProjectPullResult[]): boolean {
  return results.every((r) => r.status !== 'blocked' && r.status !== 'failed');
}


function statusIcon(s: ProjectPullStatus): string {
  switch (s) {
    case 'updated': return chalk.green('✓');
    case 'current': return chalk.dim('·');
    case 'missing': return chalk.yellow('?');
    case 'blocked': return chalk.red('✗');
    case 'failed':  return chalk.red('✗');
  }
}

function statusLabel(r: ProjectPullResult): string {
  switch (r.status) {
    case 'updated': {
      const diff = r.before && r.after ? chalk.dim(` ${r.before}→${r.after}`) : '';
      const br = r.branch ? ` (${r.branch})` : '';
      return `${chalk.green('updated')}${br}${diff}`;
    }
    case 'current': {
      const br = r.branch ? chalk.dim(` (${r.branch})`) : '';
      return `${chalk.dim('already current')}${br}`;
    }
    case 'missing':
      return chalk.yellow('missing — skipped');
    case 'blocked':
      return `${chalk.red('blocked')}${r.message ? chalk.dim(` — ${r.message}`) : ''}`;
    case 'failed':
      return `${chalk.red('failed')}${r.message ? chalk.dim(` — ${r.message}`) : ''}`;
  }
}

export function printProjectPullSummary(
  projectName: string,
  results: ProjectPullResult[],
  unavailableDevices: string[],
  unverifiedDevices: string[] = [],
): void {
  const counts: Record<ProjectPullStatus, number> = { updated: 0, current: 0, missing: 0, blocked: 0, failed: 0 };
  for (const r of results) counts[r.status]++;

  console.log(chalk.bold(`${projectName}`));

  const hosts = [...new Set(results.map((r) => r.host))].sort();
  for (const host of hosts) {
    const hostResults = results.filter((r) => r.host === host);
    const hasProblems = hostResults.some((r) => r.status === 'blocked' || r.status === 'failed');
    const hostLabel = hasProblems ? chalk.red(host) : chalk.cyan(host);
    console.log(`  ${hostLabel}`);
    for (const r of hostResults) {
      console.log(`    ${statusIcon(r.status)} ${chalk.dim(r.path)} ${statusLabel(r)}`);
    }
  }

  if (unavailableDevices.length > 0) {
    console.log(chalk.gray(`  unavailable: ${unavailableDevices.join(', ')}`));
  }
  if (unverifiedDevices.length > 0) {
    console.log(chalk.red(`  unverified: ${unverifiedDevices.join(', ')} — answered, but the result could not be verified; their checkouts may have changed`));
  }

  const parts: string[] = [];
  if (counts.updated) parts.push(chalk.green(`${counts.updated} updated`));
  if (counts.current) parts.push(chalk.dim(`${counts.current} current`));
  if (counts.missing) parts.push(chalk.yellow(`${counts.missing} missing`));
  if (counts.blocked) parts.push(chalk.red(`${counts.blocked} blocked`));
  if (counts.failed) parts.push(chalk.red(`${counts.failed} failed`));
  console.log(`  ${parts.join(chalk.dim(' · '))}`);
}
