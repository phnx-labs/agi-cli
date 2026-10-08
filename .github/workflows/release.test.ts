import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'release.yml'), 'utf8');
const workflow = Bun.YAML.parse(source) as any;

describe('release workflow security boundary', () => {
  test('has one branch-push job and no pull-request entry point', () => {
    expect(workflow.on.push.branches).toEqual(['release/**']);
    expect(workflow.on.pull_request).toBeUndefined();
    expect(workflow.on.workflow_run).toBeUndefined();
    expect(Object.keys(workflow.jobs)).toEqual(['release']);
  });

  test('grants only the permissions needed for GitHub assets and npm OIDC', () => {
    expect(workflow.permissions).toEqual({ contents: 'write', 'id-token': 'write' });
    expect(workflow.jobs.release['runs-on']).toBe('ubuntu-latest');
  });

  test('serializes each version without cancelling an in-flight publish', () => {
    expect(workflow.concurrency.group).toBe('release-${{ github.ref_name }}');
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  });

  test('delegates the release to the executable script without a token secret', () => {
    const steps = workflow.jobs.release.steps as Array<Record<string, any>>;
    const release = steps.find((step) => step.name === 'Build, attest, install-smoke, and publish');
    expect(release?.run).toContain('scripts/release-ci.sh');
    expect(JSON.stringify(workflow)).not.toContain('NPM_TOKEN');
    expect(JSON.stringify(workflow)).not.toContain('NODE_AUTH_TOKEN');
  });
});
