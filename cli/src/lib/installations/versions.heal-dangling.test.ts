import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';


const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-pointers-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function nodeExecPath(): string {
  if (!('bun' in process.versions)) return process.execPath;
  const binary = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, binary);
    if (fs.existsSync(candidate)) return candidate;
  }
  return binary;
}

function runInHome(home: string, body: string): Record<string, unknown> {
  const moduleUrl = pathToFileURL(path.resolve('src/lib/installations/versions.ts')).href;
  const tsxBin = path.resolve('node_modules/tsx/dist/cli.mjs');
  const child = spawnSync(nodeExecPath(), [tsxBin, '-e', `
    import * as fs from 'fs';
    import * as path from 'path';
    import {
      healDanglingVersionPointers,
      setGlobalDefault,
      getGlobalDefault,
      setIsolatedDefault,
      getIsolatedDefault,
      resolveVersion,
      isVersionInstalled,
    } from ${JSON.stringify(moduleUrl)};
    const home = ${JSON.stringify(home)};
    const versionsRoot = path.join(home, '.agents', '.history', 'versions');

    function grokHome(version) {
      return path.join(versionsRoot, 'grok', version, 'home', '.grok');
    }
    function installGrok(version) {
      const downloads = path.join(grokHome(version), 'downloads');
      fs.mkdirSync(downloads, { recursive: true });
      fs.writeFileSync(path.join(downloads, 'grok-' + version), 'binary');
    }
    function leftoverGrok(version) {
      fs.mkdirSync(grokHome(version), { recursive: true });
    }
    function isolateGrok(version) {
      fs.writeFileSync(path.join(versionsRoot, 'grok', version, '.isolated'), '');
    }
    function pointConfigAt(version) {
      const link = path.join(home, '.grok');
      try { fs.unlinkSync(link); } catch {}
      fs.symlinkSync(grokHome(version), link, process.platform === 'win32' ? 'junction' : undefined);
    }
    function configSymlinkTargetVersion() {
      const link = path.join(home, '.grok');
      const target = fs.readlinkSync(link).replace(/\\\\/g, '/');
      const m = target.match(/versions\\/grok\\/([^/]+)\\/home/);
      return m ? m[1] : null;
    }
    (async () => {
      ${body}
    })().catch((e) => {
      console.error(e);
      process.exit(1);
    });
  `], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENTS_REAL_HOME: home,
      AGENTS_DEVICES_DIR: path.join(home, '.agents', '.history', 'devices'),
    },
    encoding: 'utf-8',
  });
  expect(child.status, child.stderr + '\n' + child.stdout).toBe(0);
  const lines = child.stdout.trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

describe('healDanglingVersionPointers (RUSH-2471)', () => {
  it('heals a dead global default AND symlink together, so sync resolution stops returning the dead version', () => {
    const home = makeTempHome();
    const res = runInHome(home, `
      installGrok('0.2.82');
      installGrok('0.2.91');
      leftoverGrok('1.0.0');
      setGlobalDefault('grok', '1.0.0');
      pointConfigAt('1.0.0');

      const healed = await healDanglingVersionPointers('grok', process.cwd());
      console.log(JSON.stringify({
        healed,
        symlinkNow: configSymlinkTargetVersion(),
        defaultNow: getGlobalDefault('grok'),
        resolvesTo: resolveVersion('grok', process.cwd()),
        resolvesToInstalled: isVersionInstalled('grok', resolveVersion('grok', process.cwd())),
      }));
    `);
    expect(res.healed).toEqual({
      globalDefault: { from: '1.0.0', to: '0.2.91' },
      configSymlink: { from: '1.0.0', to: '0.2.91' },
    });
    expect(res.symlinkNow).toBe('0.2.91');
    expect(res.defaultNow).toBe('0.2.91');
    expect(res.resolvesTo).toBe('0.2.91');
    expect(res.resolvesToInstalled).toBe(true);
  });

  it('repoints a dangling symlink to the newest installed version when there is no global default', () => {
    const home = makeTempHome();
    const res = runInHome(home, `
      installGrok('0.2.82');
      installGrok('0.2.91');
      leftoverGrok('1.0.0');
      pointConfigAt('1.0.0');

      const healed = await healDanglingVersionPointers('grok', process.cwd());
      console.log(JSON.stringify({ healed, symlinkNow: configSymlinkTargetVersion() }));
    `);
    expect(res.healed).toEqual({ configSymlink: { from: '1.0.0', to: '0.2.91' } });
    expect(res.symlinkNow).toBe('0.2.91');
  });

  it('never repoints the real symlink at an isolated version (resolveVersion isolated fallback)', () => {
    const home = makeTempHome();
    const res = runInHome(home, `
      installGrok('0.2.91');
      installGrok('0.3.0'); isolateGrok('0.3.0');
      setIsolatedDefault('grok', '0.3.0');
      leftoverGrok('1.0.0');
      pointConfigAt('1.0.0');

      const healed = await healDanglingVersionPointers('grok', process.cwd());
      console.log(JSON.stringify({ healed, symlinkNow: configSymlinkTargetVersion() }));
    `);
    expect(res.healed).toEqual({ configSymlink: { from: '1.0.0', to: '0.2.91' } });
    expect(res.symlinkNow).toBe('0.2.91');
  });

  it('does not crash (or repoint at an isolated install) when no non-isolated version survives', () => {
    const home = makeTempHome();
    const res = runInHome(home, `
      installGrok('0.3.0'); isolateGrok('0.3.0');
      setGlobalDefault('grok', '1.0.0');
      leftoverGrok('1.0.0');
      pointConfigAt('1.0.0');

      let error = null, healed = null, symlinkNow = null;
      try {
        healed = await healDanglingVersionPointers('grok', process.cwd());
        symlinkNow = configSymlinkTargetVersion();
      } catch (e) { error = String((e && e.message) || e); }
      console.log(JSON.stringify({ error, healed, symlinkNow }));
    `);
    expect(res.error).toBeNull();
    expect(res.healed).toEqual({ globalDefault: { from: '1.0.0', to: null } });
    expect(res.symlinkNow).toBe('1.0.0');
  });

  it('heals a dead isolated default onto the newest remaining isolated install', () => {
    const home = makeTempHome();
    const res = runInHome(home, `
      leftoverGrok('0.2.0'); isolateGrok('0.2.0');
      installGrok('0.3.0'); isolateGrok('0.3.0');
      setIsolatedDefault('grok', '0.2.0');

      const healed = await healDanglingVersionPointers('grok', process.cwd());
      console.log(JSON.stringify({ healed, isolatedNow: getIsolatedDefault('grok') }));
    `);
    expect(res.healed).toEqual({ isolatedDefault: { from: '0.2.0', to: '0.3.0' } });
    expect(res.isolatedNow).toBe('0.3.0');
  });

  it('leaves installed pointers untouched (a deliberate agents-use choice)', () => {
    const home = makeTempHome();
    const res = runInHome(home, `
      installGrok('0.2.82');
      installGrok('0.2.91');
      setGlobalDefault('grok', '0.2.82');
      pointConfigAt('0.2.82');

      const healed = await healDanglingVersionPointers('grok', process.cwd());
      console.log(JSON.stringify({ healed, symlinkNow: configSymlinkTargetVersion(), defaultNow: getGlobalDefault('grok') }));
    `);
    expect(res.healed).toEqual({});
    expect(res.symlinkNow).toBe('0.2.82');
    expect(res.defaultNow).toBe('0.2.82');
  });

  it('does not adopt a real (non-symlink) config directory', () => {
    const home = makeTempHome();
    const res = runInHome(home, `
      installGrok('0.2.91');
      fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
      fs.writeFileSync(path.join(home, '.grok', 'user-file'), 'keep me');

      const healed = await healDanglingVersionPointers('grok', process.cwd());
      const stat = fs.lstatSync(path.join(home, '.grok'));
      console.log(JSON.stringify({
        healed,
        isSymlink: stat.isSymbolicLink(),
        userFileKept: fs.existsSync(path.join(home, '.grok', 'user-file')),
      }));
    `);
    expect(res.healed).toEqual({});
    expect(res.isSymlink).toBe(false);
    expect(res.userFileKept).toBe(true);
  });
});
