/**
 * verify-menubar-helper.sh — the bundle gate for the staged menu-bar helper.
 *
 * Since PHNX-4036 the bundle at bin/MenubarHelper.app is the PUBLISHED release
 * staged by scripts/stage-menubar-helper.sh (source: phnx-labs/agi-menu), and
 * this gate is what that script runs after extraction. The checks are the same
 * ones that used to guard `npm pack`, and the incident they pin still applies:
 *
 * The regression this pins (RUSH-3031): 1.22.44 was packed on a Linux
 * attestation-producer box (no codesign, no xcrun), where every Apple-tool
 * signature/notarization check silently no-op'd, so an un-stapled, THIN
 * (single-arch) dev bundle shipped and Gatekeeper rejected it on every Mac
 * ("AGI Menu is not notarized/valid on this machine; skipping launch") — the
 * menu bar died fleet-wide until a manual rollback to 1.22.43. Off-Mac the
 * gate must still fail closed on (a) a bundle with no stapled ticket
 * (`Contents/CodeResources` is a plain file `stapler staple` writes, so its
 * absence is provable anywhere) and (b) a thin binary (the Mach-O fat magic
 * bytes are plain bytes on disk, readable with `od` on any OS).
 *
 * Runs the REAL script against real fixture bundles; xcrun/codesign absence
 * is the genuine environment on the Linux boxes that produce attestations
 * (no mocking) — including on a macOS test host, via a constructed PATH that
 * genuinely excludes codesign/xcrun (see buildLinuxLikePath below), so these
 * cases are exercised everywhere rather than skipped on macOS.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const VERIFY = path.resolve(__dirname, 'verify-menubar-helper.sh');

/**
 * A PATH containing ONLY the POSIX tools verify-menubar-helper.sh needs
 * (dirname, od, tr) and genuinely lacking codesign/xcrun — the real Linux
 * attestation-producer environment. Built from symlinks to whatever this
 * test host actually has, rather than hardcoding `/usr/bin` (which on macOS
 * DOES carry codesign/xcrun, so a naive minimal PATH still leaks them and
 * silently skips the very checks this test means to exercise off-Mac).
 */
function buildLinuxLikePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-gate-path-'));
  for (const tool of ['dirname', 'od', 'tr']) {
    const resolved = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf-8' }).stdout.trim();
    if (!resolved) throw new Error(`test setup: required tool not found on this host: ${tool}`);
    fs.symlinkSync(resolved, path.join(dir, tool));
  }
  return dir;
}
const LINUX_LIKE_PATH = buildLinuxLikePath();

// A real universal (fat) Mach-O header: FAT_MAGIC (0xCAFEBABE) followed by
// enough bytes that `od -An -tx1 -N4` still reads cleanly.
const UNIVERSAL_MAGIC = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02]);
// A thin (single-arch) Mach-O 64 header (MH_MAGIC_64) — NOT the fat magic.
const THIN_MAGIC = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);

type Bundle = 'ticketed-universal' | 'ticketed-thin' | 'unticketed-universal' | 'absent' | 'no-executable';

/** Stage the script + a fixture bundle in an isolated root and run the gate. */
function runGate(bundle: Bundle): { status: number | null; out: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-gate-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(VERIFY, path.join(root, 'scripts/verify-menubar-helper.sh'));
  if (bundle !== 'absent') {
    const contents = path.join(root, 'bin/MenubarHelper.app/Contents');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(contents, 'Info.plist'), '<plist/>\n');
    if (bundle !== 'no-executable') {
      const magic = bundle === 'ticketed-thin' ? THIN_MAGIC : UNIVERSAL_MAGIC;
      fs.writeFileSync(path.join(contents, 'MacOS/AGI Menu'), magic);
    }
    if (bundle === 'ticketed-universal' || bundle === 'ticketed-thin') {
      // The stapled notarization ticket `stapler staple` writes.
      fs.writeFileSync(path.join(contents, 'CodeResources'), 'ticket-bytes\n');
    }
  }
  // PATH without codesign/xcrun = the Linux producer environment.
  const r = spawnSync('/bin/bash', [path.join(root, 'scripts/verify-menubar-helper.sh')], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: LINUX_LIKE_PATH },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('verify-menubar-helper.sh off-Mac (no codesign/xcrun)', () => {
  it('fails closed on a bundle with NO stapled ticket — the 1.22.44 regression', () => {
    const { status, out } = runGate('unticketed-universal');
    expect(status).not.toBe(0);
    expect(out).toContain('NO stapled notarization ticket');
    expect(out).toContain('1.22.44'); // names the incident so the operator knows the stakes
  });

  it('fails closed on a THIN (single-arch) binary even with a stapled ticket — the other half of RUSH-3031', () => {
    const { status, out } = runGate('ticketed-thin');
    expect(status).not.toBe(0);
    expect(out).toContain('THIN (single-arch) binary');
    expect(out).toContain('RUSH-3031');
  });

  it('passes a ticketed, universal bundle', () => {
    const { status, out } = runGate('ticketed-universal');
    expect(status).toBe(0);
    expect(out).toContain('present, signed, notarized, and universal');
  });

  it('still fails closed when the bundle is absent entirely (the 1.20.22 gate)', () => {
    const { status, out } = runGate('absent');
    expect(status).not.toBe(0);
    expect(out).toContain('menubar helper missing');
  });

  it('fails closed when the bundle has no executable at all', () => {
    const { status, out } = runGate('no-executable');
    expect(status).not.toBe(0);
    expect(out).toContain('executable missing inside bundle');
  });
});
