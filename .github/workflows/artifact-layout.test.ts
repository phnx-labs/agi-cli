/** Pin the `.agents/` durable-output layout: every durable agent artifact lives under
 * `.agents/artifacts/<yyyy-mm-dd>/`. `.agents/reports/`, `.agents/plans/` and `.agents/viz/` were
 * folded in (0e0da8e21) and must not return. Assertions run on git-tracked paths. */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const RETIRED = ['reports', 'plans', 'viz'];

function trackedAgentsPaths(): string[] {
  return execFileSync('git', ['ls-files', '--', '.agents/'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

describe('.agents/ durable-output layout', () => {
  const tracked = trackedAgentsPaths();

  for (const dir of RETIRED) {
    test(`.agents/${dir}/ stays retired — file it under .agents/artifacts/<yyyy-mm-dd>/`, () => {
      expect(tracked.filter((p) => p.startsWith(`.agents/${dir}/`))).toEqual([]);
    });
  }

  test('every committed artifact sits in a yyyy-mm-dd directory', () => {
    const stray = tracked
      .filter((p) => p.startsWith('.agents/artifacts/'))
      .filter((p) => !/^\.agents\/artifacts\/\d{4}-\d{2}-\d{2}\//.test(p));
    expect(stray).toEqual([]);
  });
});
