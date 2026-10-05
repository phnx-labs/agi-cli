/** Pin ./ci.yml's matrix trigger policy: the OS x Node matrix is expensive (macOS 10x, Windows 2x)
 * and gates nothing (main requires `test` + `gitleaks`), so it stays off the release path:
 * nightly plus workflow_dispatch only, never on release/** branches or v* tags. */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CI_YML = readFileSync(join(import.meta.dir, 'ci.yml'), 'utf8');

/** Extract the top-level `on:` block (everything before `jobs:`). */
function onBlock(source: string): string {
  const start = source.search(/^on:\s*$/m);
  const jobs = source.search(/^jobs:\s*$/m);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(jobs).toBeGreaterThan(start);
  return source.slice(start, jobs);
}

describe('ci.yml cross-platform matrix trigger policy', () => {
  const on = onBlock(CI_YML);

  test('runs on a nightly schedule', () => {
    expect(on).toMatch(/schedule:\s*\n\s+- cron:\s*'[^']+'/);
  });

  test('is OFF the release path — no release/** push or pull_request trigger', () => {
    expect(on).not.toContain("branches: ['release/**']");
    expect(on).not.toMatch(/^\s*push:\s*$/m);
    expect(on).not.toMatch(/^\s*pull_request:\s*$/m);
  });

  test('v* tags do not trigger the matrix', () => {
    expect(on).not.toMatch(/^\s*tags:\s*/m);
    expect(on).not.toContain("tags: ['v*']");
    expect(on).not.toContain('tags: ["v*"]');
    expect(on).not.toContain('tags: [v*]');
  });

  test('workflow_dispatch remains for on-demand pre-release runs', () => {
    expect(on).toMatch(/^\s*workflow_dispatch:\s*$/m);
  });
});
