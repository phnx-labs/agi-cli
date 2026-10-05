import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';


describe.skipIf(process.platform === 'win32')('runSelfHeal — shims/shadowing/path against a planted home', () => {
  let home: string;
  let binDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-int-'));
    fs.mkdirSync(path.join(home, '.agents', '.history', 'versions', 'claude', '2.0.0'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents:\n  claude: "2.0.0"\n');
    binDir = path.join(home, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync('/bin/echo', path.join(binDir, 'claude'));
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  function runTwice(): {
    run1: Report; run2: Report; shimExists: boolean; launcherPointsAtShim: boolean;
  } {
    const modulePath = path.resolve(process.cwd(), 'src/lib/self-heal/registry.ts');
    const shimsPath = path.resolve(process.cwd(), 'src/lib/installations/shims.ts');
    const script = `
      import { runSelfHeal } from ${JSON.stringify(modulePath)};
      import { getShimPath } from ${JSON.stringify(shimsPath)};
      import fs from 'node:fs';
      const opts = { checks: ['shims', 'shadowing', 'path'], mode: 'safe' };
      const run1 = await runSelfHeal(opts);
      const run2 = await runSelfHeal(opts);
      const shim = getShimPath('claude');
      const launcher = ${JSON.stringify(path.join(binDir, 'claude'))};
      let launcherPointsAtShim = false;
      try { launcherPointsAtShim = fs.realpathSync(launcher) === fs.realpathSync(shim); } catch {}
      console.log(JSON.stringify({
        run1, run2,
        shimExists: fs.existsSync(shim),
        launcherPointsAtShim,
      }));
    `;
    const out = execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH}`, SHELL: '/bin/bash' },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString('utf-8');
    return JSON.parse(out);
  }

  it('regenerates the shim, adopts the symlink launcher, adds PATH — and is idempotent', () => {
    const { run1, run2, shimExists, launcherPointsAtShim } = runTwice();

    const c1 = byId(run1);
    expect(c1.shims.fixed.join(' ')).toContain('claude shim');
    expect(c1.shadowing.fixed.join(' ')).toContain('claude');
    expect(c1.shadowing.needsAttention).toEqual([]);
    expect(c1.path.fixed.join(' ')).toMatch(/added shims to PATH/i);

    expect(shimExists).toBe(true);
    expect(launcherPointsAtShim).toBe(true);
    expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf-8')).toContain('.agents');

    const c2 = byId(run2);
    expect(c2.shims.fixed).toEqual([]);
    expect(c2.shadowing.fixed).toEqual([]);
    expect(c2.path.fixed).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('runSelfHeal — isolated-only installs', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-isolated-'));
    const versionDir = path.join(home, '.agents', '.history', 'versions', 'codex', '0.145.0');
    fs.mkdirSync(path.join(versionDir, 'home'), { recursive: true });
    const binPath = path.join(versionDir, 'node_modules', '.bin', 'codex');
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(binPath, 0o755);
    fs.writeFileSync(path.join(versionDir, '.isolated'), `${new Date().toISOString()}\n`);
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('keeps isolated versions explicit and does not install bare shims or PATH entries', () => {
    const modulePath = path.resolve(process.cwd(), 'src/lib/self-heal/registry.ts');
    const statePath = path.resolve(process.cwd(), 'src/lib/state.ts');
    const script = `
      import { runSelfHeal } from ${JSON.stringify(modulePath)};
      import { getShimsDir } from ${JSON.stringify(statePath)};
      import fs from 'node:fs';
      import path from 'node:path';
      const report = await runSelfHeal({ checks: ['shims', 'path'], mode: 'safe' });
      const shims = getShimsDir();
      console.log(JSON.stringify({
        report,
        bareShim: fs.existsSync(path.join(shims, 'codex')),
        versionedAlias: fs.existsSync(path.join(shims, 'codex@0.145.0')),
        bashrc: fs.existsSync(${JSON.stringify(path.join(home, '.bashrc'))})
          ? fs.readFileSync(${JSON.stringify(path.join(home, '.bashrc'))}, 'utf-8')
          : '',
      }));
    `;
    const out = execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, SHELL: '/bin/bash' },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString('utf-8');
    const result = JSON.parse(out) as {
      report: Report;
      bareShim: boolean;
      versionedAlias: boolean;
      bashrc: string;
    };
    const checks = byId(result.report);

    expect(result.bareShim).toBe(false);
    expect(result.versionedAlias).toBe(true);
    expect(result.bashrc).not.toContain('.agents/.cache/shims');
    expect(checks.path.fixed).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('runSelfHeal — generated hook runtime wrappers', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-hook-runtime-'));
    fs.mkdirSync(path.join(home, '.agents', '.system'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents:\n  claude: "2.0.0"\n');
    fs.writeFileSync(
      path.join(home, '.agents', '.system', 'agents.yaml'),
      'hooks:\n  runtime-guard:\n    script: runtime-guard.sh\n    events: [PreToolUse]\n    matcher: Bash\n',
    );
    for (const version of ['2.0.0', '2.0.1']) {
      const versionDir = path.join(home, '.agents', '.history', 'versions', 'claude', version);
      const hooksDir = path.join(versionDir, 'home', '.claude', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.writeFileSync(path.join(hooksDir, 'runtime-guard.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const bin = path.join(versionDir, 'node_modules', '.bin', 'claude');
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('repairs a missing wrapper once per shared path, post-verifies it, then becomes a no-op', () => {
    const registryPath = path.resolve(process.cwd(), 'src/lib/self-heal/registry.ts');
    const hooksPath = path.resolve(process.cwd(), 'src/lib/hooks/install.ts');
    const hookCachePath = path.resolve(process.cwd(), 'src/lib/hooks/cache.ts');
    const versionsPath = path.resolve(process.cwd(), 'src/lib/installations/versions.ts');
    const script = `
      import { runSelfHeal } from ${JSON.stringify(registryPath)};
      import { registerHooksToSettings } from ${JSON.stringify(hooksPath)};
      import { getHookShimPath } from ${JSON.stringify(hookCachePath)};
      import { getVersionHomePath } from ${JSON.stringify(versionsPath)};
      import fs from 'node:fs';
      registerHooksToSettings('claude', getVersionHomePath('claude', '2.0.0'));
      const shim = getHookShimPath('runtime-guard');
      fs.rmSync(shim);
      const run1 = await runSelfHeal({ checks: ['hook-runtime'], mode: 'safe' });
      const statAfterRepair = fs.statSync(shim);
      const run2 = await runSelfHeal({ checks: ['hook-runtime'], mode: 'safe' });
      const statAfterNoop = fs.statSync(shim);
      console.log(JSON.stringify({ run1, run2, shim, executable: (statAfterRepair.mode & 0o111) !== 0,
        mtimeStable: statAfterRepair.mtimeMs === statAfterNoop.mtimeMs }));
    `;
    const out = execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        AGENTS_HOOK_SHIMS_DIR: path.join(home, 'hook-shims'),
        AGENTS_HOOK_CACHE_DIR: path.join(home, 'hook-cache'),
        AGENTS_LOGS_DIR: path.join(home, 'logs'),
        AGENTS_PERF_DIR: path.join(home, 'perf'),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString('utf-8');
    const result = JSON.parse(out) as { run1: Report; run2: Report; executable: boolean; mtimeStable: boolean };
    const first = byId(result.run1)['hook-runtime'];
    const second = byId(result.run2)['hook-runtime'];

    expect(first.fixed).toHaveLength(1);
    expect(first.needsAttention).toEqual([]);
    expect(result.executable).toBe(true);
    expect(second.fixed).toEqual([]);
    expect(second.needsAttention).toEqual([]);
    expect(result.mtimeStable).toBe(true);
  });

  it('surfaces one stable failure for an unusable destination without retrying in-pass', () => {
    const registryPath = path.resolve(process.cwd(), 'src/lib/self-heal/registry.ts');
    const hooksPath = path.resolve(process.cwd(), 'src/lib/hooks/install.ts');
    const hookCachePath = path.resolve(process.cwd(), 'src/lib/hooks/cache.ts');
    const script = `
      import { runSelfHeal } from ${JSON.stringify(registryPath)};
      import { getHookShimPath } from ${JSON.stringify(hookCachePath)};
      import fs from 'node:fs';
      const shim = getHookShimPath('runtime-guard');
      fs.mkdirSync(shim, { recursive: true });
      const report = await runSelfHeal({ checks: ['hook-runtime'], mode: 'safe' });
      console.log(JSON.stringify({ report, shimIsDirectory: fs.statSync(shim).isDirectory() }));
    `;
    const out = execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        AGENTS_HOOK_SHIMS_DIR: path.join(home, 'hook-shims'),
        AGENTS_HOOK_CACHE_DIR: path.join(home, 'hook-cache'),
        AGENTS_LOGS_DIR: path.join(home, 'logs'),
        AGENTS_PERF_DIR: path.join(home, 'perf'),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString('utf-8');
    const result = JSON.parse(out) as { report: Report; shimIsDirectory: boolean };
    const check = byId(result.report)['hook-runtime'];

    expect(check.fixed).toEqual([]);
    expect(check.needsAttention).toHaveLength(1);
    expect(check.needsAttention[0]).toContain('not a regular file');
    expect(result.shimIsDirectory).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('runSelfHeal — resources never sync into isolated homes', () => {
  let home: string;

  const versionHome = (version: string) =>
    path.join(home, '.agents', '.history', 'versions', 'claude', version, 'home');

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-iso-resources-'));
    for (const version of ['9.9.1', '9.9.2']) {
      const versionDir = path.join(home, '.agents', '.history', 'versions', 'claude', version);
      const binPath = path.join(versionDir, 'node_modules', '.bin', 'claude');
      fs.mkdirSync(path.dirname(binPath), { recursive: true });
      fs.writeFileSync(binPath, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(binPath, 0o755);
      fs.mkdirSync(path.join(versionDir, 'home', '.claude'), { recursive: true });
    }
    fs.writeFileSync(
      path.join(home, '.agents', '.history', 'versions', 'claude', '9.9.2', '.isolated'),
      `${new Date().toISOString()}\n`,
    );
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('heals the normal version home and leaves the isolated one empty', () => {
    const modulePath = path.resolve(process.cwd(), 'src/lib/self-heal/registry.ts');
    const statePath = path.resolve(process.cwd(), 'src/lib/state.ts');
    const script = `
      import { runSelfHeal } from ${JSON.stringify(modulePath)};
      import { getCommandsDir } from ${JSON.stringify(statePath)};
      import fs from 'node:fs';
      import path from 'node:path';
      // A shared command present centrally but in NEITHER version home.
      const commands = getCommandsDir();
      fs.mkdirSync(commands, { recursive: true });
      fs.writeFileSync(path.join(commands, 'leak-probe.md'), '# leak-probe\\n\\nshared\\n');
      const report = await runSelfHeal({ checks: ['resources'], mode: 'safe' });
      const cmd = (v) => path.join(${JSON.stringify(path.join(home, '.agents', '.history', 'versions', 'claude'))},
        v, 'home', '.claude', 'commands', 'leak-probe.md');
      console.log('__RESULT__' + JSON.stringify({
        report,
        normalHealed: fs.existsSync(cmd('9.9.1')),
        isolatedHealed: fs.existsSync(cmd('9.9.2')),
      }));
    `;
    const out = execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString('utf-8');
    const result = JSON.parse(out.split('__RESULT__')[1]) as {
      report: Report; normalHealed: boolean; isolatedHealed: boolean;
    };

    expect(result.normalHealed).toBe(true);
    expect(byId(result.report).resources.fixed.join(' ')).toContain('resource');
    expect(result.isolatedHealed).toBe(false);
    expect(fs.readdirSync(versionHome('9.9.2'), { recursive: true })).toEqual(['.claude']);
  }, 120_000);
});

interface CheckR { fixed: string[]; needsAttention: string[]; ok: boolean }
interface Report { checks: { id: string; result: CheckR | null; error?: string }[] }

function byId(r: Report): Record<string, CheckR> {
  const out: Record<string, CheckR> = {};
  for (const c of r.checks) out[c.id] = c.result ?? { fixed: [], needsAttention: [], ok: true };
  return out;
}
