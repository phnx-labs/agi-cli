/**
 * Tests for checkVersionHookWiring — the settings.json wiring inspector behind
 * `agents doctor`. The blind spot it closes: a hook FILE can be present in a
 * version home and byte-identical to source (doctor calls it "ok"), yet be
 * absent from settings.json's event array, so it never fires. These assert the
 * inspector catches that (UNWIRED), agrees with the real registrar when wiring
 * is intact, and flags a missing settings.json.
 *
 * Runs the inspector in a subprocess with HOME=testHome because the path
 * constants in state.ts capture HOME at module-load (see doctor-diff.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let testHome: string;
let userDir: string;
let systemDir: string;

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-wiring-test-'));
  userDir = path.join(testHome, '.agents');
  systemDir = path.join(userDir, '.system');
  fs.mkdirSync(systemDir, { recursive: true });
  // A concrete agents.yaml keeps the migrator from firing on a missing legacy
  // state (mirrors doctor-diff.test.ts).
  fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'agents:\n  claude: "2.0.0"\n');
});

afterEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

interface WiringReport {
  supported: boolean;
  settingsPath?: string;
  expected?: number;
  settingsMissing?: boolean;
  settingsUnparseable?: boolean;
  unwired: Array<{ name: string; event: string; command: string }>;
  runtimeBroken: Array<{ name: string; path: string; reason: string }>;
}

interface VersionHooksReport {
  dir: string;
  names: string[];
}

function runVersionHooksInventory(agent: string, version: string): VersionHooksReport {
  const modulePath = path.resolve(process.cwd(), 'src/lib/hooks/install.ts');
  const script = `
    const mod = await import(${JSON.stringify(modulePath)});
    console.log(JSON.stringify({
      dir: mod.getVersionHooksDir(${JSON.stringify(agent)}, ${JSON.stringify(version)}),
      names: mod.listHooksInVersionHome(${JSON.stringify(agent)}, ${JSON.stringify(version)}).map((entry) => entry.name),
    }));
  `;
  const out = execFileSync('bun', ['-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: testHome },
    stdio: ['ignore', 'pipe', 'inherit'],
  }).toString('utf-8');
  return JSON.parse(out);
}

function seedVersionHook(agent: string, version: string, configDir: string, relativeScript: string): string {
  const hooksDir = path.join(userDir, '.history', 'versions', agent, version, 'home', configDir, 'hooks');
  const scriptPath = path.join(hooksDir, relativeScript);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return hooksDir;
}

describe('version hooks path resolution', () => {
  it.each([
    ['grok', '.grok'],
    ['kimi', '.kimi-code'],
  ])('maps absolute %s hooksDir into its version home', (agent, configDir) => {
    const hooksDir = seedVersionHook(agent, '1.0.0', configDir, 'guard.sh');

    const report = runVersionHooksInventory(agent, '1.0.0');

    expect(report.dir).toBe(hooksDir);
    expect(fs.existsSync(report.dir)).toBe(true);
    expect(report.names).toContain('guard');
  });

  it('keeps a relative hooksDir under the version config directory', () => {
    const hooksDir = seedVersionHook('claude', '2.0.0', '.claude', 'guard.sh');

    const report = runVersionHooksInventory('claude', '2.0.0');

    expect(report.dir).toBe(hooksDir);
    expect(report.names).toContain('guard');
  });

  it('lists a hook in a nested event directory from the resolved version root', () => {
    seedVersionHook('grok', '1.0.0', '.grok', 'stop/00-agent-verify-work-complete.sh');

    const report = runVersionHooksInventory('grok', '1.0.0');

    expect(report.names).toContain('00-agent-verify-work-complete');
  });
});

/**
 * Plant a launch binary so listInstalledVersions / iterHooksCapableVersions
 * treat the version as installed (isVersionInstalled probes node_modules/.bin).
 */
function plantClaudeBinary(version: string): void {
  const binDir = path.join(userDir, '.history', 'versions', 'claude', version, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const stub = path.join(binDir, 'claude');
  fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

function plantCodexBinary(version: string): void {
  const binDir = path.join(userDir, '.history', 'versions', 'codex', version, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const stub = path.join(binDir, 'codex');
  fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

/** Seed a system-layer hook manifest + a version-home hooks dir carrying the
 *  hook script, so the inspector resolves a command it expects to be wired. */
function seedClaudeVersionWithHook(version: string, hookName: string, event: string): string {
  plantClaudeBinary(version);
  fs.writeFileSync(
    path.join(systemDir, 'agents.yaml'),
    `hooks:\n  ${hookName}:\n    script: ${hookName}.sh\n    events: [${event}]\n`,
  );
  const home = path.join(userDir, '.history', 'versions', 'claude', version, 'home');
  const hooksDir = path.join(home, '.claude', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, `${hookName}.sh`), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return home;
}

function seedClaudeVersionWithGeneratedShim(version: string, hookName: string, event: string): string {
  plantClaudeBinary(version);
  fs.writeFileSync(
    path.join(systemDir, 'agents.yaml'),
    `hooks:\n  ${hookName}:\n    script: ${hookName}.sh\n    events: [${event}]\n    matcher: Bash\n`,
  );
  const home = path.join(userDir, '.history', 'versions', 'claude', version, 'home');
  const hooksDir = path.join(home, '.claude', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, `${hookName}.sh`), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return home;
}

/** Run checkVersionHookWiring (optionally after registerHooksToSettings) in a
 *  subprocess rooted at testHome, returning its JSON report. */
function runWiring(agent: string, version: string, opts: { register?: boolean } = {}): WiringReport {
  const modulePath = path.resolve(process.cwd(), 'src/lib/hooks/install.ts');
  const versionsPath = path.resolve(process.cwd(), 'src/lib/installations/versions.ts');
  const register = opts.register
    ? `
      const { getVersionHomePath } = await import(${JSON.stringify(versionsPath)});
      const { registerHooksToSettings } = mod;
      const registration = registerHooksToSettings(${JSON.stringify(agent)}, getVersionHomePath(${JSON.stringify(agent)}, ${JSON.stringify(version)}));
      if (registration.errors.length > 0) throw new Error(registration.errors.join('; '));
    `
    : '';
  const script = `
    const mod = await import(${JSON.stringify(modulePath)});
    ${register}
    const r = mod.checkVersionHookWiring(${JSON.stringify(agent)}, ${JSON.stringify(version)});
    console.log(JSON.stringify(r));
  `;
  const out = execFileSync('bun', ['-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: testHome,
      // Keep generated shims inside the planted home — do not inherit the
      // vitest hermetic AGENTS_HOOK_SHIMS_DIR (and never write the user's cache).
      AGENTS_HOOK_SHIMS_DIR: path.join(testHome, 'hook-shims'),
      AGENTS_HOOK_CACHE_DIR: path.join(testHome, 'hook-cache'),
      AGENTS_LOGS_DIR: path.join(testHome, 'logs'),
      AGENTS_PERF_DIR: path.join(testHome, 'perf'),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  }).toString('utf-8');
  return JSON.parse(out);
}

function shimPathInTestHome(hookName: string): string {
  return path.join(testHome, 'hook-shims', `${hookName}.sh`);
}

describe('checkVersionHookWiring', () => {
  it('flags a hook present on disk but absent from settings.json as UNWIRED (the bug)', () => {
    seedClaudeVersionWithHook('2.0.0', 'demo-guard', 'PreToolUse');
    // settings.json exists but does NOT reference the hook — exactly the
    // yosemite-s1 case (file byte-identical to source, never wired).
    const configDir = path.join(userDir, '.history', 'versions', 'claude', '2.0.0', 'home', '.claude');
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ hooks: {} }, null, 2));

    const report = runWiring('claude', '2.0.0');
    expect(report.supported).toBe(true);
    expect(report.settingsMissing).toBeFalsy();
    expect(report.unwired).toHaveLength(1);
    expect(report.unwired[0]).toMatchObject({ name: 'demo-guard', event: 'PreToolUse' });
  });

  it('reports no unwired hooks once the real registrar has wired settings.json', () => {
    seedClaudeVersionWithHook('2.0.0', 'demo-guard', 'PreToolUse');
    // Let registerHooksToSettings (the same call `agents sync` makes) write the
    // wiring, then verify the inspector agrees the hook is wired.
    const report = runWiring('claude', '2.0.0', { register: true });
    expect(report.supported).toBe(true);
    expect(report.unwired).toHaveLength(0);
  });

  it('surfaces a missing settings.json when hooks are declared', () => {
    seedClaudeVersionWithHook('2.0.0', 'demo-guard', 'PreToolUse');
    // No settings.json written at all.
    const report = runWiring('claude', '2.0.0');
    expect(report.supported).toBe(true);
    expect(report.settingsMissing).toBe(true);
    expect(report.expected).toBe(1);
  });

  it('reports unsupported for an agent outside the settings.json family (codex)', () => {
    // codex hooks live in config.toml with a different schema — the inspector
    // must not claim to verify it (no false "wired").
    fs.mkdirSync(path.join(userDir, '.history', 'versions', 'codex', '0.130.0', 'home', '.codex'), { recursive: true });
    const report = runWiring('codex', '0.130.0');
    expect(report.supported).toBe(false);
    expect(report.unwired).toEqual([]);
  });

  it('flags a deleted generated shim without executing the hook', () => {
    seedClaudeVersionWithGeneratedShim('2.0.0', 'runtime-guard', 'PreToolUse');
    const healthy = runWiring('claude', '2.0.0', { register: true });
    expect(healthy.runtimeBroken).toEqual([]);

    const shim = shimPathInTestHome('runtime-guard');
    fs.rmSync(shim);

    const report = runWiring('claude', '2.0.0');
    expect(report.unwired).toEqual([]);
    expect(report.runtimeBroken).toEqual([
      expect.objectContaining({ name: 'runtime-guard', path: shim, reason: 'missing' }),
    ]);
  });

  it.skipIf(process.platform === 'win32')('flags a non-executable generated shim without running it', () => {
    seedClaudeVersionWithGeneratedShim('2.0.0', 'runtime-mode-guard', 'PreToolUse');
    runWiring('claude', '2.0.0', { register: true });
    const shim = shimPathInTestHome('runtime-mode-guard');
    fs.chmodSync(shim, 0o644);

    const report = runWiring('claude', '2.0.0');
    expect(report.runtimeBroken).toEqual([
      expect.objectContaining({ name: 'runtime-mode-guard', path: shim, reason: 'not executable' }),
    ]);
  });
});

// ─── bounded repair (shared self-heal routine) ───────────────────────────────

interface RuntimeRepairReport {
  brokenBefore: Array<{ name: string; shimPath: string; reason: string }>;
  attemptedPaths: string[];
  attempts: Array<{
    name: string;
    path: string;
    reasonBefore: string;
    attempted: boolean;
    repaired: boolean;
    reason?: string;
  }>;
  fixed: string[];
  needsAttention: string[];
}

function runRuntime(scriptBody: string): string {
  const modulePath = path.resolve(process.cwd(), 'src/lib/hooks/install.ts');
  const script = `
    const mod = await import(${JSON.stringify(modulePath)});
    ${scriptBody}
  `;
  return execFileSync('bun', ['-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: testHome,
      AGENTS_HOOK_SHIMS_DIR: path.join(testHome, 'hook-shims'),
      AGENTS_HOOK_CACHE_DIR: path.join(testHome, 'hook-cache'),
      AGENTS_LOGS_DIR: path.join(testHome, 'logs'),
      AGENTS_PERF_DIR: path.join(testHome, 'perf'),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  }).toString('utf-8');
}

describe('removeVersion re-points the global shims', () => {
  it('a shim whose SOURCE was inside the removed version resolves to the survivor afterwards', () => {
    // Two installations share one shim; the default (2.0.0) owns SOURCE.
    seedClaudeVersionWithGeneratedShim('2.0.0', 'runtime-guard', 'PreToolUse');
    seedClaudeVersionWithGeneratedShim('2.1.0', 'runtime-guard', 'PreToolUse');
    const versionsPath = path.resolve(process.cwd(), 'src/lib/installations/versions.ts');
    const out = runRuntime(`
      const fs = await import('node:fs');
      const versions = await import(${JSON.stringify(versionsPath)});
      const first = mod.repairManagedHookRuntimeArtifacts({ filter: { agent: 'claude', version: '2.0.0' } });
      const shim = first.attempts[0]?.path;
      const before = shim ? fs.readFileSync(shim, 'utf-8').match(/^SOURCE='([^']*)'/m)?.[1] : null;
      const removed = versions.removeVersion('claude', '2.0.0');
      const after = shim ? fs.readFileSync(shim, 'utf-8').match(/^SOURCE='([^']*)'/m)?.[1] : null;
      console.log(JSON.stringify({ shim, before, removed, after, afterExists: after ? fs.existsSync(after) : false }));
    `);
    // removeVersion prints its own status lines; the JSON report is the last line.
    const r = JSON.parse(out.trim().split('\n').pop() ?? '{}') as { shim: string | null; before: string | null; removed: boolean; after: string | null; afterExists: boolean };
    expect(r.shim).toBeTruthy();
    expect(r.before).toContain(`${path.sep}2.0.0${path.sep}`);
    expect(r.removed).toBe(true);
    expect(r.after).toContain(`${path.sep}2.1.0${path.sep}`);
    expect(r.afterExists).toBe(true);
  });
});

describe('repairManagedHookRuntimeArtifacts', () => {
  it('healthy shim: second pass is a no-op and preserves mtime', () => {
    seedClaudeVersionWithGeneratedShim('2.0.0', 'runtime-guard', 'PreToolUse');
    const out = runRuntime(`
      const fs = await import('node:fs');
      const first = mod.repairManagedHookRuntimeArtifacts({ filter: { agent: 'claude', version: '2.0.0' } });
      const path = first.attempts[0]?.path;
      if (!path || !fs.existsSync(path)) {
        console.log(JSON.stringify({ error: 'no shim', first }));
        process.exit(0);
      }
      const mtimeBefore = fs.statSync(path).mtimeMs;
      await new Promise((r) => setTimeout(r, 25));
      const second = mod.repairManagedHookRuntimeArtifacts({ filter: { agent: 'claude', version: '2.0.0' } });
      const mtimeAfter = fs.statSync(path).mtimeMs;
      const broken = mod.inspectBrokenManagedHookRuntimeArtifacts({ agent: 'claude', version: '2.0.0' });
      console.log(JSON.stringify({
        firstFixed: first.fixed,
        secondFixed: second.fixed,
        secondAttempts: second.attempts.length,
        brokenCount: broken.length,
        mtimeBefore,
        mtimeAfter,
      }));
    `);
    const r = JSON.parse(out) as {
      error?: string;
      firstFixed: string[];
      secondFixed: string[];
      secondAttempts: number;
      brokenCount: number;
      mtimeBefore: number;
      mtimeAfter: number;
    };
    expect(r.error).toBeUndefined();
    expect(r.firstFixed).toContain('hook shim runtime-guard');
    expect(r.secondFixed).toEqual([]);
    expect(r.secondAttempts).toBe(0);
    expect(r.brokenCount).toBe(0);
    expect(r.mtimeAfter).toBe(r.mtimeBefore);
  });

  it('missing shim: one repair attempt then a no-op pass', () => {
    seedClaudeVersionWithGeneratedShim('2.0.0', 'runtime-guard', 'PreToolUse');
    const out = runRuntime(`
      const fs = await import('node:fs');
      const before = mod.inspectBrokenManagedHookRuntimeArtifacts({ agent: 'claude', version: '2.0.0' });
      const pass1 = mod.repairManagedHookRuntimeArtifacts({ filter: { agent: 'claude', version: '2.0.0' } });
      const mid = mod.inspectBrokenManagedHookRuntimeArtifacts({ agent: 'claude', version: '2.0.0' });
      const pass2 = mod.repairManagedHookRuntimeArtifacts({ filter: { agent: 'claude', version: '2.0.0' } });
      const shimPath = pass1.attempts[0]?.path;
      console.log(JSON.stringify({
        beforeReasons: before.map((b) => b.reason),
        pass1,
        midCount: mid.length,
        pass2,
        shimExists: shimPath ? fs.existsSync(shimPath) : false,
      }));
    `);
    const r = JSON.parse(out) as {
      beforeReasons: string[];
      pass1: RuntimeRepairReport;
      midCount: number;
      pass2: RuntimeRepairReport;
      shimExists: boolean;
    };
    expect(r.beforeReasons).toContain('missing');
    expect(r.pass1.attempts).toHaveLength(1);
    expect(r.pass1.attempts[0].attempted).toBe(true);
    expect(r.pass1.attempts[0].repaired).toBe(true);
    expect(r.pass1.fixed).toEqual(['hook shim runtime-guard']);
    expect(r.pass1.needsAttention).toEqual([]);
    expect(r.pass1.attemptedPaths).toHaveLength(1);
    expect(r.midCount).toBe(0);
    expect(r.shimExists).toBe(true);
    expect(r.pass2.attempts).toEqual([]);
    expect(r.pass2.fixed).toEqual([]);
  });

  it('failed write: attempts generation once and surfaces stable needsAttention', () => {
    seedClaudeVersionWithGeneratedShim('2.0.0', 'runtime-guard', 'PreToolUse');
    const out = runRuntime(`
      const fs = await import('node:fs');
      // A directory at the destination forces the atomic temp-file rename to
      // fail. The emitted finding must not leak that temp path or its UUID.
      const shim = process.env.AGENTS_HOOK_SHIMS_DIR + '/runtime-guard.sh';
      fs.mkdirSync(shim, { recursive: true });
      const pass1 = mod.repairManagedHookRuntimeArtifacts({ filter: { agent: 'claude', version: '2.0.0' } });
      const pass2 = mod.repairManagedHookRuntimeArtifacts({ filter: { agent: 'claude', version: '2.0.0' } });
      console.log(JSON.stringify({ pass1, pass2 }));
    `);
    const r = JSON.parse(out) as { pass1: RuntimeRepairReport; pass2: RuntimeRepairReport };
    expect(r.pass1.attempts).toHaveLength(1);
    expect(r.pass1.attempts[0].attempted).toBe(true);
    expect(r.pass1.attempts[0].repaired).toBe(false);
    expect(r.pass1.fixed).toEqual([]);
    expect(r.pass1.needsAttention).toHaveLength(1);
    // errno differs by platform (EISDIR / EPERM / EEXIST); never bake one in.
    // Must stay free of absolute paths and randomized temp UUIDs.
    expect(r.pass1.needsAttention[0]).toMatch(
      /^hook shim runtime-guard: repair failed \[[A-Z0-9_]+\]: .+$/,
    );
    expect(r.pass1.needsAttention[0]).not.toMatch(/[/\\]Users[/\\]|[/\\]tmp[/\\]|\.tmp|[0-9a-f]{8}-[0-9a-f]{4}/i);
    // Independent second pass: identical needsAttention (stable for fleet aggregation).
    expect(r.pass2.attempts).toHaveLength(1);
    expect(r.pass2.attemptedPaths).toHaveLength(1);
    expect(r.pass2.needsAttention).toEqual(r.pass1.needsAttention);
  });

  it('selects one canonical repair target when multiple versions share a path', () => {
    seedClaudeVersionWithGeneratedShim('2.0.0', 'runtime-guard', 'PreToolUse');
    seedClaudeVersionWithGeneratedShim('2.1.0', 'runtime-guard', 'PreToolUse');
    const out = runRuntime(`
      const before = mod.inspectBrokenManagedHookRuntimeArtifacts({ agent: 'claude' });
      const pass = mod.repairManagedHookRuntimeArtifacts({ filter: { agent: 'claude' } });
      console.log(JSON.stringify({
        brokenCount: before.length,
        uniquePaths: [...new Set(before.map((b) => b.shimPath))].length,
        attemptedPaths: pass.attemptedPaths.length,
        attempts: pass.attempts.length,
        fixed: pass.fixed,
      }));
    `);
    const r = JSON.parse(out) as {
      brokenCount: number;
      uniquePaths: number;
      attemptedPaths: number;
      attempts: number;
      fixed: string[];
    };
    expect(r.brokenCount).toBe(1);
    expect(r.uniquePaths).toBe(1);
    expect(r.attemptedPaths).toBe(1);
    expect(r.attempts).toBe(1);
    expect(r.fixed).toEqual(['hook shim runtime-guard']);
  });

  it('picks the global-default version source when multiple versions share a shim path', () => {
    // Older version first alphabetically so a naive sort would pick 1.0.0.
    seedClaudeVersionWithGeneratedShim('1.0.0', 'runtime-guard', 'PreToolUse');
    seedClaudeVersionWithGeneratedShim('2.0.0', 'runtime-guard', 'PreToolUse');
    // Distinct script contents so the embedded SOURCE is observable.
    const v1 = path.join(userDir, '.history', 'versions', 'claude', '1.0.0', 'home', '.claude', 'hooks', 'runtime-guard.sh');
    const v2 = path.join(userDir, '.history', 'versions', 'claude', '2.0.0', 'home', '.claude', 'hooks', 'runtime-guard.sh');
    fs.writeFileSync(v1, '#!/bin/sh\necho OLD\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(v2, '#!/bin/sh\necho NEW\nexit 0\n', { mode: 0o755 });
    // agents.yaml already pins claude: "2.0.0" from beforeEach.
    const out = runRuntime(`
      const fs = await import('node:fs');
      const pass = mod.repairManagedHookRuntimeArtifacts({ filter: { agent: 'claude' } });
      const shimPath = pass.attempts[0]?.path;
      const body = shimPath && fs.existsSync(shimPath) ? fs.readFileSync(shimPath, 'utf-8') : '';
      console.log(JSON.stringify({
        fixed: pass.fixed,
        attempts: pass.attempts.length,
        body,
        defaultScript: ${JSON.stringify(v2)},
        oldScript: ${JSON.stringify(v1)},
      }));
    `);
    const r = JSON.parse(out) as {
      fixed: string[];
      attempts: number;
      body: string;
      defaultScript: string;
      oldScript: string;
    };
    expect(r.attempts).toBe(1);
    expect(r.fixed).toEqual(['hook shim runtime-guard']);
    // SOURCE embeds the default version's script, not the older 1.0.0 copy.
    expect(r.body).toContain(r.defaultScript);
    expect(r.body).not.toContain(r.oldScript);
  });

  it('uses the global canonical owner when another harness checks the same shim', () => {
    const claudeHome = seedClaudeVersionWithGeneratedShim('2.0.0', 'runtime-guard', 'PreToolUse');
    const claudeScript = path.join(claudeHome, '.claude', 'hooks', 'runtime-guard.sh');
    fs.writeFileSync(claudeScript, '#!/bin/sh\necho CLAUDE\n', { mode: 0o755 });

    plantCodexBinary('0.130.0');
    const codexScript = path.join(
      userDir,
      '.history',
      'versions',
      'codex',
      '0.130.0',
      'home',
      '.codex',
      'hooks',
      'runtime-guard.sh',
    );
    fs.mkdirSync(path.dirname(codexScript), { recursive: true });
    fs.writeFileSync(codexScript, '#!/bin/sh\necho CODEX\n', { mode: 0o755 });

    const out = runRuntime(`
      const fs = await import('node:fs');
      const repair = mod.repairManagedHookRuntimeArtifacts();
      const claude = mod.checkVersionHookWiring('claude', '2.0.0');
      const codex = mod.checkVersionHookWiring('codex', '0.130.0');
      const shim = process.env.AGENTS_HOOK_SHIMS_DIR + '/runtime-guard.sh';
      console.log(JSON.stringify({
        repair,
        claude,
        codex,
        body: fs.readFileSync(shim, 'utf8'),
        claudeScript: ${JSON.stringify(claudeScript)},
        codexScript: ${JSON.stringify(codexScript)},
      }));
    `);
    const r = JSON.parse(out) as {
      repair: RuntimeRepairReport;
      claude: WiringReport;
      codex: WiringReport;
      body: string;
      claudeScript: string;
      codexScript: string;
    };

    expect(r.repair.fixed).toEqual(['hook shim runtime-guard']);
    expect(r.claude.runtimeBroken).toEqual([]);
    expect(r.codex.runtimeBroken).toEqual([]);
    expect(r.body).toContain(`SOURCE='${r.claudeScript}'`);
    expect(r.body).not.toContain(r.codexScript);
  });

  it('does not report a shared shim for an isolated requested version', () => {
    seedClaudeVersionWithGeneratedShim('2.0.0', 'runtime-guard', 'PreToolUse');
    seedClaudeVersionWithGeneratedShim('3.0.0', 'runtime-guard', 'PreToolUse');
    fs.writeFileSync(path.join(userDir, '.history', 'versions', 'claude', '3.0.0', '.isolated'), 'test\n');

    const out = runRuntime(`
      const global = mod.inspectBrokenManagedHookRuntimeArtifacts();
      const inspected = mod.inspectBrokenManagedHookRuntimeArtifacts({ agent: 'claude', version: '3.0.0' });
      const wiring = mod.checkVersionHookWiring('claude', '3.0.0');
      console.log(JSON.stringify({ global, inspected, wiring }));
    `);
    const r = JSON.parse(out) as {
      global: Array<{ reason: string }>;
      inspected: unknown[];
      wiring: WiringReport;
    };

    expect(r.global.map((artifact) => artifact.reason)).toEqual(['missing']);
    expect(r.inspected).toEqual([]);
    expect(r.wiring.runtimeBroken).toEqual([]);
  });

  it('does not report a shared shim for a hooks-incompatible requested version', () => {
    seedClaudeVersionWithGeneratedShim('2.0.0', 'runtime-guard', 'PreToolUse');
    plantCodexBinary('0.115.0');
    const codexScript = path.join(
      userDir,
      '.history',
      'versions',
      'codex',
      '0.115.0',
      'home',
      '.codex',
      'hooks',
      'runtime-guard.sh',
    );
    fs.mkdirSync(path.dirname(codexScript), { recursive: true });
    fs.writeFileSync(codexScript, '#!/bin/sh\necho CODEX\n', { mode: 0o755 });

    const out = runRuntime(`
      const global = mod.inspectBrokenManagedHookRuntimeArtifacts();
      const inspected = mod.inspectBrokenManagedHookRuntimeArtifacts({ agent: 'codex', version: '0.115.0' });
      const wiring = mod.checkVersionHookWiring('codex', '0.115.0');
      console.log(JSON.stringify({ global, inspected, wiring }));
    `);
    const r = JSON.parse(out) as {
      global: Array<{ reason: string }>;
      inspected: unknown[];
      wiring: WiringReport;
    };

    expect(r.global.map((artifact) => artifact.reason)).toEqual(['missing']);
    expect(r.inspected).toEqual([]);
    expect(r.wiring.runtimeBroken).toEqual([]);
  });

  it('rewrites an executable wrapper whose SOURCE points to a removed old version', () => {
    seedClaudeVersionWithGeneratedShim('1.0.0', 'runtime-guard', 'PreToolUse');
    seedClaudeVersionWithGeneratedShim('2.0.0', 'runtime-guard', 'PreToolUse');
    const oldScript = path.join(userDir, '.history', 'versions', 'claude', '1.0.0', 'home', '.claude', 'hooks', 'runtime-guard.sh');
    const defaultScript = path.join(userDir, '.history', 'versions', 'claude', '2.0.0', 'home', '.claude', 'hooks', 'runtime-guard.sh');
    fs.rmSync(oldScript);

    const staleShim = `#!/bin/sh\nSOURCE='${oldScript}'\n`;
    const out = runRuntime(`
      const fs = await import('node:fs');
      const shim = process.env.AGENTS_HOOK_SHIMS_DIR + '/runtime-guard.sh';
      fs.mkdirSync(process.env.AGENTS_HOOK_SHIMS_DIR!, { recursive: true });
      fs.writeFileSync(shim, ${JSON.stringify(staleShim)}, { mode: 0o755 });
      const before = mod.inspectBrokenManagedHookRuntimeArtifacts({ agent: 'claude', version: '2.0.0' });
      const repair = mod.repairManagedHookRuntimeArtifacts({ filter: { agent: 'claude' } });
      console.log(JSON.stringify({
        before: before.map((entry) => entry.reason),
        repair,
        body: fs.readFileSync(shim, 'utf8'),
      }));
    `);
    const r = JSON.parse(out) as { before: string[]; repair: RuntimeRepairReport; body: string };

    expect(r.before).toEqual(['source mismatch']);
    expect(r.repair.fixed).toEqual(['hook shim runtime-guard']);
    expect(r.body).toContain(`# Source: ${defaultScript}`);
    expect(r.body).toContain(`SOURCE='${defaultScript}'`);
    expect(r.body).not.toContain(oldScript);
  });

  it('does not select isolated or hooks-incompatible homes as global shim owners', () => {
    seedClaudeVersionWithGeneratedShim('3.0.0', 'runtime-guard', 'PreToolUse');
    fs.writeFileSync(path.join(userDir, '.history', 'versions', 'claude', '3.0.0', '.isolated'), 'test\n');

    const codexHooks = path.join(userDir, '.history', 'versions', 'codex', '0.115.0', 'home', '.codex', 'hooks');
    fs.mkdirSync(codexHooks, { recursive: true });
    fs.writeFileSync(path.join(codexHooks, 'runtime-guard.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const out = runRuntime(`
      const isolated = mod.repairManagedHookRuntimeArtifacts({ filter: { agent: 'claude' } });
      const tooOld = mod.repairManagedHookRuntimeArtifacts({ filter: { agent: 'codex', version: '0.115.0' } });
      console.log(JSON.stringify({ isolated, tooOld }));
    `);
    const r = JSON.parse(out) as { isolated: RuntimeRepairReport; tooOld: RuntimeRepairReport };

    expect(r.isolated.attempts).toEqual([]);
    expect(r.tooOld.attempts).toEqual([]);
  });
});

describe('installSessionTrackerHookSync — failure reasons are never empty', () => {
  it('returns installed:false with a NON-EMPTY error when the hook cannot be installed', async () => {
    const { installSessionTrackerHookSync } = await import('./install.js');
    // antigravity passes the CLI-side supports(agent,'hooks') gate, but the
    // session-tracker child declines it (no SessionStart hook event) and prints
    // the reason to STDOUT. Pre-fix, err.stderr was an empty-but-truthy Buffer,
    // so the surfaced error was '' — the regression this pins. In an environment
    // where the package is unbuilt and tsx is absent, the static not-built
    // message satisfies the same non-empty contract.
    const res = installSessionTrackerHookSync('antigravity');
    expect(res.installed).toBe(false);
    expect((res.error ?? '').trim().length).toBeGreaterThan(0);
  });
});

// ─── listUnmanagedHooksInVersionHome — orphan = absent from SOURCE (PHNX-2693) ──
//
// The bug: orphan detection diffed installed hook names against the REGISTERED
// hook manifest, not the source file set. Sync copies helper / test / benchmark
// scripts into every version home alongside registered hooks but never registers
// them, so each read as an orphan — `agents prune cleanup` offered to trash ~1000
// in-use files. The fix diffs against the resolved source set (user + system +
// extras), so a source-present file is never an orphan and a genuinely dead one
// still is.

/** Write a hook script into a source root's hooks dir (user or system). */
function seedSourceHook(root: string, relative: string): void {
  const scriptPath = path.join(root, 'hooks', relative);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

/** Write a file into a claude version home's hooks dir. */
function seedHomeHookFile(version: string, relative: string): void {
  const hooksDir = path.join(userDir, '.history', 'versions', 'claude', version, 'home', '.claude', 'hooks');
  const p = path.join(hooksDir, relative);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

function runUnmanagedHooks(agent: string, version: string): string[] {
  const modulePath = path.resolve(process.cwd(), 'src/lib/hooks/install.ts');
  const script = `
    const mod = await import(${JSON.stringify(modulePath)});
    console.log(JSON.stringify(mod.listUnmanagedHooksInVersionHome(${JSON.stringify(agent)}, ${JSON.stringify(version)})));
  `;
  const out = execFileSync('bun', ['-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: testHome },
    stdio: ['ignore', 'pipe', 'inherit'],
  }).toString('utf-8');
  return JSON.parse(out);
}

describe('listUnmanagedHooksInVersionHome — source-based orphan detection', () => {
  it('does NOT flag source-present helper/test/benchmark scripts, but DOES flag a genuine orphan', () => {
    // Source set: one registered hook plus the helper/test/benchmark scripts sync
    // copies alongside it. Only `git-guard` is in the manifest; the rest are not.
    fs.writeFileSync(
      path.join(systemDir, 'agents.yaml'),
      'hooks:\n  git-guard:\n    script: git-guard.sh\n    events: [PreToolUse]\n',
    );
    for (const f of [
      'git-guard.sh',            // registered + source
      'permission-handler.sh',   // source-present helper, unregistered
      'verify-work-state.py',    // source-present helper, unregistered
      'run_tests.sh',            // source-present test, unregistered
      'benchmark_x.py',          // source-present benchmark, unregistered
    ]) {
      seedSourceHook(systemDir, f);
    }

    // Version home carries every source file (sync copies them) plus one file
    // that exists in NO source root — the only genuine orphan.
    for (const f of [
      'git-guard.sh',
      'permission-handler.sh',
      'verify-work-state.py',
      'run_tests.sh',
      'benchmark_x.py',
      'dead-hook.sh',            // absent from every source → orphan
    ]) {
      seedHomeHookFile('2.0.0', f);
    }

    const orphans = runUnmanagedHooks('claude', '2.0.0');
    // Pre-fix (manifest-based) this returned permission-handler, verify-work-state,
    // run_tests, benchmark_x AND dead-hook. Now only the true orphan remains.
    expect(orphans).toEqual(['dead-hook']);
  });

  it('flags a home file once its source is removed (no over-suppression)', () => {
    // Same helper present in source and home → not an orphan.
    seedSourceHook(userDir, 'permission-handler.sh');
    seedHomeHookFile('2.0.0', 'permission-handler.sh');
    expect(runUnmanagedHooks('claude', '2.0.0')).toEqual([]);

    // Remove it from source only: the home copy is now genuinely orphaned.
    fs.rmSync(path.join(userDir, 'hooks', 'permission-handler.sh'));
    expect(runUnmanagedHooks('claude', '2.0.0')).toEqual(['permission-handler']);
  });

  it('resolves a source hook nested in an event-group subdir', () => {
    // Sync materializes event-group hooks (hooks/<event>/<script>) flat into the
    // home; the source resolver descends one level, so they are not orphans.
    seedSourceHook(systemDir, 'stop/00-agent-verify-work-complete.sh');
    seedHomeHookFile('2.0.0', '00-agent-verify-work-complete.sh');
    expect(runUnmanagedHooks('claude', '2.0.0')).toEqual([]);
  });
});
