import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Once an agent is installed only as isolated copies, nothing the framework does can adopt it.
// Protection is derived from the `.isolated` markers on disk and enforced inside the primitives.
describe.skipIf(process.platform === 'win32')('isolation boundary', () => {
  let home: string;
  const V = '9.9.4';

  const versionDir = (agent: string, v: string) =>
    path.join(home, '.agents', '.history', 'versions', agent, v);
  const shimsDir = () => path.join(home, '.agents', '.cache', 'shims');
  const realConfig = (agent = '.codex') => path.join(home, agent);
  const launcher = () => path.join(home, 'npm-global', 'bin', 'codex');

  function plant(agent: string, v: string, cli: string, { isolated = true } = {}) {
    const binDir = path.join(versionDir(agent, v), 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, cli), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(binDir, cli), 0o755);
    fs.mkdirSync(path.join(versionDir(agent, v), 'home', `.${agent}`), { recursive: true });
    if (isolated) fs.writeFileSync(path.join(versionDir(agent, v), '.isolated'), 'x\n');
  }

  function run(...args: string[]): { out: string; status: number } {
    try {
      const out = execFileSync('bun', [path.resolve(process.cwd(), 'src/index.ts'), ...args], {
        cwd: process.cwd(),
        env: {
          ...process.env, HOME: home, AGENTS_REAL_HOME: home, SHELL: '/bin/bash',
          AGENTS_NO_NUDGE: '1', FORCE_COLOR: '0',
          PATH: `${path.join(home, 'npm-global', 'bin')}:${process.env.PATH}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString('utf-8');
      return { out, status: 0 };
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer; status?: number };
      return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, status: err.status ?? 1 };
    }
  }

  /** Nothing that can be hijacked has moved. */
  function assertNothingAdopted() {
    expect(fs.readlinkSync(launcher())).toBe('../lib/node_modules/@openai/codex/bin/codex.js');
    expect(fs.existsSync(realConfig())).toBe(false);
    const shims = fs.existsSync(shimsDir()) ? fs.readdirSync(shimsDir()) : [];
    expect(shims).not.toContain('codex');
    expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf-8')).not.toContain('.agents/.cache/shims');
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'isolation-boundary-'));
    const pkgBin = path.join(home, 'npm-global', 'lib', 'node_modules', '@openai', 'codex', 'bin');
    fs.mkdirSync(pkgBin, { recursive: true });
    fs.mkdirSync(path.join(home, 'npm-global', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkgBin, 'codex.js'), '#!/bin/sh\necho LOCAL-CODEX\n');
    fs.chmodSync(path.join(pkgBin, 'codex.js'), 0o755);
    fs.symlinkSync('../lib/node_modules/@openai/codex/bin/codex.js', launcher());
    fs.writeFileSync(path.join(home, '.bashrc'), '# user rc\n');
    const systemDir = path.join(home, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: systemDir, stdio: 'ignore' });
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('refuses `add` of a normal version — before spending a network install', () => {
    plant('codex', V, 'codex');
    const r = run('add', 'codex@9.9.9');
    expect(r.out).toContain('installed only as isolated copies');
    expect(r.out).toContain('--isolated');
    // Refused up front: no new version dir was created.
    expect(fs.existsSync(versionDir('codex', '9.9.9'))).toBe(false);
    assertNothingAdopted();
  }, 180_000);

  it('refuses `import`, which exists to adopt', () => {
    plant('codex', V, 'codex');
    const r = run('import', 'codex');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('installed only as isolated copies');
    assertNothingAdopted();
  }, 180_000);

  it('refuses `doctor --adopt`, the launcher hijack itself', () => {
    plant('codex', V, 'codex');
    const r = run('doctor', '--adopt', 'codex');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('installed only as isolated copies');
    assertNothingAdopted();
  }, 180_000);

  it('the refusal explains both ways out', () => {
    plant('codex', V, 'codex');
    const out = run('import', 'codex').out;
    expect(out).toContain(`agents add codex@<version> --isolated`);
    expect(out).toContain(`agents remove codex@${V} --isolated`);
  }, 180_000);

  it('protection is PER-AGENT — an isolated codex constrains nothing about claude', () => {
    plant('codex', V, 'codex');
    plant('claude', '1.2.3', 'claude', { isolated: false });
    // claude has a normal install, so it is not protected: setting its default works.
    const r = run('use', 'claude@1.2.3');
    expect(r.status).toBe(0);
    expect(r.out).not.toContain('installed only as isolated copies');
  }, 180_000);

  it('an agent with any NORMAL version is not protected', () => {
    plant('codex', V, 'codex');
    plant('codex', '9.9.5', 'codex', { isolated: false });
    // Mixed installs: codex already has an adopting install, so there is no
    // boundary left to defend and `use` behaves normally.
    const r = run('use', 'codex@9.9.5');
    expect(r.out).not.toContain('installed only as isolated copies');
  }, 180_000);

  it("setup's own hand-rolled adoption is closed too — and scaffolding can't disarm the check", () => {
    plant('codex', V, 'codex');
    // The real unmanaged config is still there: isolated installs never touch it,
    // so this is the ordinary state, and it is what setup offers to adopt.
    fs.mkdirSync(realConfig(), { recursive: true });
    fs.writeFileSync(path.join(realConfig(), 'config.toml'), 'model = "mine"\n');

    // setup adopts inline (rename + symlink) without calling switchConfigSymlink, and
    // its FIRST action creates <version>/home — which, if bare dirs counted as
    // non-isolated installs, would flip protection off before any gate is reached.
    const r = run('setup', '--force');
    expect(r.out).not.toContain('is now managed');

    // The real config is still a real directory holding the user's content.
    expect(fs.lstatSync(realConfig()).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(realConfig(), 'config.toml'), 'utf-8')).toContain('mine');
    expect(fs.readlinkSync(launcher())).toBe('../lib/node_modules/@openai/codex/bin/codex.js');
  }, 180_000);

  it('removing the isolated copies drops protection — the inherent escape hatch', () => {
    plant('codex', V, 'codex');
    expect(run('import', 'codex').status).not.toBe(0);

    expect(run('remove', `codex@${V}`, '--isolated').status).toBe(0);
    // No isolated copies left => not protected => the refusal no longer fires.
    // (import still fails here for unrelated reasons — no package to adopt — but
    // it must no longer be the BOUNDARY that stops it.)
    expect(run('import', 'codex').out).not.toContain('installed only as isolated copies');
  }, 180_000);
});
