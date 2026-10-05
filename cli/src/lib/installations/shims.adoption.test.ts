import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adoptShadowingLauncher,
  releaseAdoptedLauncher,
  findAdoptableLauncher,
  getAdoptedRecordPath,
  getPathShadowingExecutable,
  generateShimScript,
} from './shims.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-adopt-test-'));
}

function fixture(cli: string) {
  const root = tmp();
  const shimsDir = path.join(root, '.agents', '.cache', 'shims');
  const historyDir = path.join(root, '.agents', '.history');
  fs.mkdirSync(shimsDir, { recursive: true });
  const shimPath = path.join(shimsDir, cli);
  fs.writeFileSync(shimPath, '#!/bin/bash\n');
  fs.chmodSync(shimPath, 0o755);

  const harnessBinDir = path.join(root, `.${cli}`, 'bin');
  fs.mkdirSync(harnessBinDir, { recursive: true });
  const realBin = path.join(harnessBinDir, cli);
  fs.writeFileSync(realBin, '#!/bin/bash\necho native\n');
  fs.chmodSync(realBin, 0o755);

  const localBin = path.join(root, '.local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  const link = path.join(localBin, cli);
  fs.symlinkSync(realBin, link);

  return { root, shimsDir, historyDir, shimPath, realBin, link };
}

describe('adoptShadowingLauncher', () => {
  test('symlink launcher: repoints to shim, records original + launcher, idempotent', () => {
    const { shimsDir, historyDir, shimPath, realBin, link } = fixture('grok');

    const result = adoptShadowingLauncher('grok', { shadowedBy: link, shimsDir, historyDir });
    expect(result.adopted).toBe(true);

    expect(fs.realpathSync(link)).toBe(fs.realpathSync(shimPath));

    const record = fs.readFileSync(getAdoptedRecordPath('grok', historyDir), 'utf-8').split('\n');
    expect(record[0]).toBe(fs.realpathSync(realBin));
    expect(record[1]).toBe(path.resolve(link));
    expect(getAdoptedRecordPath('grok', historyDir)).toContain(`${path.sep}.history${path.sep}`);

    const again = adoptShadowingLauncher('grok', { shadowedBy: link, shimsDir, historyDir });
    expect(again.adopted).toBe(false);
    if (!again.adopted) expect(again.reason).toBe('already-adopted');
  });

  test('refuses to touch a REAL binary (only symlinks are adopted)', () => {
    const { shimsDir, historyDir, root } = fixture('droid');
    const realBin = path.join(root, '.local', 'bin', 'droid');
    fs.rmSync(realBin);
    fs.writeFileSync(realBin, 'ELF-ish native binary');
    fs.chmodSync(realBin, 0o755);

    const result = adoptShadowingLauncher('droid', { shadowedBy: realBin, shimsDir, historyDir });
    expect(result.adopted).toBe(false);
    if (!result.adopted) expect(result.reason).toBe('not-a-symlink');
    expect(fs.readFileSync(realBin, 'utf-8')).toBe('ELF-ish native binary');
    expect(fs.existsSync(getAdoptedRecordPath('droid', historyDir))).toBe(false);
  });

  test('release restores the launcher from the record regardless of PATH (M3)', () => {
    const { shimsDir, historyDir, realBin, link } = fixture('grok');
    adoptShadowingLauncher('grok', { shadowedBy: link, shimsDir, historyDir });

    const restored = releaseAdoptedLauncher('grok', { shimsDir, historyDir });
    expect(restored).toBe(fs.realpathSync(realBin));
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(realBin));
    expect(fs.existsSync(getAdoptedRecordPath('grok', historyDir))).toBe(false);

    expect(releaseAdoptedLauncher('grok', { shimsDir, historyDir })).toBeNull();
  });

  test('the record survives a .cache wipe (M1 — durable reverse pointer)', () => {
    const { shimsDir, historyDir, realBin, link } = fixture('grok');
    adoptShadowingLauncher('grok', { shadowedBy: link, shimsDir, historyDir });
    fs.rmSync(shimsDir, { recursive: true });
    const restored = releaseAdoptedLauncher('grok', { shimsDir, historyDir });
    expect(restored).toBe(fs.realpathSync(realBin));
  });
});

describe('findAdoptableLauncher', () => {
  test('finds a ~/.local/bin symlink resolving outside the shims dir', () => {
    const { root, shimsDir, link } = fixture('grok');
    const found = findAdoptableLauncher('grok', { homeDir: root, shimsDir });
    expect(found).toBe(link);
  });

  test('ignores a real binary and a broken symlink', () => {
    const { root, shimsDir } = fixture('grok');
    const localBin = path.join(root, '.local', 'bin');
    fs.rmSync(path.join(localBin, 'grok'));
    fs.writeFileSync(path.join(localBin, 'grok'), 'native');
    expect(findAdoptableLauncher('grok', { homeDir: root, shimsDir })).toBeNull();

    fs.rmSync(path.join(localBin, 'grok'));
    fs.symlinkSync(path.join(root, 'does-not-exist'), path.join(localBin, 'grok'));
    expect(findAdoptableLauncher('grok', { homeDir: root, shimsDir })).toBeNull();
  });

  test('ignores a launcher already pointing into the shims dir', () => {
    const { root, shimsDir, shimPath } = fixture('grok');
    const local = path.join(root, '.local', 'bin', 'grok');
    fs.rmSync(local);
    fs.symlinkSync(shimPath, local);
    expect(findAdoptableLauncher('grok', { homeDir: root, shimsDir })).toBeNull();
  });
});

describe('getPathShadowingExecutable — adopted launcher is NOT a shadow', () => {
  test('a symlink resolving to our shim is not reported as a shadow', () => {
    const { shimsDir, shimPath, link } = fixture('grok');
    adoptShadowingLauncher('grok', {
      shadowedBy: link,
      shimsDir,
      historyDir: path.join(path.dirname(shimsDir), '.history'),
    });
    const shadow = getPathShadowingExecutable('grok', {
      pathDirs: [path.dirname(link), shimsDir],
      shimPath,
    });
    expect(shadow).toBeNull();
  });

  test('a real competing binary ahead of the shim IS still a shadow', () => {
    const { shimsDir, shimPath, root } = fixture('grok');
    const otherDir = path.join(root, 'other', 'bin');
    fs.mkdirSync(otherDir, { recursive: true });
    const realGrok = path.join(otherDir, 'grok');
    fs.writeFileSync(realGrok, '#!/bin/bash\necho other\n');
    fs.chmodSync(realGrok, 0o755);
    const shadow = getPathShadowingExecutable('grok', {
      pathDirs: [otherDir, shimsDir],
      shimPath,
    });
    expect(shadow).toBe(realGrok);
  });
});

describe('generated shim fall-through', () => {
  test('is valid bash and reads the adopted-original record by absolute path', () => {
    const script = generateShimScript('grok');

    const f = path.join(tmp(), 'grok');
    fs.writeFileSync(f, script);
    execFileSync('bash', ['-n', f]);

    expect(script).toContain('ADOPTED_ORIGINAL="$AGENTS_USER_DIR/.history/adopted-launchers/$CLI_COMMAND"');
    expect(script).toContain('IFS= read -r orig < "$ADOPTED_ORIGINAL"');
    expect(script).toContain('exec_adopted_original');
    expect(script).toContain('adopted_original_bin');
  });

  test('droid shim prefers the adopted record before its fixed ~/.local/bin path', () => {
    const script = generateShimScript('droid');
    const droidBranch = script.slice(script.indexOf('AGENT" = "droid"'));
    expect(droidBranch.indexOf('adopted_original_bin')).toBeLessThan(
      droidBranch.indexOf('$HOME/.local/bin/droid'),
    );
  });

  test.skipIf(process.platform === 'win32')('generic Cursor shim rejects a managed binary that resolves back to itself', () => {
    const root = tmp();
    const userDir = path.join(root, '.agents');
    const shimsDir = path.join(userDir, '.cache', 'shims');
    const historyDir = path.join(userDir, '.history');
    const version = '2026.08.04';
    const nativeDir = path.join(root, '.local', 'share', 'cursor-agent', 'versions', version);
    const launcherDir = path.join(root, '.local', 'bin');
    fs.mkdirSync(shimsDir, { recursive: true });
    fs.mkdirSync(nativeDir, { recursive: true });
    fs.mkdirSync(launcherDir, { recursive: true });

    const native = path.join(nativeDir, 'cursor-agent');
    fs.writeFileSync(native, '#!/bin/bash\nprintf "native:%s\\n" "$*"\n');
    fs.chmodSync(native, 0o755);

    const shim = path.join(shimsDir, 'cursor-agent');
    fs.writeFileSync(shim, generateShimScript('cursor'));
    fs.chmodSync(shim, 0o755);

    const launcher = path.join(launcherDir, 'cursor-agent');
    fs.symlinkSync(shim, launcher);
    const agentsBin = path.join(launcherDir, 'agents');
    const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
    fs.writeFileSync(agentsBin, `#!/bin/bash\nexec "${process.execPath}" "${cli}" "$@"\n`);
    fs.chmodSync(agentsBin, 0o755);
    const managedDir = path.join(historyDir, 'versions', 'cursor', version, 'node_modules', '.bin');
    fs.mkdirSync(managedDir, { recursive: true });
    fs.symlinkSync(launcher, path.join(managedDir, 'cursor-agent'));

    const recordDir = path.join(historyDir, 'adopted-launchers');
    fs.mkdirSync(recordDir, { recursive: true });
    fs.writeFileSync(path.join(recordDir, 'cursor-agent'), `${native}\n${launcher}\n`);
    fs.writeFileSync(path.join(userDir, 'agents.yaml'), `agents:\n  cursor: ${version}\n`);

    const projectSlug = root.replaceAll('/', '_').replaceAll(' ', '_');
    const sentinelDir = path.join(userDir, '.cache', 'launch-sync');
    fs.mkdirSync(sentinelDir, { recursive: true });
    fs.writeFileSync(path.join(sentinelDir, `cursor@${version}@${projectSlug}`), 'ok');

    const output = execFileSync('bash', [shim, '--version'], {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        PWD: root,
        PATH: `${launcherDir}:${process.env.PATH ?? ''}`,
        AGENTS_USER_DIR: userDir,
      },
      encoding: 'utf-8',
      timeout: 5_000,
    });
    expect(output.trim()).toBe('native:--version');
  });
});
