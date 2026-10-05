/** The release version arithmetic, tested against the real script. Nothing else in CI runs
 * `scripts/`, and release.sh needs live npm and GitHub before reaching the bump decision, so the
 * decision is extracted into validate-bump.sh. */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, 'validate-bump.sh');

function bumpKind(published: string, pkgJson: string, target: string, shim = '1.19.1') {
  const r = spawnSync('bash', [SCRIPT, published, pkgJson, shim, target], { encoding: 'utf-8' });
  return { kind: r.status === 0 ? r.stdout.trim() : null, status: r.status, stderr: r.stderr };
}

describe('validate-bump: single-step bumps from the published latest', () => {
  it('accepts patch, minor and major', () => {
    expect(bumpKind('1.20.74', '1.20.74', '1.20.75').kind).toBe('patch');
    expect(bumpKind('1.20.74', '1.20.74', '1.21.0').kind).toBe('minor');
    expect(bumpKind('1.20.74', '1.20.74', '2.0.0').kind).toBe('major');
  });

  it('rejects a skipped version', () => {
    expect(bumpKind('1.20.74', '1.20.74', '1.20.76').kind).toBeNull();
    expect(bumpKind('1.20.74', '1.20.74', '1.22.0').kind).toBeNull();
  });

  it('rejects going backwards', () => {
    expect(bumpKind('1.20.74', '1.20.74', '1.20.73').kind).toBeNull();
  });
});

describe('validate-bump: main ahead of the registry', () => {
  it('publishes the version main already carries (phnx-catchup)', () => {
    expect(bumpKind('1.20.70', '1.20.75', '1.20.75').kind).toBe('phnx-catchup');
  });

  /** The 1.20.75 incident: a merged release PR whose squash pulled in concurrent main commits
   * cannot be published, and before patch-from-main the next patch read as a skipped version,
   * leaving no patch-level path. */
  it('accepts the next patch after an unpublishable main (patch-from-main)', () => {
    expect(bumpKind('1.20.74', '1.20.75', '1.20.76').kind).toBe('patch-from-main');
  });

  it('rejects skipping TWO past an unpublishable main', () => {
    expect(bumpKind('1.20.74', '1.20.75', '1.20.77').kind).toBeNull();
  });

  it('does not loosen the normal path when main equals the registry', () => {
    expect(bumpKind('1.20.74', '1.20.74', '1.20.76').kind).toBeNull();
  });

  it('rejects a target derived from a main BEHIND the registry', () => {
    expect(bumpKind('1.20.74', '1.20.70', '1.20.71').kind).toBeNull();
  });

  it('compares the whole triple, not just the patch component', () => {
    expect(bumpKind('1.21.0', '1.20.75', '1.20.76').kind).toBeNull();
    expect(bumpKind('2.0.0', '1.20.75', '1.20.76').kind).toBeNull();
  });

  it('carries the same rule across a minor or major main', () => {
    expect(bumpKind('1.20.74', '1.21.0', '1.21.1').kind).toBe('patch-from-main');
    expect(bumpKind('1.20.74', '2.0.0', '2.0.1').kind).toBe('patch-from-main');
  });

  it('lets a retry after a failed publish resolve again', () => {
    expect(bumpKind('1.20.74', '1.20.76', '1.20.76').kind).toBe('phnx-catchup');
  });
});

describe('validate-bump: shim catch-up', () => {
  it('republishes the current latest when only the frozen shim is behind', () => {
    expect(bumpKind('1.20.74', '1.20.74', '1.20.74', '1.19.1').kind).toBe('shim-catchup');
  });

  it('does not fire when the shim is already at the target', () => {
    expect(bumpKind('1.20.74', '1.20.74', '1.20.74', '1.20.74').kind).toBeNull();
  });
});

describe('validate-bump: the rejection message', () => {
  it('lists the main-ahead options only when main actually is ahead', () => {
    const ahead = bumpKind('1.20.74', '1.20.75', '9.9.9').stderr;
    expect(ahead).toContain('phnx-catchup');
    expect(ahead).toContain('1.20.76');

    const behind = bumpKind('1.20.74', '1.20.70', '9.9.9').stderr;
    expect(behind).not.toContain('patch-from-main');
    expect(behind).not.toContain('phnx-catchup');
    expect(behind).toContain('1.20.75');
  });

  it('exits 2 on wrong argument count', () => {
    const r = spawnSync('bash', [SCRIPT, '1.0.0'], { encoding: 'utf-8' });
    expect(r.status).toBe(2);
  });
});
