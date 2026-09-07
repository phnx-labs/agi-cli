/**
 * The signing home-base preflight, run against the REAL probe script.
 *
 * The case that matters is RUSH-2535: `release.sh --device zion` (the documented
 * "mac-mini is down" fallback) ran the whole flow -- crabbox tests, merge the PR,
 * push the tag -- and only THEN discovered zion cannot sign, leaving a
 * tagged-but-UNPUBLISHED release (npm at 1.22.35 with v1.22.36 tagged). The probe
 * moves that discovery to the front: an unprovisioned box must fail here, before
 * any git mutation.
 *
 * A fully green OK requires a real provisioned Mac (a Developer ID identity in a
 * headless-unlockable keychain + the apple.com/npmjs.com bundles) -- the release
 * itself exercises that path. On any box we can still assert the two things that
 * make the preflight worth having: it FAILS on an unprovisioned box, and it is
 * READ-ONLY, so running it can never advance a release. We also pin release.sh's
 * call ordering so the check runs before the crabbox, PR, merge, and tag.
 *
 * The provisioning-profile gate this suite used to cover (embedded.provisionprofile,
 * RUSH-2541) was removed with it: that profile only fed the keychain helper's
 * signed build, which moved out of this repo entirely with the standalone
 * `secrets` engine (PHNX-3989).
 */

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
    // Guard against the probe rounding up to success: a box without the Developer
    // ID cert / apple.com / npmjs.com bundles is not a home base. (On a genuinely
    // provisioned Mac this test box would print OK -- that is the release's own
    // happy path, not this unit's job to fake.)
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
    // The whole point is to fail BEFORE the merge + tag. A probe that itself ran
    // a mutation would defeat that, so assert the executable body carries none.
    // Strip comment lines and string-literal contents first, so a "npm publish"
    // in the docblock or an error string is not mistaken for a command.
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
