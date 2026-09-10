import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// win32: bash release.sh PR-head synchronization (RUSH-2215).
const describeRelease = process.platform === 'win32' ? describe.skip : describe;

// The --device resolution assertions drive the real --home-base-phase entrypoint,
// which dies at the macOS gate on Linux (printing the resolved home base) but
// would proceed past it on darwin. Run them off darwin/win32 only.
const describeDeviceResolution =
  process.platform === 'win32' || process.platform === 'darwin'
    ? describe.skip
    : describe;

const RELEASE_SH_PATH = path.resolve(__dirname, 'release.sh');
const RELEASE_SH = fs.readFileSync(RELEASE_SH_PATH, 'utf-8');

function runRelease(...args: string[]): { status: number | null; out: string } {
  const r = spawnSync('bash', [RELEASE_SH_PATH, ...args], { encoding: 'utf-8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describeRelease('release.sh attestation promotion (RUSH-2666)', () => {
  it('requires the exact release-commit tree and never waits on a full-suite matrix', () => {
    const waitFunction = RELEASE_SH.match(
      /wait_for_attestation\(\) \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.body;

    expect(waitFunction).toBeDefined();
    expect(waitFunction).toContain('release-attestation.sh require');
    expect(waitFunction).toContain('+ 30');
    expect(RELEASE_SH).not.toContain('wait_for_ci_green');
    expect(RELEASE_SH).not.toContain('run_crabbox_tests');
    expect(RELEASE_SH).not.toContain('EXPECTED_CHECKS');
    expect(RELEASE_SH).toContain('wait_for_attestation "$(git rev-parse "$RELEASE_CI_HEAD^{tree}")"');
    expect(RELEASE_SH).toContain('refusing parent/nearby evidence');
  });

  it('promotes the attested tarball and does not rebuild or notarize on the ordinary path', () => {
    expect(RELEASE_SH).toContain('release-attestation.sh promote');
    expect(RELEASE_SH).toContain('release-install-smoke.sh');
    expect(RELEASE_SH).toContain('release-manifest.sh require');
    expect(RELEASE_SH).toContain('npm publish "$tgz"');
    expect(RELEASE_SH).toContain('upload_release_proof');
    expect(RELEASE_SH).toContain('gh release download "v$TARGET"');
    expect(RELEASE_SH).toContain('ComputerHelper.app.zip');
    // ...but only behind the opt-in. An ordinary release publishes the CLI and
    // nothing else; helpers live on their own tags now.
    expect(RELEASE_SH).toContain('--with-helpers) WITH_HELPERS=true');
    expect(RELEASE_SH).toContain('WITH_HELPERS=false');
    expect(RELEASE_SH).not.toContain('sign-cli-binary.sh');
    expect(RELEASE_SH).not.toContain('publish-computer-helper-mac.sh');
    // The menu-bar helper is neither built (its source is phnx-labs/agi-menu,
    // PHNX-4036) nor staged by a CLI release; it resolves from menubar/v<floor>.
    expect(RELEASE_SH).not.toContain('swift build');
    expect(RELEASE_SH).not.toContain('stage-menubar-helper.sh');
    expect(RELEASE_SH).toContain('rebuild/notarization is outside the ordinary release path');
  });
});

describeRelease('release.sh: an ordinary release is CLI-only', () => {
  /**
   * The default path must do NO helper work. Two couplings made that false and
   * each is asserted separately, because they fail differently:
   *
   *  - staging `ComputerHelper.app.zip` onto `v$TARGET` publishes an asset no
   *    client requests (helpers resolve from their own tags), and
   *  - `release-manifest.sh require` re-derives every helper's input digest and
   *    ABORTS when one moved without a rebuild — so editing Swift the CLI does
   *    not ship could fail a perfectly good CLI release.
   */
  /**
   * Run `upload_release_proof` for real, with its five external dependencies
   * stubbed as recording shims, and return what it invoked.
   *
   * This replaces a text-scanning `isGated` helper that was defeated THREE times
   * — nearest-match, then an indentation assumption, then a one-line `if ...; fi`
   * hiding its own `fi`. Every failure came from reasoning about the script's
   * text instead of its behaviour, so this runs the function and observes the
   * calls. Same extract-and-run shape `home_base_wt_snippet` already uses below.
   */
  function runUpload(
    withHelpers: boolean,
    fail: { attestationFails?: boolean; tarballMissing?: boolean } = {},
  ): { calls: string[]; status: number | null; out: string } {
    const src = RELEASE_SH.match(/upload_release_proof\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(src, 'upload_release_proof not extractable').toBeDefined();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-upload-'));
    const log = path.join(dir, 'calls.log');
    const bin = path.join(dir, 'bin');
    const scripts = path.join(dir, 'scripts');
    fs.mkdirSync(bin); fs.mkdirSync(scripts);

    // gh/jq are recorded; jq must still answer the tarball-path query.
    fs.writeFileSync(path.join(bin, 'gh'),
      `#!/usr/bin/env bash\necho "gh $*" >> ${log}\nexit 0\n`);
    fs.writeFileSync(path.join(bin, 'jq'),
      `#!/usr/bin/env bash\necho "jq $*" >> ${log}\ncat >/dev/null\necho "${dir}/pkg.tgz"\n`);
    // release-attestation.sh's output is CAPTURED (`attest="$(...)"`), so a stub
    // that only logs leaves $attest empty and `cp "$attest"` fails — which the
    // harness swallowed until the review caught it. Log to the file, echo a real
    // path to stdout.
    fs.writeFileSync(path.join(dir, 'attestation.json'), '{}');
    fs.writeFileSync(path.join(scripts, 'release-attestation.sh'),
      `#!/usr/bin/env bash\necho "release-attestation.sh $*" >> ${log}\n`
      + (fail.attestationFails ? 'exit 1\n'
        : `printf '%s\\n' ${JSON.stringify(path.join(dir, 'attestation.json'))}\n`));
    fs.writeFileSync(path.join(scripts, 'release-manifest.sh'),
      `#!/usr/bin/env bash\necho "release-manifest.sh $*" >> ${log}\nexit 0\n`);
    for (const n of ['release-attestation.sh', 'release-manifest.sh']) {
      fs.chmodSync(path.join(scripts, n), 0o755);
    }
    for (const f of ['gh', 'jq']) fs.chmodSync(path.join(bin, f), 0o755);
    if (!fail.tarballMissing) fs.writeFileSync(path.join(dir, 'pkg.tgz'), 'tgz');
    // The store the function reads its manifest from.
    fs.writeFileSync(path.join(dir, 'release-manifest.json'), '{}');

    const harness = [
      // Production runs under `set -euo pipefail`. Without -e the harness keeps
      // going past a failure the real script aborts on, so it can exercise a
      // control flow production never takes.
      'set -euo pipefail',
      'die() { echo "die: $*" >&2; exit 9; }',
      'gray() { :; }; green() { :; }; bold() { :; }; yellow() { :; }; red() { :; }',
      `attestation_store_dir() { printf '%s\\n' ${JSON.stringify(dir)}; }`,
      `REPO_ROOT=${JSON.stringify(dir)}`,
      'TARGET=1.2.3', 'PHNX_LATEST=1.2.2',
      `WITH_HELPERS=${withHelpers}`,
      src!,
      'upload_release_proof deadbeef',
    ].join('\n');

    const r = spawnSync('bash', ['-c', harness], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      cwd: dir,
    });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n') : [];
    return { calls, status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  it('does NOT touch the helper manifest on an ordinary release', () => {
    const { calls, out } = runUpload(false);
    expect(calls.some((c) => c.startsWith('release-manifest.sh')), out).toBe(false);
    // …and still does the CLI work, so this is not passing by dying early.
    expect(calls.some((c) => c.startsWith('gh release')), out).toBe(true);
  });

  it('aborts when the attestation lookup fails, rather than uploading unproven bytes', () => {
    // Asserts the INVARIANT — never upload unproven bytes — not the presence of
    // the `|| die`. Verified by mutation: deleting that guard does NOT fail this
    // test, and should not, because under production's `set -euo pipefail` the
    // assignment `attest="$(...)"` aborts on a non-zero command regardless. The
    // `die` supplies a message, not the abort. A test demanding the guard's text
    // would be back to asserting source, which is what failed three times here.
    const { calls, status } = runUpload(false, { attestationFails: true });
    expect(status).not.toBe(0);
    expect(calls.some((c) => c.startsWith('gh release')), 'must not upload without proof').toBe(false);
  });

  it('aborts when the pretested tarball is missing, rather than rebuilding', () => {
    // Same shape, same caveat: this pins the behaviour (abort, no upload), which
    // `set -e` also enforces, rather than the guard's presence.
    const { calls, status } = runUpload(false, { tarballMissing: true });
    expect(status).not.toBe(0);
    expect(calls.some((c) => c.startsWith('gh release')), 'must not upload without a tarball').toBe(false);
  });

  it('DOES stage the computer-mac asset with --with-helpers', () => {
    const { calls, out } = runUpload(true);
    const manifest = calls.filter((c) => c.startsWith('release-manifest.sh'));
    expect(manifest.length, out).toBeGreaterThan(0);
    expect(manifest.join(' ')).toContain('--helper computer-mac');
  });

  it('defaults the flag OFF, so CLI-only is what you get without asking', () => {
    expect(RELEASE_SH).toMatch(/^WITH_HELPERS=false$/m);
  });

  it('lists EVERY flag its parser accepts in --help (executed, not grepped)', () => {
    // Runs the real script. The content-assertion version of this test passed
    // while --help silently omitted --with-helpers, because it only checked that
    // one known string appeared. This derives the flag set from the parser and
    // compares it against actual --help OUTPUT, so the next flag someone adds is
    // covered without anyone remembering to extend the test.
    const help = spawnSync('bash', [RELEASE_SH_PATH, '--help'], { encoding: 'utf-8' });
    expect(help.status, help.stderr).toBe(0);

    // Flags the `case` arms accept, minus the internal phase markers (deliberately
    // undocumented) and --help itself.
    const INTERNAL = new Set(['--home-base-phase', '--orchestration-phase', '-h', '--help']);
    // Aliases are satisfied by their primary being documented — `--help` should
    // teach one spelling, not every accepted synonym.
    const ALIAS_OF: Record<string, string> = { '--host': '--device', '-y': '--yes' };
    const parsed = new Set<string>();
    for (const arm of RELEASE_SH.matchAll(/^\s{4}(-[^)]+)\)/gm)) {
      for (const flag of arm[1].split('|')) {
        const name = flag.trim().replace(/=\*$/, '');
        // `--*)` is the unknown-flag catch-all, not a flag.
        if (name === '--*' || !name.startsWith('-')) continue;
        if (INTERNAL.has(name)) continue;
        parsed.add(ALIAS_OF[name] ?? name);
      }
    }
    expect(parsed.size, 'no flags parsed out of the case arms').toBeGreaterThan(3);

    const missing = [...parsed].filter((f) => !help.stdout.includes(f));
    expect(missing, `--help omits: ${missing.join(', ')}`).toEqual([]);
  });

  it('warns that a new flag is inert until merged, because the script re-execs from origin', () => {
    // release.sh:190 execs release-worktree.sh, which checks out
    // `origin/$DEFAULT_BRANCH` and re-runs THIS script from there. The second
    // parse is the MERGED copy, so an unmerged flag dies as `unknown flag` even
    // though the local parser handles it. No content assertion can catch that —
    // they read the working tree, the failure is in another copy — so the trap is
    // pinned as prose instead, next to the parser it bites.
    expect(RELEASE_SH).toContain('A NEW FLAG DOES NOT WORK UNTIL IT IS ON origin/<default>');
    expect(RELEASE_SH).toContain('--orchestration-phase');
  });

  it('builds the download patterns as an array, never a word-split splice', () => {
    // A `$( ... )` splice here is word-split by the shell — the same class of bug
    // that silently dropped vitest args in test.sh — and an empty splice trips
    // `set -u`.
    expect(RELEASE_SH).toContain('dl_patterns=(');
    expect(RELEASE_SH).toContain('"${dl_patterns[@]}"');
  });
});

describeRelease('release.sh: publish is decoupled from live main (RUSH-2395 audit)', () => {
  it('rebase-merges release bookkeeping without deleting branches or bypassing review', () => {
    expect(RELEASE_SH).toContain('gh pr merge "$PR_NUMBER" --rebase');
    expect(RELEASE_SH).toContain('gh pr merge "$STUCK_BUMP_PR" --rebase');
    expect(RELEASE_SH).not.toContain('--delete-branch');
    expect(RELEASE_SH).not.toMatch(/gh pr merge[^\n]*--(?:admin|squash)/);
  });

  it('tags + publishes the ATTESTED release commit, never a fresh-main squash result', () => {
    // The publish source is the attested commit itself...
    expect(RELEASE_SH).toContain('PUBLISH_SHA="$CI_COMMIT"');
    // ...never whatever origin/main squashed to after the merge.
    expect(RELEASE_SH).not.toContain('PUBLISH_SHA="$MERGED_SHA"');
    // The PRIMARY path (CI_COMMIT="$RELEASE_COMMIT" ... PUBLISH_SHA="$CI_COMMIT")
    // has NO "does live main reproduce the attested tree" equality gate -- that
    // gate forced main to stay quiet for the whole release.
    const primaryStart = RELEASE_SH.indexOf('CI_COMMIT="$RELEASE_CI_HEAD"');
    const primaryEnd = RELEASE_SH.indexOf('PUBLISH_SHA="$CI_COMMIT"');
    expect(primaryStart).toBeGreaterThan(0);
    expect(primaryEnd).toBeGreaterThan(primaryStart);
    const primaryPath = RELEASE_SH.slice(primaryStart, primaryEnd);
    expect(primaryPath).not.toContain('MERGED_TREE');
    expect(primaryPath).not.toContain('git fetch --quiet origin "$DEFAULT_BRANCH"');
    expect(RELEASE_SH).toContain('wait_for_attestation "$ATTESTED_TREE"');
    expect(RELEASE_SH).toContain('merge deferred until after publish');
  });

  it('keys the tag/publish to the STABLE branch head, not a re-synthesized commit (retry-safe)', () => {
    // git commit-tree stamps wall-clock time, so RELEASE_COMMIT gets a fresh SHA
    // every run for identical content. The primary path must publish the stable,
    // already-pushed RELEASE_CI_HEAD so a retry after a transient home-base failure
    // does not die at the tag-mismatch check (review of #2966).
    expect(RELEASE_SH).toContain('CI_COMMIT="$RELEASE_CI_HEAD"');
    expect(RELEASE_SH).not.toContain('CI_COMMIT="$RELEASE_COMMIT"');
    // The already-published re-run lands a still-open deferred bump PR so the
    // .changelog/next queue cannot drift into a later release.
    expect(RELEASE_SH).toContain('STUCK_BUMP_PR');
  });

  it('merges the version-bump PR AFTER publish, non-gating (never dies on it)', () => {
    // The old flow squash-merged BEFORE publish and died on a merge failure,
    // coupling the release to a quiet main. That gating merge is gone.
    expect(RELEASE_SH).not.toContain(
      'gh pr merge "$PR_NUMBER" --squash --delete-branch || die',
    );
    // The async bump-merge lives after the "Verify live" phase and is best-effort.
    const verifyIdx = RELEASE_SH.indexOf('phase "Verify live"');
    const asyncMergeIdx = RELEASE_SH.indexOf(
      'Land the version bump on main -- AFTER publish, non-gating',
    );
    expect(verifyIdx).toBeGreaterThan(0);
    expect(asyncMergeIdx).toBeGreaterThan(verifyIdx);
    // It is skipped for the historical-catchup path (its PR merged in a prior run).
    const block = RELEASE_SH.slice(asyncMergeIdx);
    expect(block).toContain('&& ! $HISTORICAL_CATCHUP');
  });
});

describeRelease('release.sh: rebased historical catch-up (PHNX-3945)', () => {
  it('does not reject a rebased merge during early catch-up discovery', () => {
    const start = RELEASE_SH.indexOf('if $MAIN_AT_TARGET && ! $PHNX_TARGET_PUBLISHED && [[ -n "$MERGED_RELEASE_SHA" ]]');
    const end = RELEASE_SH.indexOf('# ----- Sync package.json with target -----', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const discovery = RELEASE_SH.slice(start, end);
    expect(discovery).toContain('CI_TESTED_HEAD="$(git rev-parse FETCH_HEAD)"');
    expect(discovery).not.toContain('^{tree}');
    expect(discovery).not.toContain('pkg_version_at_ref');
  });

  it('selects the exact attested PR head when the merged bump has a different tree', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-catchup-'));
    const store = path.join(dir, 'attestations');
    fs.mkdirSync(path.join(dir, 'cli'), { recursive: true });
    fs.mkdirSync(store);
    fs.writeFileSync(path.join(dir, 'cli/package.json'), '{"version":"1.0.0"}\n');
    fs.writeFileSync(path.join(dir, 'cli/bun.lock'), 'lock-v1\n');
    fs.writeFileSync(path.join(dir, 'cli/vitest.config.ts'), 'export default {}\n');
    const git = (...args: string[]) => {
      const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf-8' });
      expect(r.status, `${args.join(' ')}: ${r.stderr}`).toBe(0);
      return r.stdout.trim();
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD');

    // This is the exact release PR head that CI tested and the release record names.
    fs.writeFileSync(path.join(dir, 'cli/package.json'), '{"version":"1.0.1"}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'chore(release): 1.0.1');
    const releaseHead = git('rev-parse', 'HEAD');
    const releaseTree = git('rev-parse', 'HEAD^{tree}');

    // Model a rebase/squash onto moved main: target version present, different tree.
    git('checkout', '-q', '-B', 'rebased-main', base);
    fs.writeFileSync(path.join(dir, 'cli/package.json'), '{"version":"1.0.1"}\n');
    fs.writeFileSync(path.join(dir, 'concurrent.txt'), 'landed before the bump\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'rebased release bump');
    const mergedSha = git('rev-parse', 'HEAD');
    expect(git('rev-parse', 'HEAD^{tree}')).not.toBe(releaseTree);

    // Publish a real exact-tree attestation record for the tested PR head.
    const attest = path.resolve(__dirname, 'release-attestation.sh');
    const identityRun = spawnSync(
      'bash', [attest, 'identity', '--repo-root', dir, '--commit', releaseHead],
      { encoding: 'utf-8' },
    );
    expect(identityRun.status, identityRun.stderr).toBe(0);
    const identity = JSON.parse(identityRun.stdout);
    const source = path.join(store, 'source.json');
    fs.writeFileSync(source, JSON.stringify({
      schemaVersion: 1,
      ...identity,
      suite: 'selected',
      conclusion: 'pass',
      tarball: { filename: 'agents-cli-1.0.1.tgz', digest: `sha256:${'0'.repeat(64)}` },
    }));
    const write = spawnSync('bash', [attest, 'write', '--dir', store, '--file', source], {
      cwd: dir,
      encoding: 'utf-8',
    });
    expect(write.status, `${write.stdout}${write.stderr}`).toBe(0);

    const pkgFn = RELEASE_SH.match(/^pkg_version_at_ref\(\) \{[\s\S]*?^\}/m)?.[0];
    const selectFn = RELEASE_SH.match(/^select_historical_catchup_publish_sha\(\) \{[\s\S]*?^\}/m)?.[0];
    const recoverTagFn = RELEASE_SH.match(/^select_already_published_tag_sha\(\) \{[\s\S]*?^\}/m)?.[0];
    expect(pkgFn).toBeDefined();
    expect(selectFn).toBeDefined();
    expect(recoverTagFn).toBeDefined();
    const harness = [
      'set -euo pipefail',
      'die() { echo "error: $*" >&2; exit 1; }',
      `TARGET=1.0.1`,
      'DEFAULT_BRANCH=main',
      pkgFn!,
      `wait_for_attestation() { ${JSON.stringify(attest)} require --dir ${JSON.stringify(store)} --tree "$1" --repo-root ${JSON.stringify(dir)}; }`,
      selectFn!,
      `select_historical_catchup_publish_sha ${JSON.stringify(mergedSha)} ${JSON.stringify(releaseHead)} ${JSON.stringify(releaseHead)}`,
    ].join('\n');
    const selected = spawnSync('bash', ['-c', harness], { cwd: dir, encoding: 'utf-8' });
    expect(selected.status, `${selected.stdout}${selected.stderr}`).toBe(0);
    expect(selected.stdout.trim()).toBe(releaseHead);

    const identityMismatch = spawnSync(
      'bash',
      ['-c', `${harness.slice(0, harness.lastIndexOf('\n'))}\nselect_historical_catchup_publish_sha ${JSON.stringify(mergedSha)} ${JSON.stringify(releaseHead)} ${JSON.stringify(mergedSha)}`],
      { cwd: dir, encoding: 'utf-8' },
    );
    expect(identityMismatch.status).not.toBe(0);
    expect(`${identityMismatch.stdout}${identityMismatch.stderr}`).toContain('!= recorded release head');

    // Exercise the sibling already-published/missing-tag selector with the same
    // rebased main tree. It must recover the tag at the published PR head, not
    // reject the legitimate tree difference or tag the merge commit.
    const recoverTag = spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'die() { echo "error: $*" >&2; exit 1; }',
      'TARGET=1.0.1',
      'DEFAULT_BRANCH=main',
      pkgFn!,
      recoverTagFn!,
      `select_already_published_tag_sha ${JSON.stringify(mergedSha)} ${JSON.stringify(releaseHead)} ${JSON.stringify(releaseHead)}`,
    ].join('\n')], { cwd: dir, encoding: 'utf-8' });
    expect(recoverTag.status, `${recoverTag.stdout}${recoverTag.stderr}`).toBe(0);
    expect(recoverTag.stdout.trim()).toBe(releaseHead);
    const publishedBranch = RELEASE_SH.slice(
      RELEASE_SH.indexOf('if $PHNX_TARGET_PUBLISHED; then'),
      RELEASE_SH.indexOf('# ----- Resolve release base'),
    );
    expect(publishedBranch).toContain('select_already_published_tag_sha');
    expect(publishedBranch).not.toContain('$MERGED_RELEASE_SHA^{tree}');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describeRelease('release.sh --device flag', () => {
  it('advertises --device <name> in --help', () => {
    const { status, out } = runRelease('--help');
    expect(status).toBe(0);
    expect(out).toContain('--device <name>');
  });

  it('rejects --device with no machine name', () => {
    const { status, out } = runRelease('1.2.3', '--device');
    expect(status).not.toBe(0);
    expect(out).toContain('--device needs a machine name');
  });

  it('preserves "$@" so the worktree re-exec can forward every arg', () => {
    // A `shift`-based parser would consume $@ and strip --device from the
    // release-worktree re-exec (RELEASE_ARGS=("$@")); the for-loop must not.
    expect(RELEASE_SH).toContain('for arg in "$@"; do');
    expect(RELEASE_SH).toContain('exec scripts/release-worktree.sh "$CALLER_REPO_ROOT" "$@"');
  });
});

describeRelease('release.sh: non-interactive --apply guard (PHNX-3176)', () => {
  it('fails loud on --apply from a non-TTY without --yes, instead of exiting 0', () => {
    // runRelease uses spawnSync, whose default stdio is a pipe -- stdin is not a
    // TTY, exactly the backgrounded-release repro. Before this guard, the [y/N]
    // confirmation EOF-declined and the script exited 0 having published nothing,
    // so a caller that checked $? believed a release shipped when none did.
    const { status, out } = runRelease('9.9.9', '--apply');
    expect(status).not.toBe(0);
    expect(out).toMatch(/--yes/);
    expect(out).toMatch(/not a TTY|interactive terminal/);
    expect(out).toMatch(/published nothing/);
  });

  it('does not trip the guard in dry-run (no --apply)', () => {
    // A non-interactive dry-run is legitimate (CI preview); the guard is scoped to
    // --apply, which is the only mode that reaches the confirmation. Use the
    // internal phase marker so this parser/guard test does not clone origin and
    // turn a sub-second assertion into a live-network timeout.
    const { out } = runRelease('1.2.3', '--home-base-phase');
    expect(out).not.toMatch(/needs an interactive terminal/);
  });

  it('--yes is the sanctioned non-interactive escape (guard names it, parser accepts it)', () => {
    expect(RELEASE_SH).toContain('--yes|-y) YES=true');
    // The guard excludes the internal re-exec phases, which inherit the
    // already-checked stdin and must not re-require --yes.
    expect(RELEASE_SH).toContain('! $HOME_BASE_PHASE && ! $ORCHESTRATION_PHASE && [ ! -t 0 ]');
  });
});

describeDeviceResolution('release.sh --device resolution', () => {
  it('defaults the home base to mac-mini when --device is omitted', () => {
    const { out } = runRelease('1.2.3', '--home-base-phase');
    expect(out).toContain('home base: mac-mini (promote-only');
  });

  it('routes the privileged phase to --device <name>', () => {
    const { out } = runRelease('1.2.3', '--device', 'zion', '--home-base-phase');
    expect(out).toContain('home base: zion (promote-only');
  });

  it('accepts --host as an alias for --device', () => {
    const { out } = runRelease('1.2.3', '--host', 'pinnacles', '--home-base-phase');
    expect(out).toContain('home base: pinnacles (promote-only');
  });

  it('accepts the --device=<name> glued form', () => {
    const { out } = runRelease('1.2.3', '--device=zion', '--home-base-phase');
    expect(out).toContain('home base: zion (promote-only');
  });
});

// RUSH-3189 flatten: pkg_version_at_ref must read the recorded version from a
// POST-flatten ref (cli/package.json) and from a PRE-flatten tag
// (apps/cli/package.json) — the fallback that keeps the catch-up-publish and
// stuck-tag guards working against tags cut before the rename. Fixtures build
// both layouts synthetically; nothing here depends on this repo's own history.
describe('release.sh: pkg_version_at_ref resolves both layouts (RUSH-3189)', () => {
  const fnSource = (): string => {
    const sh = fs.readFileSync(path.join(__dirname, 'release.sh'), 'utf8');
    const m = sh.match(/pkg_version_at_ref\(\) \{[\s\S]*?\n\}/);
    if (!m) throw new Error('pkg_version_at_ref not found in release.sh');
    return m[0];
  };
  const mkRepo = (): string => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-flatten-ref-'));
    const git = (...args: string[]) => {
      const r = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout;
    };
    git('init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(repo, 'apps/cli'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'apps/cli/package.json'), JSON.stringify({ version: '1.22.40' }));
    git('add', '-A'); git('commit', '-qm', 'pre-flatten'); git('tag', 'v-pre');
    git('mv', 'apps/cli', 'cli');
    fs.writeFileSync(path.join(repo, 'cli/package.json'), JSON.stringify({ version: '1.22.50'}));
    git('add', '-A'); git('commit', '-qm', 'post-flatten'); git('tag', 'v-post');
    return repo;
  };
  const readAt = (repo: string, ref: string) =>
    spawnSync('bash', ['-c', `${fnSource()}\npkg_version_at_ref ${ref}`], { cwd: repo, encoding: 'utf8' });

  it('reads cli/package.json from a post-flatten ref', () => {
    const repo = mkRepo();
    try {
      const r = readAt(repo, 'v-post');
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('1.22.50');
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });

  it('falls back to apps/cli/package.json for a pre-flatten tag', () => {
    const repo = mkRepo();
    try {
      const r = readAt(repo, 'v-pre');
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('1.22.40');
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });

  it('echoes nothing when neither layout exists at the ref', () => {
    const repo = mkRepo();
    try {
      const r = spawnSync('bash', ['-c', `${fnSource()}\nexport GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t && EMPTY=$(git hash-object -t tree /dev/null) && C=$(git commit-tree "$EMPTY" -m x) && pkg_version_at_ref "$C"`], { cwd: repo, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });
});

describeRelease('release.sh fetch_main_attestation (RUSH-2666, plan line 336)', () => {
  /**
   * Run the real `fetch_main_attestation` extracted from release.sh, with `gh`
   * and `release-attestation.sh` stubbed as recording shims, and observe what it
   * did. Same extract-and-run shape the upload_release_proof tests above use — we
   * assert BEHAVIOR (store populated / no download / never dies), not source text.
   *
   * The invariant under test is the hard fail-safe constraint: the fast path can
   * only make a release faster. Every miss/error falls back to today's poll path
   * WITHOUT a non-zero exit that would abort the caller (which runs under
   * `set -euo pipefail` and calls it as `fetch_main_attestation ... || true`).
   */
  function runFetch(opts: {
    ghOnPath?: boolean; // default true
    ghDownloadSucceeds?: boolean; // gh release download exit
    // require verdicts, consumed in call order: [pre-download check, post-download check]
    requireVerdicts?: boolean[];
    writeAssetOnDownload?: boolean; // gh download drops attest-<tree>.json into the store
    prePopulateStore?: string[]; // files already sitting in the store (e.g. a prior tarball)
  }): { calls: string[]; status: number | null; out: string; storeFiles: string[] } {
    const src = RELEASE_SH.match(/fetch_main_attestation\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(src, 'fetch_main_attestation not extractable').toBeDefined();

    const ghOnPath = opts.ghOnPath ?? true;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-fetch-'));
    const log = path.join(dir, 'calls.log');
    const bin = path.join(dir, 'bin');
    const scripts = path.join(dir, 'scripts');
    const store = path.join(dir, 'store');
    fs.mkdirSync(bin); fs.mkdirSync(scripts);
    const tree = 'a'.repeat(40);
    if (opts.prePopulateStore?.length) {
      fs.mkdirSync(store, { recursive: true });
      for (const f of opts.prePopulateStore) fs.writeFileSync(path.join(store, f), 'pre');
    }

    // A `release-attestation.sh` stub that answers `require` from a verdict queue
    // (a state file it decrements), so the pre- and post-download require calls
    // can differ (miss, then hit). Any non-require subcommand exits 0.
    const verdicts = opts.requireVerdicts ?? [false, false];
    fs.writeFileSync(path.join(dir, 'verdicts.txt'), verdicts.map((v) => (v ? '1' : '0')).join('\n'));
    fs.writeFileSync(path.join(scripts, 'release-attestation.sh'),
      `#!/usr/bin/env bash
echo "release-attestation.sh $*" >> ${JSON.stringify(log)}
if [[ "$1" == "require" ]]; then
  q=${JSON.stringify(path.join(dir, 'verdicts.txt'))}
  v="$(head -1 "$q")"; tail -n +2 "$q" > "$q.tmp" && mv "$q.tmp" "$q"
  [[ "$v" == "1" ]] && exit 0 || exit 1
fi
exit 0
`);
    fs.chmodSync(path.join(scripts, 'release-attestation.sh'), 0o755);

    if (ghOnPath) {
      const drop = opts.writeAssetOnDownload
        ? `# emulate the producer's uploaded asset landing in the store\ndir=""; while [[ $# -gt 0 ]]; do [[ "$1" == "--dir" ]] && dir="$2"; shift; done\nmkdir -p "$dir"; echo '{}' > "$dir/attest-${tree}.json"\n`
        : '';
      fs.writeFileSync(path.join(bin, 'gh'),
        `#!/usr/bin/env bash
echo "gh $*" >> ${JSON.stringify(log)}
if [[ "$1 $2" == "release download" ]]; then
${drop}  ${opts.ghDownloadSucceeds ? 'exit 0' : 'exit 1'}
fi
exit 0
`);
      fs.chmodSync(path.join(bin, 'gh'), 0o755);
    }

    // Under production's set -euo pipefail, calling with `|| true` mirrors the
    // real call site. If the function ever `die`d (exit without the guard) the
    // harness would still exit 0 here, so we ALSO assert it returns cleanly by
    // capturing its own return code separately below.
    const harness = [
      'set -euo pipefail',
      'die() { echo "die: $*" >&2; exit 42; }',
      'gray() { :; }; green() { :; }; bold() { :; }; yellow() { :; }; red() { :; }',
      `REPO_ROOT=${JSON.stringify(dir)}`,
      'ATTEST_MAIN_TAG="main-attestations"',
      src!,
      // Mirror the REAL call site: `fetch_main_attestation ... || true`. A `die`
      // inside would exit 42 (caught before the echo below), proving the fail-safe
      // — only a die aborts the release; a plain non-zero return is what `|| true`
      // absorbs so the caller polls the local store as today. `set +e` around the
      // call captures the function's OWN verdict (0 = hit, non-zero = fell back)
      // without the shell aborting first, matching the guarded call site.
      `set +e; fetch_main_attestation ${JSON.stringify(tree)} ${JSON.stringify(store)}; rc=$?; set -e; echo "rc=$rc" >> ${JSON.stringify(log)}; true`,
    ].join('\n');

    // PATH excludes the real gh when ghOnPath is false; keep coreutils.
    const pathEnv = ghOnPath ? `${bin}:${process.env.PATH}` : '/usr/bin:/bin';
    const r = spawnSync('bash', ['-c', harness], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: pathEnv },
      cwd: dir,
    });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n') : [];
    const storeFiles = fs.existsSync(store) ? fs.readdirSync(store) : [];
    return { calls, status: r.status, out: `${r.stdout}${r.stderr}`, storeFiles };
  }

  it('fetch-HIT: downloads the tree-keyed asset and the post-download require succeeds', () => {
    const { calls, status, out, storeFiles } = runFetch({
      ghOnPath: true,
      ghDownloadSucceeds: true,
      writeAssetOnDownload: true,
      requireVerdicts: [false /* pre: not local yet */, true /* post: fetched proof verifies */],
    });
    expect(status, out).toBe(0);
    // It attempted a tree-keyed download from the rolling tag.
    const dl = calls.find((c) => c.startsWith('gh release download'));
    expect(dl, out).toBeDefined();
    expect(dl).toContain('main-attestations');
    expect(dl).toContain(`--pattern attest-${'a'.repeat(40)}.json`);
    // Downloads ONLY the tree-keyed json — never a `*.tgz` glob. The rolling
    // release accumulates one tarball per attested tree, so a `*.tgz` pattern
    // into a store that already holds any tarball would make `gh release
    // download` exit non-zero on the pre-existing file (no --clobber) and
    // silently drop every previously-primed box to the slow poll. The consumer
    // (require) needs only the json; the promoted tarball comes from v$TARGET.
    expect(dl, 'must not glob *.tgz — it collides on a primed store').not.toContain('*.tgz');
    // The asset landed in the store and the function returned success (rc=0).
    expect(storeFiles).toContain(`attest-${'a'.repeat(40)}.json`);
    expect(calls).toContain('rc=0');
  });

  it('fetch-HIT on a store already holding a stray .tgz: still succeeds (no *.tgz collision)', () => {
    // Regression guard for the collision the review caught: a box that prefetched
    // before has a tarball sitting in the store. Because we download only the
    // tree-keyed json (never a `*.tgz` glob), that pre-existing tarball cannot
    // make `gh release download` exit non-zero, so the fast path still lands.
    const { calls, status, out, storeFiles } = runFetch({
      ghOnPath: true,
      ghDownloadSucceeds: true,
      writeAssetOnDownload: true,
      requireVerdicts: [false, true],
      prePopulateStore: ['phnx-labs-agents-cli-9.9.9.tgz'],
    });
    expect(status, out).toBe(0);
    const dl = calls.find((c) => c.startsWith('gh release download'));
    expect(dl, out).not.toContain('*.tgz');
    expect(storeFiles).toContain(`attest-${'a'.repeat(40)}.json`);
    expect(calls).toContain('rc=0');
  });

  it('fetch-MISS (gh download errors): falls back cleanly — no die, non-zero return, no store pollution', () => {
    const { calls, status, out } = runFetch({
      ghOnPath: true,
      ghDownloadSucceeds: false, // network/asset-missing
      requireVerdicts: [false /* pre: not local */],
    });
    // The shell did NOT abort (no die => not exit 42); it completed and logged rc.
    expect(status, out).toBe(0);
    expect(calls.some((c) => c.startsWith('die:')), out).toBe(false);
    // It tried, gh failed, and it returned non-zero so the caller polls as today.
    expect(calls.some((c) => c.startsWith('gh release download')), out).toBe(true);
    const rc = calls.find((c) => c.startsWith('rc='));
    expect(rc, out).toBe('rc=1');
  });

  it('no gh on PATH: returns non-zero immediately, never downloads, never dies', () => {
    const { calls, status, out } = runFetch({ ghOnPath: false, requireVerdicts: [] });
    expect(status, out).toBe(0);
    expect(calls.some((c) => c.startsWith('gh ')), out).toBe(false);
    expect(calls.some((c) => c.startsWith('die:')), out).toBe(false);
    expect(calls).toContain('rc=1');
  });

  it('already local: short-circuits BEFORE any download (no gh release download call)', () => {
    const { calls, status, out } = runFetch({
      ghOnPath: true,
      ghDownloadSucceeds: true,
      requireVerdicts: [true /* pre-check already verifies */],
    });
    expect(status, out).toBe(0);
    expect(calls.some((c) => c.startsWith('gh release download')), out).toBe(false);
    expect(calls).toContain('rc=0');
  });

  it('wait_for_attestation prefetches from the rolling release, then keeps the exact poll/require fallback', () => {
    // The fast path is wired in AND additive: the original poll-then-require path
    // is unchanged, so a miss degrades to exactly today's behavior.
    expect(RELEASE_SH).toContain('fetch_main_attestation "$tree" "$attest_dir" || true');
    expect(RELEASE_SH).toContain('ATTEST_MAIN_TAG="main-attestations"');
    // The bounded poll loop and terminal require are retained.
    expect(RELEASE_SH).toContain('30s fallback budget');
    const waitFn = RELEASE_SH.match(/wait_for_attestation\(\) \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;
    expect(waitFn).toBeDefined();
    expect(waitFn).toContain('release-attestation.sh require');
    // The prefetch is best-effort: guarded with `|| true` so it can never abort.
    expect(waitFn).toContain('|| true');
    // The poll deadline MUST be computed AFTER the prefetch,
    // so a slow `gh` cannot shrink the poll window and fail a release that would
    // have succeeded today (PHNX-2666 review). Order-guard, not just presence.
    const fetchIdx = waitFn!.indexOf('fetch_main_attestation "$tree"');
    const deadlineIdx = waitFn!.indexOf('local deadline=');
    expect(fetchIdx, 'fetch call present').toBeGreaterThan(-1);
    expect(deadlineIdx, 'deadline present').toBeGreaterThan(-1);
    expect(deadlineIdx, 'deadline must be set AFTER the prefetch').toBeGreaterThan(fetchIdx);
  });

  it('keeps prefetch + fallback poll below the 60s ordinary-release ceiling', () => {
    const waitFn = RELEASE_SH.match(/wait_for_attestation\(\) \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;
    expect(waitFn).toContain('+ 30');
    expect(waitFn).toContain('>= deadline');
    const fetchFn = RELEASE_SH.match(/fetch_main_attestation\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(fetchFn).toMatch(/timeout 15 gh release download/);
  });

  it('fetch_main_attestation time-bounds the gh download so a network stall cannot hang a release', () => {
    // `gh` sets no HTTP timeout; an unbounded download could otherwise block the
    // release path. The download must run under timeout/gtimeout where present
    // (PHNX-2666 review). Source-guard against silently dropping the bound.
    const fetchFn = RELEASE_SH.match(/fetch_main_attestation\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(fetchFn, 'fetch_main_attestation extractable').toBeDefined();
    expect(fetchFn).toMatch(/timeout 15 gh release download/);
    expect(fetchFn).toMatch(/gtimeout 15 gh release download/);
    expect(fetchFn).not.toMatch(/else\s+gh release download/);
  });
});

/**
 * PHNX-3696 — the release-tree attestation gate must be satisfiable WITHOUT a human.
 *
 * RUSH-2666 (bfa1b4eed) made this record mandatory and shipped no producer, so every
 * `release.sh --apply` since 2026-08-15 stopped at "missing exact attestation key".
 * It survived review because the tests in this file assert against `RELEASE_SH` as a
 * STRING — they proved the gate was WIRED, never that it could be SATISFIED.
 *
 * So these tests EXECUTE the real `derive_release_attestation` body extracted from
 * release.sh, against a real git repo and a real on-disk store. Nothing is mocked:
 * the produce script the function shells out to is a real script in the fixture's
 * own `scripts/` dir, invoked over a real process boundary, because the function
 * resolves it by relative path. (The shipped producer runs a full `bun install` +
 * build + `npm pack`; it carries its own real-path coverage in
 * release-attestation-produce.test.ts. What is under test HERE is the decision the
 * release makes: derive, skip, or fall through.)
 */
describeRelease('release.sh derives its own release-tree attestation (PHNX-3696)', () => {
  const RELEASE_ATTESTATION_SH = path.resolve(__dirname, 'release-attestation.sh');

  function harness(): { dir: string; store: string; log: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'derive-attest-'));
    const store = path.join(dir, 'store');
    const log = path.join(dir, 'produce.log');
    fs.mkdirSync(store, { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    // A real script at the real relative path the function invokes. It records its
    // argv and writes a record for the requested commit's tree, which is exactly
    // the contract the shipped producer fulfils via `release-attestation.sh derive`.
    fs.writeFileSync(
      path.join(dir, 'scripts', 'release-attestation-produce.sh'),
      `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`,
      { mode: 0o755 },
    );
    fs.copyFileSync(RELEASE_ATTESTATION_SH, path.join(dir, 'scripts', 'release-attestation.sh'));
    // The identity the attestation binds (lockfile + vitest policy + version) must
    // exist for `release-attestation.sh identity` to resolve, same as initRepo() in
    // release-attestation.test.ts.
    fs.mkdirSync(path.join(dir, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cli/bun.lock'), 'lock-v1\n');
    fs.writeFileSync(path.join(dir, 'cli/vitest.config.ts'), 'export default {}\n');
    fs.writeFileSync(path.join(dir, 'cli/package.json'), '{"version":"1.0.0"}\n');
    spawnSync('git', ['init', '-q', '-b', 'main', dir], { encoding: 'utf-8' });
    spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'], { encoding: 'utf-8' });
    spawnSync('git', ['-C', dir, 'config', 'user.name', 'test'], { encoding: 'utf-8' });
    spawnSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf-8' });
    spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'base'], { encoding: 'utf-8' });
    return { dir, store, log };
  }

  /** Run the REAL function body, lifted verbatim out of release.sh. */
  function runDerive(dir: string, store: string, head: string, baseSha?: string) {
    const body = RELEASE_SH.match(/^derive_release_attestation\(\) \{[\s\S]*?^\}/m)?.[0];
    expect(body, 'derive_release_attestation must exist in release.sh').toBeDefined();
    // Only the ambient release context is supplied. The function body itself is the
    // shipped source, unmodified — that is the point of this harness.
    const prelude = [
      // Production flags, verbatim from release.sh:49. Dropping -e here is exactly
      // what let the set -e abort at the call site pass review: under `set -uo`
      // a failing bare call prints rc=1, under `set -euo` it kills the script.
      'set -euo pipefail',
      'bold() { :; }', 'green() { :; }', 'yellow() { :; }',
      `REPO_ROOT=${JSON.stringify(dir)}`,
      'DEFAULT_BRANCH=main',
      // Since PHNX-3705 derive inherits from the release commit's real parent
      // ($BASE_SHA), which may be an attested ancestor rather than the tip.
      `BASE_SHA=${JSON.stringify(baseSha ?? head)}`,
      `attestation_store_dir() { printf '%s\\n' ${JSON.stringify(store)}; }`,
      // The rolling-release prefetch is a network call and is best-effort in
      // production; a miss here exercises the local-store path.
      'fetch_main_attestation() { return 1; }',
    ].join('\n');
    const script = `${prelude}\n${body}\nset +e; derive_release_attestation ${JSON.stringify(head)}; rc=$?; set -e; echo "rc=$rc"`;
    return spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf-8' });
  }

  it('attempts a derive when no release-tree record exists and a base is available', () => {
    const { dir, store, log } = harness();
    const baseCommit = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).stdout.trim();
    const baseTree = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf-8' }).stdout.trim();
    // origin/main stays at the attested base; the release commit sits on top of it,
    // differing only by the version bump — exactly the real shape.
    spawnSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/main', baseCommit], { encoding: 'utf-8' });
    fs.writeFileSync(path.join(dir, 'cli/package.json'), '{"version":"1.0.1"}\n');
    spawnSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf-8' });
    spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'chore(release): 1.0.1'], { encoding: 'utf-8' });
    const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).stdout.trim();
    // A base record the real `require` accepts for the base tree.
    const id = JSON.parse(
      spawnSync('bash', [path.join(dir, 'scripts', 'release-attestation.sh'), 'identity', '--repo-root', dir, '--commit', baseCommit], { encoding: 'utf-8' }).stdout,
    );
    fs.writeFileSync(path.join(store, 'base.json'), JSON.stringify({
      schemaVersion: 1, candidateCommit: baseCommit, candidateTree: baseTree,
      lockfileDigest: id.lockfileDigest, policyVersion: id.policyVersion,
      toolchain: id.toolchain, platform: id.platform, suite: 'selected', conclusion: 'pass',
      tarball: { filename: 'x.tgz', digest: 'sha256:' + '0'.repeat(64) },
    }));
    const r = runDerive(dir, store, head, baseCommit);
    // The real function reached the producer with --inherit-suite-from and the store.
    const invoked = fs.existsSync(log) ? fs.readFileSync(log, 'utf-8') : '';
    expect(invoked, `stdout: ${r.stdout}${r.stderr}`).toContain('--inherit-suite-from');
    expect(invoked).toContain('--dir');
  });

  it('inherits from $BASE_SHA, not the remote tip, when the two diverge (PHNX-3705)', () => {
    // The review found the pre-existing derive test could not catch blocker 2:
    // its fixture happens to set origin/main == BASE_SHA, so reading either one
    // behaves identically. Here the tip is deliberately AHEAD of the base, and
    // only the BASE's tree is attested — so a derive that reads the tip finds no
    // base record and never reaches the producer.
    const { dir, store, log } = harness();
    const baseCommit = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).stdout.trim();
    const baseTree = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf-8' }).stdout.trim();
    // Advance the tip past the base, then cut the release commit from the BASE.
    fs.writeFileSync(path.join(dir, 'cli/other.txt'), 'moved on\n');
    spawnSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf-8' });
    spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'tip moves on'], { encoding: 'utf-8' });
    const tip = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).stdout.trim();
    spawnSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/main', tip], { encoding: 'utf-8' });
    expect(tip).not.toBe(baseCommit);

    const id = JSON.parse(
      spawnSync('bash', [path.join(dir, 'scripts', 'release-attestation.sh'), 'identity', '--repo-root', dir, '--commit', baseCommit], { encoding: 'utf-8' }).stdout,
    );
    fs.writeFileSync(path.join(store, 'base.json'), JSON.stringify({
      schemaVersion: 1, candidateCommit: baseCommit, candidateTree: baseTree,
      lockfileDigest: id.lockfileDigest, policyVersion: id.policyVersion,
      toolchain: id.toolchain, platform: id.platform, suite: 'selected', conclusion: 'pass',
      tarball: { filename: 'x.tgz', digest: 'sha256:' + '0'.repeat(64) },
    }));

    // The release commit: an UNATTESTED tree (reuse the tip's) hung off the BASE
    // as parent — exactly the shape release.sh builds with
    // `git commit-tree "$BRANCH_TREE" -p "$BASE_SHA"`. Its own tree must not be
    // attested, or derive short-circuits before it ever looks up a base.
    const tipTree = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf-8' }).stdout.trim();
    const releaseCommit = spawnSync(
      'git', ['-C', dir, 'commit-tree', tipTree, '-p', baseCommit, '-m', 'chore(release): x'],
      { encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.com' } },
    ).stdout.trim();
    expect(releaseCommit).not.toBe(baseCommit);

    const r = runDerive(dir, store, releaseCommit, baseCommit);
    const invoked = fs.existsSync(log) ? fs.readFileSync(log, 'utf-8') : '';
    expect(invoked, `derive must inherit from the base; stdout: ${r.stdout}${r.stderr}`).toContain('--inherit-suite-from');
  });

  it('fails soft (never dies) when there is no attested base to inherit from', () => {
    const { dir, store, log } = harness();
    const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).stdout.trim();
    const r = runDerive(dir, store, head);
    // No base record in the store -> returns non-zero WITHOUT killing the release,
    // so the caller still falls through to the loud `require`.
    expect(r.stdout).toContain('rc=1');
    expect(fs.existsSync(log)).toBe(false);
  });

  it('the REAL call site survives a derive failure instead of killing the release', () => {
    // The bug this exists to catch: release.sh runs under `set -euo pipefail`, and
    // a BARE call to a function that returns non-zero aborts the whole script — so
    // an unguarded call would die before wait_for_attestation's poll, the documented
    // fallback, ever runs. That is strictly worse than the pre-fix behavior.
    //
    // So: take the real function body AND the real call-site line out of release.sh,
    // run them together under the real production flags, and require that execution
    // continues past the call. No text matching — a sentinel that only prints if the
    // shell is still alive.
    const { dir, store } = harness();
    const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).stdout.trim();
    const body = RELEASE_SH.match(/^derive_release_attestation\(\) \{[\s\S]*?^\}/m)?.[0];
    const callSite = RELEASE_SH.split('\n').find((l) => l.trim().startsWith('derive_release_attestation "$RELEASE_CI_HEAD"'));
    expect(callSite, 'the release-tree gate must call derive_release_attestation').toBeDefined();
    const script = [
      'set -euo pipefail',            // release.sh:49, verbatim
      'bold() { :; }', 'green() { :; }', 'yellow() { :; }',
      `REPO_ROOT=${JSON.stringify(dir)}`,
      'DEFAULT_BRANCH=main',
      `RELEASE_CI_HEAD=${JSON.stringify(head)}`,
      `attestation_store_dir() { printf '%s\\n' ${JSON.stringify(store)}; }`,
      'fetch_main_attestation() { return 1; }',
      body,
      callSite,                        // the shipped line, unmodified
      'echo REACHED_THE_POLL',
    ].join('\n');
    // Empty store => no attested base => derive returns non-zero. This is the
    // ordinary "no base yet" path the function's own docstring names.
    const r = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf-8' });
    expect(r.stdout, `died before the fallback; stderr: ${r.stderr}`).toContain('REACHED_THE_POLL');
    expect(r.status).toBe(0);
  });
});

/**
 * PHNX-3705 — the release base may be an attested ANCESTOR of the remote tip.
 *
 * Two halves, and the review that caught this is why both are here: relaxing the
 * base guard without repointing the gates was a no-op change that still died at
 * [2/6]. The guard is exercised by executing the real block; the two gate
 * references are asserted textually and labelled as such — they are single
 * `$BASE_SHA^{tree}` argument sites with no seam to drive, and the behavior they
 * produce is covered end-to-end in release-worktree.test.ts.
 */
describeRelease('release.sh releases from an attested ancestor (PHNX-3705)', () => {
  /** Run the REAL base-freshness block, lifted out of release.sh. */
  function runBaseCheck(dir: string, baseRef: string) {
    const block = RELEASE_SH.match(
      /^if \[\[ "\$BASE_SHA" != "\$REMOTE" \]\]; then[\s\S]*?^fi/m,
    )?.[0];
    expect(block, 'the base-freshness block must exist in release.sh').toBeDefined();
    const script = [
      'set -euo pipefail',
      'die() { echo "die: $*" >&2; exit 9; }',
      'gray() { echo "$*"; }',
      `cd ${JSON.stringify(dir)}`,
      'DEFAULT_BRANCH=main',
      `BASE_SHA="$(git rev-parse ${JSON.stringify(baseRef)})"`,
      'REMOTE="$(git rev-parse origin/main)"',
      block,
      'echo PASSED_BASE_CHECK',
    ].join('\n');
    return spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
  }

  function repo(): { dir: string; base: string; tip: string; off: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-base-check-'));
    const env = {
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.com',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.com',
    };
    const g = (...a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf-8', env: { ...process.env, ...env } });
    spawnSync('git', ['init', '-q', '-b', 'main', dir], { encoding: 'utf-8' });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n'); g('add', '-A'); g('commit', '-q', '-m', 'base');
    const base = g('rev-parse', 'HEAD').stdout.trim();
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n'); g('add', '-A'); g('commit', '-q', '-m', 'tip');
    const tip = g('rev-parse', 'HEAD').stdout.trim();
    g('update-ref', 'refs/remotes/origin/main', tip);
    // A commit off main's history entirely.
    const blob = spawnSync('git', ['-C', dir, 'hash-object', '-w', '--stdin'], { input: 'x\n', encoding: 'utf-8' }).stdout.trim();
    const tree = spawnSync('git', ['-C', dir, 'mktree'], { input: `100644 blob ${blob}\tx.txt\n`, encoding: 'utf-8' }).stdout.trim();
    const off = spawnSync('git', ['-C', dir, 'commit-tree', tree, '-m', 'off'], { encoding: 'utf-8', env: { ...process.env, ...env } }).stdout.trim();
    return { dir, base, tip, off };
  }

  it('accepts the tip itself (unchanged behavior)', () => {
    const { dir, tip } = repo();
    const r = runBaseCheck(dir, tip);
    expect(r.stdout, r.stderr).toContain('PASSED_BASE_CHECK');
  });

  it('accepts an ANCESTOR of the tip, which the old exact-match guard rejected', () => {
    const { dir, base } = repo();
    const r = runBaseCheck(dir, base);
    expect(r.stdout, r.stderr).toContain('PASSED_BASE_CHECK');
    expect(r.stdout).toContain('newest attested ancestor');
  });

  it('still DIES on a base that is not on the branch history', () => {
    // The relaxation must not become "any commit goes".
    const { dir, off } = repo();
    const r = runBaseCheck(dir, off);
    expect(r.stdout).not.toContain('PASSED_BASE_CHECK');
    expect(r.stderr).toContain('is not an ancestor of');
  });

  it('gates phase 2 and the derive base on $BASE_SHA, never the live remote tip', () => {
    // TEXTUAL, deliberately: both are single argument sites with no seam to
    // drive. They are the exact lines whose absence made the first version of
    // PHNX-3705 a no-op that still died at [2/6], so they are worth pinning even
    // in this weaker form; the behavior itself is covered in
    // release-worktree.test.ts by asserting the HEAD the release actually runs at.
    expect(RELEASE_SH).toContain('wait_for_attestation "$(git rev-parse "$BASE_SHA^{tree}")"');
    expect(RELEASE_SH).toContain('base_tree="$(git rev-parse "$BASE_SHA^{tree}" 2>/dev/null)"');
    expect(RELEASE_SH).not.toContain('wait_for_attestation "$(git rev-parse "origin/$DEFAULT_BRANCH^{tree}")"');
    expect(RELEASE_SH).not.toContain('base_tree="$(git rev-parse "origin/$DEFAULT_BRANCH^{tree}" 2>/dev/null)"');
  });
});
