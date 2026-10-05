import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const VERIFY = path.resolve(__dirname, 'verify-menubar-helper.sh');

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

const UNIVERSAL_MAGIC = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02]);
const THIN_MAGIC = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);

type Bundle = 'ticketed-universal' | 'ticketed-thin' | 'unticketed-universal' | 'absent' | 'no-executable';

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
      fs.writeFileSync(path.join(contents, 'CodeResources'), 'ticket-bytes\n');
    }
  }
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
    expect(out).toContain('1.22.44');
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
