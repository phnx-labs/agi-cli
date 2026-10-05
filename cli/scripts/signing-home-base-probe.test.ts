/** The signing home-base preflight, run against the real probe. RUSH-2535: `release.sh --device
 * zion` ran tests, merged the PR and pushed the tag before discovering zion cannot sign.
 * The probe must fail an unprovisioned box before any git mutation. */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const PROBE = path.resolve(__dirname, 'signing-home-base-probe.sh');
const RELEASE = path.resolve(__dirname, 'release.sh');

/** Run the real probe. */
function probe() {
  const r = spawnSync('bash', [PROBE], { encoding: 'utf-8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('signing home-base probe: an unprovisioned box fails fast', () => {
  it('never reports OK on a box missing the signing credentials', () => {
    // Guard against the probe rounding up to success: a box without the Developer ID cert and the
    // apple.com/npmjs.com bundles is not a home base. On a provisioned Mac this would print OK,
    // which is the release's own happy path.
    const provisioned =
      process.platform === 'darwin' &&
      spawnSync('bash', ['-c', "security find-identity -v -p codesigning 2>/dev/null | grep -q 'Developer ID Application'"])
        .status === 0;
    if (provisioned) return; // real signing box: OK is correct, nothing to assert here
    const { status, out } = probe();
    expect(status).not.toBe(0);
    expect(out).not.toContain('OK\n');
  });
});

describe('signing home-base probe: it cannot advance a release', () => {
  it('the probe performs no git/gh/npm mutations', () => {
    // The probe must fail before merge and tag, so assert its executable body carries no mutation.
    // Strip comment lines and string literals first so a "npm publish" in a docblock or error
    // string is not mistaken for a command.
    const code = fs
      .readFileSync(PROBE, 'utf-8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .map((l) => l.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''"))
      .join('\n');
    for (const banned of [
      /\bgit\s+(tag|push|commit|merge|worktree|checkout|switch|reset)\b/,
      /\bgh\s+pr\s+(create|merge)\b/,
      /\bnpm\s+publish\b/,
    ]) {
      expect(code).not.toMatch(banned);
    }
  });
});

describe('release.sh: the preflight gates the mutating phases', () => {
  // The promote-readiness preflight (assert_promote_home_base) and its fail-loud
  // harness are covered in promote-home-base-probe.test.ts (RUSH-3026).
  it('does not call assert_signing_home_base on the ordinary promote path', () => {
    const lines = fs.readFileSync(RELEASE, 'utf-8').replace(/\r/g, '').split('\n');
    const call = lines.findIndex((l) => l.trim() === 'assert_signing_home_base');
    expect(call, 'ordinary release must not preflight signing/notarization').toBe(-1);
    expect(lines.some((l) => /wait_for_attestation/.test(l))).toBe(true);
    // The version-bump PR is still merged with --rebase (now inside the async,
    // post-publish, best-effort `if gh pr merge ...` — RUSH-2395 decouple).
    expect(lines.some((l) => /gh pr merge "\$PR_NUMBER" --rebase/.test(l))).toBe(true);
    expect(lines.some((l) => /^git push origin "v\$TARGET"$/.test(l))).toBe(true);
  });
});
