import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyClaudeLine, hydrateClaudeParseState, initClaudeParseState, serializeClaudeParserState } from './discover.js';

const TESTDATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata', 'touched');

function fixtureLines(name: string, replace: Record<string, string> = {}): unknown[] {
  let text = fs.readFileSync(path.join(TESTDATA, name), 'utf-8');
  for (const [from, to] of Object.entries(replace)) text = text.replaceAll(from, to);
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function scan(lines: unknown[]) {
  const state = initClaudeParseState();
  for (const line of lines) applyClaudeLine(state, line);
  return serializeClaudeParserState(state, 0);
}

const pr = (repo: string, number: number, action: string) => ({ url: `https://github.com/${repo}/pull/${number}`, number, repo, action });

describe('touchedPrs: the PRs a Claude session acted on but did not open', () => {
  it('reads gh pr verbs after cd and env prefixes, with --repo, -R, --repo= and a PR URL', () => {
    expect(scan(fixtureLines('gh-flags-and-urls.jsonl')).touchedPrs).toEqual([
      pr('acme/api', 8, 'edited'),
      pr('acme/cli', 3, 'commented'),
      pr('acme/web', 5, 'reviewed'),
      pr('acme/api', 12, 'merged'),
    ]);
  });

  it('reads agents projects prs merge|review by --repo and --number, behind a $(…) prefix and a pipe; --help is not an action', () => {
    expect(scan(fixtureLines('agents-prs-merge.jsonl')).touchedPrs).toEqual([
      pr('phnx-labs/agi-cli', 3995, 'merged'),
      pr('phnx-labs/agi-ext', 171, 'merged'),
    ]);
  });

  it('keeps the last action per PR, newest first', () => {
    expect(scan(fixtureLines('last-action-wins.jsonl')).touchedPrs).toEqual([
      pr('acme/api', 12, 'merged'),
      pr('acme/api', 20, 'reviewed'),
    ]);
  });

  it('counts only a call that ran and succeeded: not prose, an error result, --auto, a background call, an echo or a heredoc body', () => {
    const state = scan(fixtureLines('not-run.jsonl'));
    expect(state.touchedPrs).toEqual([]);
    expect(state.prUrls).toEqual(['https://github.com/acme/api/pull/82']);
  });

  it('leaves out a PR or ticket the session created itself, also when one command creates and merges it', () => {
    const state = scan(fixtureLines('created-excluded.jsonl'));
    expect(state.prUrls).toEqual(['https://github.com/acme/api/pull/50', 'https://github.com/acme/api/pull/51']);
    expect(state.createdTickets).toEqual(['PHNX-900']);
    expect(state.touchedPrs).toEqual([]);
    expect(state.touchedTickets).toEqual([{ id: 'PHNX-12', action: 'commented' }]);
  });

  it('a call whose result lands after a checkpoint still counts', () => {
    const lines = fixtureLines('last-action-wins.jsonl');
    const state = initClaudeParseState();
    for (const line of lines.slice(0, 6)) applyClaudeLine(state, line);
    const resumed = hydrateClaudeParseState(JSON.parse(JSON.stringify(serializeClaudeParserState(state, 0))));
    for (const line of lines.slice(6)) applyClaudeLine(resumed, line);
    expect(serializeClaudeParserState(resumed, 0).touchedPrs).toEqual([
      pr('acme/api', 12, 'merged'),
      pr('acme/api', 20, 'reviewed'),
    ]);
  });
});

describe('touchedPrs: a bare PR number takes its repo from the git remote of the directory it ran in', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-touched-'));
    fs.mkdirSync(path.join(root, 'repo', 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'plain'));
    execFileSync('git', ['init', '-q', path.join(root, 'repo')]);
    execFileSync('git', ['-C', path.join(root, 'repo'), 'remote', 'add', 'origin', 'git@github.com:acme/infra.git']);
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("the line's cwd, a leading cd, and nothing when the directory has no GitHub remote", () => {
    const state = scan(fixtureLines('repo-from-git-remote.jsonl', {
      __REPO__: path.join(root, 'repo'),
      __NOT_A_REPO__: path.join(root, 'plain'),
    }));
    expect(state.touchedPrs).toEqual([
      pr('acme/infra', 9, 'closed'),
      pr('acme/infra', 33, 'checked out'),
    ]);
  });
});

describe('touchedTickets: Linear tickets a session updated', () => {
  it('linear update sets the action from its flags, per id, newest first; linear tasks <ID> is a read', () => {
    expect(scan(fixtureLines('linear-update.jsonl')).touchedTickets).toEqual([
      { id: 'PHNX-1', action: 'done' },
      { id: 'PHNX-4', action: 'updated' },
      { id: 'PHNX-3', action: 'moved to In Review' },
      { id: 'PHNX-2', action: 'started' },
    ]);
  });
});
