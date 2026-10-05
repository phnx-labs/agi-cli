import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checkContent,
  checkFilename,
  formatError,
  inspectFiles,
  isUnderPublicArtifacts,
} from './guard-artifacts-confidential';

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'guard-test@example.invalid',
      GIT_AUTHOR_NAME: 'Guard Test',
      GIT_COMMITTER_EMAIL: 'guard-test@example.invalid',
      GIT_COMMITTER_NAME: 'Guard Test',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new Error(Buffer.from(proc.stderr).toString('utf8'));
  }
  return Buffer.from(proc.stdout).toString('utf8').trim();
}

function writeFixture(root: string, file: string, body: string): void {
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}

describe('isUnderPublicArtifacts', () => {
  test.each([
    ['.agents/artifacts/2026-08-27/plan.md', true],
    ['.agents/artifacts/2026-08-27/gtm-strategy.md', true],
    ['.agents/artifacts/private/2026-08-27/gtm-strategy.md', false],
    ['.agents/worktrees/foo/plan.md', false],
    ['scripts/guard-artifacts-confidential.ts', false],
  ])('%s -> %s', (file, expected) => {
    expect(isUnderPublicArtifacts(file)).toBe(expected);
  });
});

describe('checkFilename', () => {
  test.each([
    ['gtm-strategy.md', true],
    ['monetization-plan.md', true],
    ['pricing-model-comparison.md', true],
    ['revenue-forecast.md', true],
    ['launch-venues.md', true],
    ['github-stars-playbook.md', true],
    ['competitor-intel.md', true],
    ['go-to-market-plan.md', true],
    ['arr-targets.md', true],
    ['mrr-goals.md', true],
    ['churn-analysis.md', true],
    ['plan-architecture.md', false],
    ['report-sessions-bug.md', false],
    ['dataviz-token-usage.svg', false],
    ['array-buffer-fix.md', false],
  ])('%s filename flagged? %s', (name, flagged) => {
    const result = checkFilename(name);
    if (flagged) {
      expect(result).not.toBeNull();
    } else {
      expect(result).toBeNull();
    }
  });
});

describe('checkContent', () => {
  test('flags explicit strategy phrases', () => {
    expect(checkContent('Our GTM motion targets indie hackers.')).toMatch(/GTM/);
    expect(checkContent('Monetization strategy: usage-based tiers.')).toMatch(/monetization/);
    expect(checkContent('Pricing tier breakdown for teams.')).toMatch(/pricing tier/);
    expect(checkContent('Go-to-market plan for Q3.')).toMatch(/go-to-market/);
  });

  test('flags competitor intelligence phrases', () => {
    expect(checkContent('Competitor intel shows Cursor charges $20/mo.')).toMatch(/competitor intel/);
    expect(checkContent('Competitive intelligence on OpenCode pricing.')).toMatch(/competitive intelligence/);
  });

  test('flags dollar figures next to strategy words', () => {
    expect(checkContent('We project $1.2M ARR by year end.')).toMatch(/dollar figure/);
    expect(checkContent('MRR is currently $50k and churn is 2%.')).toMatch(/dollar figure/);
    expect(checkContent('Pricing starts at $10/seat for the team tier.')).toMatch(/dollar figure/);
  });

  test('does not flag engineering artifacts without strategy markers', () => {
    expect(checkContent('This dataviz shows token usage across workers.')).toBeNull();
    expect(checkContent('The array buffer grew to $0 because the test freed it.')).toBeNull();
    expect(checkContent('Refactor churn-test helper to use shared fixtures.')).toBeNull();
  });

  test('does not flag isolated dollar figures or isolated strategy words', () => {
    expect(checkContent('The benchmark cost $0.00 to run.')).toBeNull();
    expect(checkContent('We discussed revenue in the abstract.')).toBeNull();
  });
});

describe('inspectFiles', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'guard-artifacts-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('reproduces the leak: sensitive file under public artifacts fails', () => {
    const files = ['.agents/artifacts/2026-08-27/gtm-strategy.md'];
    writeFixture(tmp, files[0]!, '# GTM strategy\n\nTarget indie hackers.');
    const violations = inspectFiles(tmp, files);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.file).toBe(files[0]);
    expect(violations[0]!.reason).toBe('filename');
  });

  test('reproduces the leak: content-only strategy with dollar figure fails', () => {
    const files = ['.agents/artifacts/2026-08-27/q3-plan.md'];
    writeFixture(tmp, files[0]!, 'We project $1.2M ARR by year end.');
    const violations = inspectFiles(tmp, files);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.reason).toBe('content');
  });

  test('legitimate engineering artifact passes', () => {
    const files = ['.agents/artifacts/2026-08-27/plan-ci-release-near-instant.md'];
    writeFixture(tmp, files[0]!, '# CI release latency plan\n\nKeep the required PR gate under 90s.');
    const violations = inspectFiles(tmp, files);
    expect(violations).toHaveLength(0);
  });

  test('dataviz / report artifact passes without strategy markers', () => {
    const files = [
      '.agents/artifacts/2026-08-27/sessions-dataviz.svg',
      '.agents/artifacts/2026-08-27/report-usage.md',
    ];
    writeFixture(tmp, files[0]!, '<svg><text>sessions active over time</text></svg>');
    writeFixture(tmp, files[1]!, '# Usage report\n\nMedian token burn per session.');
    const violations = inspectFiles(tmp, files);
    expect(violations).toHaveLength(0);
  });

  test('sensitive file under private/ passes', () => {
    const files = ['.agents/artifacts/private/2026-08-27/gtm-strategy.md'];
    writeFixture(tmp, files[0]!, '# Secret GTM strategy\n\n$1.2M ARR target.');
    const violations = inspectFiles(tmp, files);
    expect(violations).toHaveLength(0);
  });
});

describe('end-to-end git diff guard', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'guard-artifacts-repo-'));
    git(tmp, 'init', '--quiet');
    git(tmp, 'config', 'user.email', 'guard-test@example.invalid');
    git(tmp, 'config', 'user.name', 'Guard Test');
    writeFixture(tmp, 'README.md', '# repo\n');
    git(tmp, 'add', '.');
    git(tmp, 'commit', '--quiet', '-m', 'init');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('CLI run catches a leak in base..head range', () => {
    const base = git(tmp, 'rev-parse', 'HEAD');
    writeFixture(tmp, '.agents/artifacts/2026-08-27/gtm-strategy.md', '# GTM\n');
    git(tmp, 'add', '.');
    git(tmp, 'commit', '--quiet', '-m', 'leak');
    const head = git(tmp, 'rev-parse', 'HEAD');

    const proc = Bun.spawnSync({
      cmd: ['bun', join(import.meta.dir, 'guard-artifacts-confidential.ts'), '--base', base, '--head', head, '--repo-root', tmp],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(1);
    const stderr = Buffer.from(proc.stderr).toString('utf8');
    expect(stderr).toContain('gtm-strategy.md');
    expect(stderr).toContain('.agents/artifacts/private/');
  });

  test('CLI run passes for a legit artifact in base..head range', () => {
    const base = git(tmp, 'rev-parse', 'HEAD');
    writeFixture(tmp, '.agents/artifacts/2026-08-27/plan-refactor.md', '# Refactor plan\n');
    git(tmp, 'add', '.');
    git(tmp, 'commit', '--quiet', '-m', 'legit');
    const head = git(tmp, 'rev-parse', 'HEAD');

    const proc = Bun.spawnSync({
      cmd: ['bun', join(import.meta.dir, 'guard-artifacts-confidential.ts'), '--base', base, '--head', head, '--repo-root', tmp],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(0);
  });
});

describe('formatError', () => {
  test('points to private dir and quotes the AGENTS.md rule', () => {
    const text = formatError([{ file: '.agents/artifacts/2026-08-27/gtm.md', reason: 'filename', detail: 'filename matches sensitive signal: GTM' }]);
    expect(text).toContain('.agents/artifacts/private/');
    expect(text).toContain('AGENTS.md');
    expect(text).toContain('CLAUDE.md');
    expect(text).toContain('public');
  });
});
