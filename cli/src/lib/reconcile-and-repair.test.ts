/** Superset proof: `repairAfterSync` (run at the tail of every `agents sync`) repairs a broken
 * managed hook runtime shim that `syncResourcesToVersion` never touches, the class `doctor --fix`
 * handled. Subprocess with HOME=testHome since state.ts captures HOME at load. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let testHome: string;
let userDir: string;
let systemDir: string;

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-repair-test-'));
  userDir = path.join(testHome, '.agents');
  systemDir = path.join(userDir, '.system');
  fs.mkdirSync(systemDir, { recursive: true });
  // A concrete agents.yaml keeps the migrator from firing on missing legacy state.
  fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'agents:\n  claude: "2.0.0"\n');
});

afterEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

/** Seed a claude version with a managed hook whose generated runtime shim does NOT yet exist (the
 * "shim source mismatch" the yosemite-s1 CRITICALs flagged); mirrors
 * seedClaudeVersionWithGeneratedShim in hooks/install.test.ts. */
function seedClaudeVersionWithManagedHook(version: string, hookName: string, event: string): void {
  // Binary stub so listInstalledVersions / isVersionInstalled see the version.
  const binDir = path.join(userDir, '.history', 'versions', 'claude', version, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // System-layer hook manifest.
  fs.writeFileSync(
    path.join(systemDir, 'agents.yaml'),
    `hooks:\n  ${hookName}:\n    script: ${hookName}.sh\n    events: [${event}]\n    matcher: Bash\n`,
  );
  // Hook SCRIPT present in the version home (this is all syncResourcesToVersion
  // copies — it never generates the runtime shim below).
  const hooksDir = path.join(userDir, '.history', 'versions', 'claude', version, 'home', '.claude', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, `${hookName}.sh`), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

interface RepairProbe {
  beforeReasons: string[];
  beforeShimExists: boolean;
  hookRewire: Array<{ agent: string; version: string; rewired: number; remaining: number; failure?: string }>;
  runtimeFixed: string[];
  needsAttention: string[];
  changed: boolean;
  hadFailures: boolean;
  afterBrokenCount: number;
  afterShimExists: boolean;
}

function runRepairAfterSync(): RepairProbe {
  const repairPath = path.resolve(process.cwd(), 'src/lib/reconcile-and-repair.ts');
  const hooksPath = path.resolve(process.cwd(), 'src/lib/hooks/install.ts');
  const script = `
    const fs = await import('node:fs');
    const mod = await import(${JSON.stringify(repairPath)});
    const hooks = await import(${JSON.stringify(hooksPath)});
    const shim = process.env.AGENTS_HOOK_SHIMS_DIR + '/runtime-guard.sh';
    const before = hooks.inspectBrokenManagedHookRuntimeArtifacts({ agent: 'claude', version: '2.0.0' });
    const beforeShimExists = fs.existsSync(shim);
    const report = await mod.repairAfterSync({ agent: 'claude', versions: ['2.0.0'] });
    const after = hooks.inspectBrokenManagedHookRuntimeArtifacts({ agent: 'claude', version: '2.0.0' });
    console.log(JSON.stringify({
      beforeReasons: before.map((b) => b.reason),
      beforeShimExists,
      hookRewire: report.hookRewire,
      runtimeFixed: report.hookRuntimeRepair.fixed,
      needsAttention: report.hookRuntimeRepair.needsAttention,
      changed: mod.repairChangedAnything(report),
      hadFailures: mod.repairHadFailures(report),
      afterBrokenCount: after.length,
      afterShimExists: fs.existsSync(shim),
    }));
  `;
  const out = execFileSync('bun', ['-e', script], {
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
  return JSON.parse(out);
}

describe('repairAfterSync (the pass agents sync runs) is a superset of the old doctor --fix', () => {
  it('repairs a managed hook runtime shim that syncResourcesToVersion never generates', () => {
    seedClaudeVersionWithManagedHook('2.0.0', 'runtime-guard', 'PreToolUse');

    const probe = runRepairAfterSync();

    // Precondition: the generated runtime shim did NOT exist and was flagged
    // broken — exactly the class of finding sync's own file-copy leaves untouched
    // (syncResourcesToVersion copies the hook script, never the runtime shim).
    expect(probe.beforeShimExists).toBe(false);
    expect(probe.beforeReasons).toContain('missing');

    // The repair pass fixed it and reported honestly (no phantom needs-attention).
    expect(probe.changed).toBe(true);
    expect(probe.hadFailures).toBe(false);
    expect(probe.needsAttention).toEqual([]);
    // The hook is now wired into settings.json (the rewire step) — proof the
    // repair reached the wiring, not just the file copy.
    expect(probe.hookRewire).toEqual([
      { agent: 'claude', version: '2.0.0', rewired: 1, remaining: 0 },
    ]);

    // End state: the shim now exists and no broken managed shims remain.
    expect(probe.afterShimExists).toBe(true);
    expect(probe.afterBrokenCount).toBe(0);
  });
});


describe('repairAfterSync stale-CLI purge — explicit + sandboxed (never automatic, never real paths)', () => {
  it('does NOT purge by default, purges only with pruneClis, and only within injected sandbox paths', () => {
    // A fake sandbox holding a removable pre-fixed agents-cli copy + a fixed peer.
    const sandbox = path.join(testHome, 'sandbox');
    const globalDir = path.join(sandbox, 'global');           // injected globalNodeModulesDirs entry
    const staleRoot = path.join(globalDir, '@phnx-labs', 'agents-cli');
    fs.mkdirSync(path.join(staleRoot, 'dist', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(staleRoot, 'package.json'),
      JSON.stringify({ name: '@phnx-labs/agents-cli', version: '1.20.42' }),
    );
    // The unsafe-legacy-helper marker makes this copy auto-purgeable.
    fs.writeFileSync(path.join(staleRoot, 'dist', 'lib', 'app-bundle-install.js'), '// marker\n');
    // A fixed (>=1.22.30) running peer, so the anti-stranding guard allows the purge.
    const runningRoot = path.join(sandbox, 'running');
    fs.mkdirSync(runningRoot, { recursive: true });
    fs.writeFileSync(
      path.join(runningRoot, 'package.json'),
      JSON.stringify({ name: '@phnx-labs/agents-cli', version: '1.99.0' }),
    );
    // Injected homeDir/npm/fnm so the home-based scans also stay inside the sandbox.
    const sandboxHome = path.join(sandbox, 'home');
    fs.mkdirSync(sandboxHome, { recursive: true });
    // Canonical paths captured BEFORE the purge deletes the stale copy.
    const staleRootReal = fs.realpathSync(staleRoot);
    const sandboxReal = fs.realpathSync(sandbox);

    const repairPath = path.resolve(process.cwd(), 'src/lib/reconcile-and-repair.ts');
    const injection = {
      runningRoot,
      runningVersion: '1.99.0',
      pathEnv: '',  // no PATH scan → never resolves a real `agents` entrypoint
      findOpts: {
        homeDir: sandboxHome,
        fnmDir: path.join(sandbox, 'fnm'),
        npmCacheDir: path.join(sandbox, 'npm'),
        globalNodeModulesDirs: [globalDir],
      },
    };
    const script = `
      const fs = await import('node:fs');
      const mod = await import(${json(repairPath)});
      const noPurge = await mod.repairAfterSync({});                         // default umbrella: no purge
      const optInNoPrune = await mod.repairAfterSync({ pruneClis: true, agent: 'claude' }); // agent-scoped: no purge even with pruneClis
      const pruned = await mod.repairAfterSync({ pruneClis: true, purgeInjection: ${json(injection)} });
      console.log(JSON.stringify({
        defaultPurgeNull: noPurge.staleInstallPurge === null,
        scopedPurgeNull: optInNoPrune.staleInstallPurge === null,
        purgeRan: pruned.staleInstallPurge !== null,
        removed: (pruned.staleInstallPurge && pruned.staleInstallPurge.removed || []).map((r) => r.packageRoot),
        allRoots: [].concat(
          (pruned.staleInstallPurge && pruned.staleInstallPurge.inventory || []).map((i) => i.packageRoot),
          (pruned.staleInstallPurge && pruned.staleInstallPurge.candidates || []).map((c) => c.packageRoot),
          (pruned.staleInstallPurge && pruned.staleInstallPurge.failed || []).map((f) => f.packageRoot),
        ),
        staleStillExists: fs.existsSync(${json(staleRoot)}),
      }));
    `;
    const out = execFileSync('bun', ['-e', script], {
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
    const r = JSON.parse(out) as {
      defaultPurgeNull: boolean;
      scopedPurgeNull: boolean;
      purgeRan: boolean;
      removed: string[];
      allRoots: string[];
      staleStillExists: boolean;
    };

    // 1. A routine sync NEVER purges — default umbrella and agent-scoped both null.
    expect(r.defaultPurgeNull).toBe(true);
    expect(r.scopedPurgeNull).toBe(true);
    // 2. With --prune-clis (pruneClis:true, no agent) the purge runs…
    expect(r.purgeRan).toBe(true);
    // …deletes the seeded removable copy…
    expect(r.staleStillExists).toBe(false);
    expect(r.removed).toContain(staleRootReal);
    // 3. …and touched ONLY sandbox paths — nothing outside the temp HOME.
    expect(r.allRoots.length).toBeGreaterThan(0);
    for (const root of r.allRoots) {
      expect(root.startsWith(sandboxReal), `leaked real path: ${root}`).toBe(true);
    }
  });
});

function json(v: unknown): string { return JSON.stringify(v); }

