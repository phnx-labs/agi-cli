
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeRepo,
  listMergeableRefs,
  projectRepoSlugs,
  selectListedMergeable,
  type GhExec,
} from './pr-mergeable.js';
import type { ProjectDef } from '../projects.js';
import type { StatusCheck } from './pr-verdict.js';

const execFileAsync = promisify(execFile);

const GREEN: StatusCheck[] = [
  { conclusion: 'SUCCESS', status: 'COMPLETED' },
  { conclusion: 'SKIPPED', status: 'COMPLETED' },
];

const APPROVE_2847 =
  '**Non-author review verdict: APPROVE**\n\nIndependent subagent review.';

function ghFromTable(table: Record<string, string>): GhExec {
  return async (args: string[]) => {
    const key = args.join(' ');
    if (!(key in table)) throw new Error(`unexpected gh ${key}`);
    return table[key];
  };
}

describe('projectRepoSlugs', () => {
  it('unions repo and repos[].slug, sorted unique', () => {
    const defs: ProjectDef[] = [
      {
        name: 'agents-cli',
        repo: 'phnx-labs/agents-cli',
        repos: [
          { slug: 'phnx-labs/agents-cli' },
          { slug: 'phnx-labs/.agents-system' },
        ],
      },
      { name: 'prix', repo: 'muqsitnawaz/agents' },
    ];
    expect(projectRepoSlugs(defs)).toEqual([
      'muqsitnawaz/agents',
      'phnx-labs/.agents-system',
      'phnx-labs/agents-cli',
    ]);
  });
});

describe('canonicalizeRepo', () => {
  it('follows the REST rename redirect so a renamed slug lists PRs', async () => {
    const gh = ghFromTable({
      'api repos/phnx-labs/agents-cli --cache 24h --jq .full_name':
        'phnx-labs/agi-cli\n',
    });
    expect(await canonicalizeRepo('phnx-labs/agents-cli', gh)).toBe('phnx-labs/agi-cli');
  });

  it('keeps the input slug when the repo read fails', async () => {
    const gh: GhExec = async () => { throw new Error('nope'); };
    expect(await canonicalizeRepo('acme/widgets', gh)).toBe('acme/widgets');
  });
});

describe('selectListedMergeable', () => {
  it('selects an approved+green PR and rejects an unapproved one', async () => {
    const repo = 'phnx-labs/agi-cli';
    const listed = [
      { number: 2847, reviewDecision: '', statusCheckRollup: GREEN },
      { number: 2849, reviewDecision: '', statusCheckRollup: GREEN },
    ];
    const gh = ghFromTable({
      [`api repos/${repo}/pulls/2847/reviews --cache 60s`]: '[]',
      [`api repos/${repo}/issues/2847/comments --cache 60s`]:
        JSON.stringify([{ body: APPROVE_2847 }]),
      [`api repos/${repo}/pulls/2849/reviews --cache 60s`]: '[]',
      [`api repos/${repo}/issues/2849/comments --cache 60s`]: '[]',
    });
    const selected = await selectListedMergeable(repo, listed, gh);
    expect(selected.map((p) => p.number)).toEqual([2847]);
  });

  it('does not fetch comments when reviewDecision is already APPROVED', async () => {
    const repo = 'phnx-labs/agi-cli';
    const listed = [
      { number: 1, reviewDecision: 'APPROVED', statusCheckRollup: GREEN },
    ];
    const gh: GhExec = async () => {
      throw new Error('must not call gh for an already-APPROVED PR');
    };
    const selected = await selectListedMergeable(repo, listed, gh);
    expect(selected.map((p) => p.number)).toEqual([1]);
  });

  it('skips a green PR whose checks are still pending without probing verdict', async () => {
    const repo = 'phnx-labs/agi-cli';
    const listed = [
      { number: 2, reviewDecision: '', statusCheckRollup: [{ conclusion: '', status: 'IN_PROGRESS' }] },
    ];
    const gh: GhExec = async () => {
      throw new Error('must not probe verdict for a non-green PR');
    };
    expect(await selectListedMergeable(repo, listed, gh)).toEqual([]);
  });
});

describe('listMergeableRefs', () => {
  it('canonicalizes the slug and prints owner/repo#n for an approved+green PR', async () => {
    const gh = ghFromTable({
      'api repos/phnx-labs/agents-cli --cache 24h --jq .full_name': 'phnx-labs/agi-cli\n',
      'pr list --repo phnx-labs/agi-cli --author @me --state open --limit 50 --json number,reviewDecision,statusCheckRollup':
        JSON.stringify([{ number: 2847, reviewDecision: '', statusCheckRollup: GREEN }]),
      'api repos/phnx-labs/agi-cli/pulls/2847/reviews --cache 60s': '[]',
      'api repos/phnx-labs/agi-cli/issues/2847/comments --cache 60s': JSON.stringify([{ body: APPROVE_2847 }]),
    });
    expect(await listMergeableRefs({ gh, repos: ['phnx-labs/agents-cli'] }))
      .toBe('phnx-labs/agi-cli#2847');
  });

  it('is empty when the only candidate is unapproved', async () => {
    const gh = ghFromTable({
      'api repos/phnx-labs/agi-cli --cache 24h --jq .full_name': 'phnx-labs/agi-cli\n',
      'pr list --repo phnx-labs/agi-cli --author @me --state open --limit 50 --json number,reviewDecision,statusCheckRollup':
        JSON.stringify([{ number: 2849, reviewDecision: '', statusCheckRollup: GREEN }]),
      'api repos/phnx-labs/agi-cli/pulls/2849/reviews --cache 60s': '[]',
      'api repos/phnx-labs/agi-cli/issues/2849/comments --cache 60s': '[]',
    });
    expect(await listMergeableRefs({ gh, repos: ['phnx-labs/agi-cli'] })).toBe('');
  });
});

describe('ghExec color env', () => {
  it('gh --json from this process is parseable even when FORCE_COLOR is set', async () => {
    const { ghExec } = await import('./pr-mergeable.js');
    try {
      const raw = await ghExec([
        'pr', 'list', '--repo', 'phnx-labs/agi-cli', '--author', '@me',
        '--state', 'open', '--limit', '1', '--json', 'number',
      ]);
      expect(raw.charCodeAt(0)).not.toBe(0x1b);
      expect(Array.isArray(JSON.parse(raw))).toBe(true);
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      expect(msg).not.toMatch(/not a git repository/);
      if (/gh|auth|rate limit|network/i.test(msg)) return;
      throw err;
    }
  });
});

describe('ghExec timeoutMs', () => {
  it('kills a gh that outlives the caller-supplied cap instead of the 30 s default', async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-mergeable-slowgh-'));
    const prevPath = process.env.PATH;
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nsleep 20\n', { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${prevPath}`;
    try {
      const { ghExec } = await import('./pr-mergeable.js');
      const started = Date.now();
      await expect(ghExec(['api', 'user'], { timeoutMs: 300 })).rejects.toMatchObject({ killed: true });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      process.env.PATH = prevPath;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe('live gh --repo from a non-repo cwd (RUSH-2848 defect 1)', () => {
  it('returns JSON, not "fatal: not a git repository"', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-mergeable-cwd-'));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env };
      env.CLICOLOR = '0';
      env.NO_COLOR = '1';
      env.GH_NO_COLOR = '1';
      env.GH_PAGER = 'cat';
      delete env.CLICOLOR_FORCE;
      delete env.FORCE_COLOR;
      delete env.GH_FORCE_TTY;
      const { stdout } = await execFileAsync(
        'gh',
        ['pr', 'list', '--repo', 'phnx-labs/agi-cli', '--author', '@me', '--state', 'open', '--limit', '1', '--json', 'number'],
        { cwd: tmp, timeout: 20_000, encoding: 'utf-8', env },
      );
      expect(Array.isArray(JSON.parse(String(stdout)))).toBe(true);
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      expect(msg).not.toMatch(/not a git repository/);
      if (/gh|auth|rate limit|network/i.test(msg)) return;
      throw err;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
